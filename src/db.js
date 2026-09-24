import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { normaliseTrendWindow, summarizeHealthTrend } from './trend.js';
import { buildDailyHealthSummary, shanghaiDayRange } from './daily-summary.js';
import { findReworkIssues } from './rework.js';

let database;

export function db() {
  if (!database) {
    fs.mkdirSync(path.dirname(config.dataPath), { recursive: true });
    const isNewStore = !fs.existsSync(config.dataPath);
    database = new DatabaseSync(config.dataPath);
    database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;');
    // Switching journal mode takes an exclusive lock. Do it only while a new
    // serving store is created; collectors otherwise share the established
    // WAL database and wait for short writes instead of failing immediately.
    if (isNewStore) database.exec('PRAGMA journal_mode = WAL;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        error TEXT,
        summary_json TEXT
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT,
        updated_at TEXT,
        raw_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        model TEXT,
        runtime_mode TEXT,
        skill_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        raw_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        has_draft INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        published_snapshot_version_number INTEGER,
        updated_at TEXT,
        raw_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_audits (
        skill_id TEXT PRIMARY KEY,
        source_updated_at TEXT,
        audit_json TEXT NOT NULL,
        audited_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS darwin_review_plans (
        skill_id TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multica_architecture_review_issues (
        issue_id TEXT PRIMARY KEY,
        issue_identifier TEXT,
        batch_id TEXT NOT NULL,
        issue_url TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multica_architecture_review_issue_skills (
        issue_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        source_updated_at TEXT,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, skill_id),
        FOREIGN KEY (issue_id) REFERENCES multica_architecture_review_issues(issue_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_multica_architecture_review_issue_skills_skill ON multica_architecture_review_issue_skills(skill_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        identifier TEXT,
        title TEXT,
        status TEXT,
        priority TEXT,
        assignee_id TEXT,
        assignee_type TEXT,
        created_at TEXT,
        updated_at TEXT,
        metadata_json TEXT,
        raw_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issue_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        status TEXT NOT NULL,
        issue_updated_at TEXT,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_issue_status_events_observed_at ON issue_status_events(observed_at);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT,
        agent_id TEXT,
        status TEXT,
        attempt INTEGER,
        max_attempts INTEGER,
        error TEXT,
        heartbeat_stage TEXT,
        heartbeat_summary TEXT,
        created_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        last_heartbeat_at TEXT,
        result_json TEXT,
        raw_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_messages (
        run_id TEXT PRIMARY KEY,
        issue_id TEXT,
        raw_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_name TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER,
        detail TEXT,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      -- The current dashboard state is singleton data: every page reads this
      -- one row rather than parsing a historical full-snapshot series.
      CREATE TABLE IF NOT EXISTS current_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        collected_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      -- Trend history deliberately stores only the metrics charted by the UI.
      -- It is independent from the complete snapshot payload.
      CREATE TABLE IF NOT EXISTS health_trend_points (
        collected_at TEXT PRIMARY KEY,
        score INTEGER NOT NULL,
        blocked_issues INTEGER NOT NULL,
        warning_count INTEGER NOT NULL,
        critical_count INTEGER NOT NULL,
        active_issues INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_health_trend_points_collected_at ON health_trend_points(collected_at);
    `);
    bootstrapLiveStoreFromLegacy(database);
  }
  return database;
}

function bootstrapLiveStoreFromLegacy(target) {
  if (config.dataPath === config.legacyDataPath || target.prepare('SELECT COUNT(*) AS count FROM current_snapshot').get().count) return;
  if (!fs.existsSync(config.legacyDataPath)) return;
  let source;
  try {
    source = new DatabaseSync(config.legacyDataPath, { readOnly: true });
    const snapshot = source.prepare('SELECT collected_at, payload_json FROM current_snapshot WHERE id = 1').get()
      ?? source.prepare('SELECT collected_at, payload_json FROM snapshots ORDER BY id DESC LIMIT 1').get();
    if (snapshot) target.prepare('INSERT INTO current_snapshot (id, collected_at, payload_json) VALUES (1, ?, ?)').run(snapshot.collected_at, snapshot.payload_json);
    const trend = source.prepare(`SELECT collected_at, score, blocked_issues, warning_count, critical_count, active_issues
      FROM health_trend_points WHERE collected_at >= datetime('now', '-7 days') ORDER BY collected_at`).all();
    const insertTrend = target.prepare(`INSERT OR IGNORE INTO health_trend_points
      (collected_at, score, blocked_issues, warning_count, critical_count, active_issues) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const point of trend) insertTrend.run(point.collected_at, point.score, point.blocked_issues, point.warning_count, point.critical_count, point.active_issues);
    const plans = source.prepare('SELECT skill_id, plan_json, updated_at FROM darwin_review_plans').all();
    const insertPlan = target.prepare('INSERT OR REPLACE INTO darwin_review_plans (skill_id, plan_json, updated_at) VALUES (?, ?, ?)');
    for (const plan of plans) insertPlan.run(plan.skill_id, plan.plan_json, plan.updated_at);
  } catch (error) {
    // A serving database must remain usable even when the immutable archive is
    // unavailable. The next collector run will seed a fresh current snapshot.
    console.error(`legacy snapshot bootstrap skipped: ${error.message}`);
  } finally {
    source?.close();
  }
}

const json = (value) => JSON.stringify(value ?? null);
const nullable = (value) => value === undefined ? null : value;
const execute = (statement, ...values) => statement.run(...values.map(nullable));

export function beginCollection(startedAt) {
  const connection = db();
  const result = connection.prepare('INSERT INTO collections (started_at, status) VALUES (?, ?)').run(startedAt, 'running');
  return Number(result.lastInsertRowid);
}

export function finishCollection(id, { finishedAt, status, error = null, summary = null }) {
  db().prepare('UPDATE collections SET finished_at = ?, status = ?, error = ?, summary_json = ? WHERE id = ?')
    .run(finishedAt, status, error, json(summary), id);
}

export function saveSource(source, collectedAt) {
  const connection = db();
  connection.exec('BEGIN IMMEDIATE');
  try {
    const workspace = source.workspace;
    const workspaceStatement = connection.prepare(`INSERT INTO workspaces (id, name, slug, updated_at, raw_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug,
      updated_at=excluded.updated_at, raw_json=excluded.raw_json, collected_at=excluded.collected_at`)
    execute(workspaceStatement, workspace.id, workspace.name, workspace.slug, workspace.updated_at, json(workspace), collectedAt);

    const agentStatement = connection.prepare(`INSERT INTO agents (id, name, status, model, runtime_mode, skill_count, updated_at, raw_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status,
      model=excluded.model, runtime_mode=excluded.runtime_mode, skill_count=excluded.skill_count, updated_at=excluded.updated_at,
      raw_json=excluded.raw_json, collected_at=excluded.collected_at`);
    for (const agent of source.agents) {
      execute(agentStatement, agent.id, agent.name, agent.status, agent.model, agent.runtime_mode, agent.skills?.length ?? 0, agent.updated_at, json(agent), collectedAt);
    }

    const skillStatement = connection.prepare(`INSERT INTO skills (id, name, description, has_draft, published_at, published_snapshot_version_number, updated_at, raw_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
      has_draft=excluded.has_draft, published_at=excluded.published_at,
      published_snapshot_version_number=excluded.published_snapshot_version_number, updated_at=excluded.updated_at,
      raw_json=excluded.raw_json, collected_at=excluded.collected_at`);
    for (const skill of source.skills) {
      execute(skillStatement, skill.id, skill.name, skill.description, skill.has_draft ? 1 : 0, skill.published_at, skill.published_snapshot_version_number, skill.updated_at, json(skill), collectedAt);
    }

    const existingIssueStatus = connection.prepare('SELECT status FROM issues WHERE id = ?');
    const issueStatusEvent = connection.prepare(`INSERT INTO issue_status_events (issue_id, previous_status, status, issue_updated_at, observed_at)
      VALUES (?, ?, ?, ?, ?)`);
    const issueStatement = connection.prepare(`INSERT INTO issues (id, identifier, title, status, priority, assignee_id, assignee_type, created_at, updated_at, metadata_json, raw_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET identifier=excluded.identifier, title=excluded.title,
      status=excluded.status, priority=excluded.priority, assignee_id=excluded.assignee_id, assignee_type=excluded.assignee_type,
      updated_at=excluded.updated_at, metadata_json=excluded.metadata_json, raw_json=excluded.raw_json, collected_at=excluded.collected_at`);
    for (const issue of source.issues) {
      const previous = existingIssueStatus.get(issue.id);
      execute(issueStatement, issue.id, issue.identifier, issue.title, issue.status, issue.priority, issue.assignee_id, issue.assignee_type,
        issue.created_at, issue.updated_at, json(issue.metadata), json(issue), collectedAt);
      if (previous?.status && previous.status !== issue.status) {
        execute(issueStatusEvent, issue.id, previous.status, issue.status, issue.updated_at, collectedAt);
      }
    }

    const runStatement = connection.prepare(`INSERT INTO runs (id, issue_id, agent_id, status, attempt, max_attempts, error, heartbeat_stage, heartbeat_summary, created_at, started_at, completed_at, last_heartbeat_at, result_json, raw_json, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
      attempt=excluded.attempt, max_attempts=excluded.max_attempts, error=excluded.error, heartbeat_stage=excluded.heartbeat_stage,
      heartbeat_summary=excluded.heartbeat_summary, completed_at=excluded.completed_at, last_heartbeat_at=excluded.last_heartbeat_at,
      result_json=excluded.result_json, raw_json=excluded.raw_json, collected_at=excluded.collected_at`);
    for (const [issueId, storedRuns] of source.runsByIssue.entries()) {
      const runs = Array.isArray(storedRuns) ? storedRuns : storedRuns.items ?? [];
      for (const runRecord of runs) {
        execute(runStatement, runRecord.id, issueId, runRecord.agent_id, runRecord.status, runRecord.attempt ?? 0, runRecord.max_attempts ?? 0, runRecord.error,
          runRecord.heartbeat_stage, runRecord.heartbeat_summary, runRecord.created_at, runRecord.started_at, runRecord.completed_at, runRecord.last_heartbeat_at,
          json(runRecord.result), json(runRecord), collectedAt);
      }
    }

    const messageStatement = connection.prepare(`INSERT INTO run_messages (run_id, issue_id, raw_json, collected_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET raw_json=excluded.raw_json, collected_at=excluded.collected_at`);
    for (const [runId, messages] of source.messagesByRun.entries()) {
      const runRow = connection.prepare('SELECT issue_id FROM runs WHERE id = ?').get(runId);
      execute(messageStatement, runId, runRow?.issue_id ?? null, json(messages), collectedAt);
    }
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

export function saveServiceCheck(check) {
  db().prepare('INSERT INTO service_checks (service_name, status, latency_ms, detail, checked_at) VALUES (?, ?, ?, ?, ?)')
    .run(check.serviceName, check.status, check.latencyMs ?? null, check.detail ?? null, check.checkedAt);
}

export function saveSnapshot(payload, collectedAt) {
  const connection = db();
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.prepare(`INSERT INTO current_snapshot (id, collected_at, payload_json) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET collected_at=excluded.collected_at, payload_json=excluded.payload_json`)
      .run(collectedAt, json(payload));
    saveHealthTrendPoint(payload, collectedAt, connection);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

export function trendPointFromSnapshot(snapshot, collectedAt = snapshot?.generatedAt) {
  const overview = snapshot?.overview ?? {};
  const production = snapshot?.production ?? {};
  return {
    collectedAt,
    score: Number(overview.score ?? 0) || 0,
    blockedIssues: Number(production.blockedIssues ?? overview.criticalCount ?? 0) || 0,
    warningCount: Number(overview.warningCount ?? 0) || 0,
    criticalCount: Number(overview.criticalCount ?? 0) || 0,
    activeIssues: Number(overview.activeIssues ?? 0) || 0
  };
}

export function saveHealthTrendPoint(snapshot, collectedAt, connection = db()) {
  const point = trendPointFromSnapshot(snapshot, collectedAt);
  connection.prepare(`INSERT INTO health_trend_points (collected_at, score, blocked_issues, warning_count, critical_count, active_issues)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collected_at) DO UPDATE SET score=excluded.score,
    blocked_issues=excluded.blocked_issues, warning_count=excluded.warning_count,
    critical_count=excluded.critical_count, active_issues=excluded.active_issues`)
    .run(point.collectedAt, point.score, point.blockedIssues, point.warningCount, point.criticalCount, point.activeIssues);
}

/**
 * One-off migration of the most recent seven days of legacy full snapshots.
 * Rows are streamed one at a time and only chart metrics are retained.
 */
export function backfillHealthTrendPoints({ days = 7 } = {}) {
  const connection = db();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = connection.prepare('SELECT collected_at, payload_json FROM snapshots WHERE collected_at >= ? ORDER BY id ASC').iterate(cutoff);
  let migrated = 0;
  let skipped = 0;
  const upsert = connection.prepare(`INSERT INTO health_trend_points (collected_at, score, blocked_issues, warning_count, critical_count, active_issues)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collected_at) DO NOTHING`);
  connection.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      try {
        const point = trendPointFromSnapshot(JSON.parse(row.payload_json), row.collected_at);
        const result = upsert.run(point.collectedAt, point.score, point.blockedIssues, point.warningCount, point.criticalCount, point.activeIssues);
        migrated += Number(result.changes ?? 0);
      } catch {
        skipped += 1;
      }
    }
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
  return { migrated, skipped, cutoff };
}

/**
 * Full Skill content is intentionally kept outside the health snapshot. The
 * audit cache only persists derived evidence and is refreshed when Multica's
 * skill updated_at changes.
 */
export function loadSkillAudits() {
  return new Map(db().prepare('SELECT skill_id, audit_json FROM skill_audits').all().flatMap((row) => {
    try {
      return [[row.skill_id, JSON.parse(row.audit_json)]];
    } catch {
      return [];
    }
  }));
}

export function saveSkillAudits(audits) {
  if (!audits.length) return;
  const connection = db();
  const statement = connection.prepare(`INSERT INTO skill_audits (skill_id, source_updated_at, audit_json, audited_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(skill_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,
    audit_json=excluded.audit_json, audited_at=excluded.audited_at`);
  connection.exec('BEGIN IMMEDIATE');
  try {
    for (const { skillId, audit } of audits) {
      execute(statement, skillId, audit.sourceUpdatedAt, json(audit), audit.auditedAt);
    }
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

export function saveDarwinReviewPlan(skillId, plan) {
  db().prepare(`INSERT INTO darwin_review_plans (skill_id, plan_json, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(skill_id) DO UPDATE SET plan_json=excluded.plan_json, updated_at=excluded.updated_at`)
    .run(skillId, json(plan), plan.confirmedAt ?? plan.generatedAt);
}

export function loadDarwinReviewPlans() {
  return new Map(db().prepare('SELECT skill_id, plan_json FROM darwin_review_plans').all().flatMap((row) => {
    try {
      return [[row.skill_id, JSON.parse(row.plan_json)]];
    } catch {
      return [];
    }
  }));
}

export function darwinReviewPlan(skillId) {
  const row = db().prepare('SELECT plan_json FROM darwin_review_plans WHERE skill_id = ?').get(skillId);
  if (!row) return null;
  try {
    return JSON.parse(row.plan_json);
  } catch {
    return null;
  }
}

export function saveMulticaArchitectureReviewIssue(issue, skills) {
  const connection = db();
  const savedAt = new Date().toISOString();
  connection.prepare(`INSERT INTO multica_architecture_review_issues
    (issue_id, issue_identifier, batch_id, issue_url, status, created_at, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET
      issue_identifier=excluded.issue_identifier, issue_url=excluded.issue_url,
      status=excluded.status, updated_at=excluded.updated_at, raw_json=excluded.raw_json`)
    .run(issue.id, issue.identifier ?? null, issue.batchId, issue.url ?? null, issue.status ?? 'todo', issue.created_at ?? savedAt, savedAt, json(issue.raw ?? issue));
  const statement = connection.prepare(`INSERT INTO multica_architecture_review_issue_skills
    (issue_id, skill_id, skill_name, source_updated_at, plan_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_id, skill_id) DO UPDATE SET
      skill_name=excluded.skill_name, source_updated_at=excluded.source_updated_at, plan_json=excluded.plan_json`);
  for (const skill of skills) {
    statement.run(issue.id, skill.id, skill.name, skill.sourceUpdatedAt ?? null, json(skill.plan), savedAt);
  }
}

export function multicaArchitectureReviewJobs() {
  const rows = db().prepare(`SELECT s.skill_id, s.skill_name, s.source_updated_at, s.plan_json, s.created_at AS skill_created_at,
      i.issue_id, i.issue_identifier, i.batch_id, i.issue_url, i.status AS issue_status, i.created_at AS issue_created_at, i.updated_at AS issue_updated_at
    FROM multica_architecture_review_issue_skills s
    JOIN multica_architecture_review_issues i ON i.issue_id = s.issue_id
    ORDER BY i.created_at DESC`).all();
  return rows.flatMap((row) => {
    try {
      return [{
        skillId: row.skill_id,
        skillName: row.skill_name,
        sourceUpdatedAt: row.source_updated_at,
        plan: JSON.parse(row.plan_json),
        issue: {
          id: row.issue_id,
          identifier: row.issue_identifier,
          batchId: row.batch_id,
          url: row.issue_url,
          status: row.issue_status,
          createdAt: row.issue_created_at,
          updatedAt: row.issue_updated_at
        }
      }];
    } catch {
      return [];
    }
  });
}

export function latestSnapshot() {
  const row = db().prepare('SELECT payload_json FROM current_snapshot WHERE id = 1').get();
  return row ? JSON.parse(row.payload_json) : null;
}

export function recentCollections(limit = 10) {
  return db().prepare('SELECT id, started_at, finished_at, status, error, summary_json FROM collections ORDER BY id DESC LIMIT ?').all(limit)
    .map((row) => ({ ...row, summary: row.summary_json ? JSON.parse(row.summary_json) : null }));
}

export function healthTrend(windowHours = 24) {
  const hours = normaliseTrendWindow(windowHours);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = db().prepare(`SELECT collected_at, score, blocked_issues, warning_count, critical_count, active_issues
    FROM health_trend_points WHERE collected_at >= ? ORDER BY collected_at ASC`).all(cutoff)
    .map((row) => ({
      collectedAt: row.collected_at,
      snapshot: {
        overview: { score: row.score, warningCount: row.warning_count, criticalCount: row.critical_count, activeIssues: row.active_issues },
        production: { blockedIssues: row.blocked_issues }
      }
    }));
  return summarizeHealthTrend(rows, { windowHours: hours });
}

function parseRawRows(rows) {
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.raw_json)];
    } catch {
      return [];
    }
  });
}

/**
 * Daily metrics stay local and are assembled from the same read-only Multica
 * collection that feeds the health snapshot. State transitions are recorded
 * locally so completion counts become authoritative after first observation.
 */
export function dailyHealthSummary(snapshot, now = new Date(), { includeFullReworkEvidence = false } = {}) {
  const range = shanghaiDayRange(now);
  const connection = db();
  const issues = parseRawRows(connection.prepare('SELECT raw_json FROM issues').all());
  const skills = parseRawRows(connection.prepare('SELECT raw_json FROM skills').all());
  const agents = parseRawRows(connection.prepare('SELECT raw_json FROM agents').all());
  const completionEvents = connection.prepare(`SELECT issue_id AS issueId, previous_status AS previousStatus, status, observed_at AS observedAt
    FROM issue_status_events WHERE observed_at >= ? AND observed_at < ?`).all(range.startAt, range.endAt);
  // Only the current collection scope is eligible. Historical rows retained
  // for local trends must not create rework findings for Issues no longer in scope.
  const messagesByRun = new Map(connection.prepare('SELECT run_id AS runId, raw_json AS rawJson FROM run_messages').all()
    .flatMap((row) => {
      try {
        return [[row.runId, JSON.parse(row.rawJson)]];
      } catch {
        return [];
      }
    }));
  const scopedRuns = connection.prepare(`SELECT
      runs.raw_json AS rawJson,
      issues.identifier AS issueIdentifier,
      issues.title AS issueTitle,
      issues.raw_json AS issueRawJson,
      agents.name AS agentName
    FROM runs
    INNER JOIN issues ON issues.id = runs.issue_id
    LEFT JOIN agents ON agents.id = runs.agent_id
    WHERE issues.collected_at = (SELECT MAX(collected_at) FROM issues)`).all()
    .map((row) => {
      const run = JSON.parse(row.rawJson);
      const issue = JSON.parse(row.issueRawJson);
      return {
        ...run,
        issueIdentifier: row.issueIdentifier,
        issueTitle: row.issueTitle,
        issueDescription: issue.description ?? '',
        agentName: row.agentName,
        runMessages: messagesByRun.get(run.id) ?? null
      };
    });
  const reworkIssues = findReworkIssues(scopedRuns, { threshold: 3 });
  return buildDailyHealthSummary({ snapshot, issues, skills, agents, completionEvents, reworkIssues, includeFullReworkEvidence, now });
}

export function reworkIssueDetail(issueId, snapshot = latestSnapshot()) {
  if (!snapshot) return null;
  const detail = dailyHealthSummary(snapshot, new Date(), { includeFullReworkEvidence: true });
  return detail.reworkIssues.items.find((item) => item.issueId === issueId || item.identifier === issueId) ?? null;
}

function messagePreview(value, limit = 720) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

export function issueDetail(issueId, { runLimit = 12, messageLimit = 8 } = {}) {
  const issue = db().prepare('SELECT raw_json FROM issues WHERE id = ? OR identifier = ?').get(issueId, issueId);
  if (!issue) return null;
  const parsed = JSON.parse(issue.raw_json);
  const runs = db().prepare('SELECT raw_json FROM runs WHERE issue_id = ? ORDER BY COALESCE(last_heartbeat_at, created_at) DESC LIMIT ?').all(parsed.id, runLimit).map((row) => JSON.parse(row.raw_json));
  const messageRows = db().prepare('SELECT run_id, raw_json, collected_at FROM run_messages WHERE issue_id = ? ORDER BY collected_at DESC LIMIT ?').all(parsed.id, messageLimit);
  const messages = messageRows.map((row) => ({
    runId: row.run_id,
    collectedAt: row.collected_at,
    value: messagePreview(row.raw_json),
    sizeBytes: Buffer.byteLength(row.raw_json, 'utf8')
  }));
  const counts = {
    runs: db().prepare('SELECT COUNT(*) AS count FROM runs WHERE issue_id = ?').get(parsed.id).count,
    messages: db().prepare('SELECT COUNT(*) AS count FROM run_messages WHERE issue_id = ?').get(parsed.id).count
  };
  return { issue: parsed, runs, messages, counts };
}

export function issueRunMessage(issueId, runId) {
  const row = db().prepare('SELECT raw_json, collected_at FROM run_messages WHERE issue_id = ? AND run_id = ?').get(issueId, runId);
  if (!row) return null;
  return { runId, collectedAt: row.collected_at, value: JSON.parse(row.raw_json) };
}
