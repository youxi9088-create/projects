import { mongodb } from '@fn/mongodb';
import { gzipSync, gunzipSync } from 'node:zlib';
import { snapshotView } from '../src/snapshot-view.js';
import { normaliseTrendWindow, summarizeHealthTrend } from '../src/trend.js';

// FN's Mongo bridge performs work while a collection handle is constructed.
// Deferring that work keeps a route import cheap; each collection is opened
// only in the code path that truly needs it.
function lazyCollection(name: string): any {
  let value: any;
  return new Proxy({}, { get(_target, key) {
    value ??= mongodb.collection<any>(name);
    const member = value[key];
    return typeof member === 'function' ? member.bind(value) : member;
  } });
}

const snapshots = lazyCollection('health_snapshots');
const collections = lazyCollection('health_collections');
// Legacy fat trend rows carried full overview/production projections, so a
// page of them exceeded the FN Mongo bridge response cap. New trend evidence
// is written only to the lightweight points collection below.
const trends = lazyCollection('health_trends');
const trendPoints = lazyCollection('health_trend_points_v2');
const issues = lazyCollection('health_issues');
const runs = lazyCollection('health_runs');
const messages = lazyCollection('health_run_messages');
const importedArchive = lazyCollection('health_local_archive');
const importBatches = lazyCollection('health_import_batches');
const importBaselines = lazyCollection('health_import_baselines');
const collectionState = lazyCollection('health_collection_state');
const syncState = lazyCollection('health_sync_state_v2');
const syncIssues = lazyCollection('health_sync_issues');
const syncRuns = lazyCollection('health_sync_runs');
const syncMessages = lazyCollection('health_sync_messages');
const syncMessageQueue = lazyCollection('health_sync_message_queue');
const syncAgents = lazyCollection('health_sync_agents');
const syncSkills = lazyCollection('health_sync_skills');
const syncSquads = lazyCollection('health_sync_squads');
// This is a deliberately narrow, cloud-resident projection of the old local
// database. It exists solely to recover terminal production-line Run history;
// realtime Issue, risk, Skill and rework analysis never reads these rows.
const historicalLineRuns = lazyCollection('health_historical_line_runs_v1');
const historicalLineMessages = lazyCollection('health_historical_line_messages_v1');
const historicalReworkNodes = lazyCollection('health_historical_rework_nodes_v1');
const currentPages = lazyCollection('health_current_pages_v3');
const currentReworkIssues = lazyCollection('health_current_rework_issues_v3');
// Cloud-resident Darwin review-workbench state: independent review documents
// (imported from the local review folder), per-Skill test-prompt plans, and the
// Multica "完成skill架构评审" issues created from confirmed plans.
const architectureReviews = lazyCollection('health_architecture_reviews_v1');
const darwinReviewPlans = lazyCollection('health_darwin_review_plans_v1');
const multicaReviewJobs = lazyCollection('health_multica_review_jobs_v1');
// 互动方案使用汇总：每次云端同步完成后，对已完成颗粒生产 issue 做互动方案
// 分析并聚合，供检测台"互动方案"页面展示（方案中英文名、使用次数、涉及 issue）。
const schemeUsage = lazyCollection('health_scheme_usage');

// Collection slices can land on different FN runners when several tabs or
// retries are active. A process-local flag is not enough, so serialize cursor
// advancement with a short cloud lease.
const CLOUD_COLLECTION_LEASE_MS = 9 * 60 * 1000;

const plain = (value: any) => value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_id'))
  : value;

const shortText = (value: any, limit = 8_000) => {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const syncIssue = (value: any) => ({ id: value.id, identifier: value.identifier, title: shortText(value.title, 500), description: shortText(value.description, 4_000), status: value.status, priority: value.priority, assignee_id: value.assignee_id, assignee_type: value.assignee_type, created_at: value.created_at, updated_at: value.updated_at });
const syncAgent = (value: any) => ({
  id: value.id, name: value.name, description: shortText(value.description, 2_000), instructions: shortText(value.instructions, 2_000),
  created_at: value.created_at, updated_at: value.updated_at, published_at: value.published_at, has_draft: value.has_draft,
  // Skill bindings are what defines a Skill as "related" to this squad. Drop
  // only the bulky per-binding description; keep id/name so the Skill scope
  // computation (boundAgentsBySkill) works after the sync round-trip.
  skills: (value.skills ?? []).map((binding: any) => ({ id: binding.id, name: binding.name }))
});
const syncSkill = (value: any) => ({ id: value.id, name: value.name, description: shortText(value.description, 2_000), instructions: shortText(value.instructions, 2_000), created_at: value.created_at, updated_at: value.updated_at, published_at: value.published_at, has_draft: value.has_draft });
const syncRun = (value: any) => ({ id: value.id, issue_id: value.issue_id, agent_id: value.agent_id, status: value.status, attempt: value.attempt, max_attempts: value.max_attempts, error: shortText(value.error, 240), heartbeat_stage: value.heartbeat_stage, heartbeat_summary: shortText(value.heartbeat_summary, 240), created_at: value.created_at, started_at: value.started_at, completed_at: value.completed_at, last_heartbeat_at: value.last_heartbeat_at, trigger_summary: shortText(value.trigger_summary, 500), result: { output: shortText(value.result?.output, 500), user_visible_output: shortText(value.result?.user_visible_output, 500) } });
const syncMessagePayload = (value: any) => {
  const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.messages) ? value.messages : [];
  return { items: items.slice(0, 12).map((item: any) => ({ type: item?.type, tool: item?.tool, input: item?.input?.skill ? { skill: item.input.skill } : undefined, content: shortText(item?.content, 1_000), text: shortText(item?.text, 1_000) })) };
};
const runRecords = (value: any) => Array.isArray(value) ? value : value?.items ?? value?.runs ?? [];

// Chart evidence is intentionally tiny: the browser trend chart consumes only
// these metrics, and a small document keeps every Mongo bridge read far below
// the service response cap that the legacy fat trend rows exceeded.
function trendPointFromSnapshot(snapshot: any, collectedAt: string, source?: string) {
  const overview = snapshot?.overview ?? {};
  const production = snapshot?.production ?? {};
  const point = {
    id: collectedAt,
    collectedAt,
    score: Number(overview.score ?? 0) || 0,
    blockedIssues: Number(production.blockedIssues ?? overview.criticalCount ?? 0) || 0,
    warningCount: Number(overview.warningCount ?? 0) || 0,
    criticalCount: Number(overview.criticalCount ?? 0) || 0,
    activeIssues: Number(overview.activeIssues ?? 0) || 0
  };
  return source ? { ...point, source } : point;
}

async function replaceRows(collection: any, rows: any[]) {
  await collection.deleteMany({});
  if (rows.length) await insertWithinServiceLimit(collection, rows);
}

export async function latestSnapshot() {
  const record = await snapshots.findOne({ id: 'current' });
  // A current snapshot is small enough for Mongo's document limit and is the
  // fast path for every dashboard page. Keep archive reads as recovery only:
  // streaming every compressed archive part on a page refresh can exhaust the
  // FN runtime before it responds.
  if (record?.snapshot) return record.snapshot;
  const baseline = await importBaselines.findOne({ id: 'current' });
  if (record?.snapshot?.cloudArchiveId) {
    try {
      const parts = (await importedArchive.find({ archiveId: record.snapshot.cloudArchiveId }).sort({ partIndex: 1 }).limit(1_000).toArray()).map(plain);
      if (parts.length && parts.length === Number(parts[0].partCount ?? 1)) {
        const payload = parts.map((part: any) => part.payload).join('');
        return JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString('utf8'));
      }
    } catch {
      // Fall back to the last readable snapshot below.
    }
  }
  // Complete cloud collections are written as compressed archives because a
  // full evidence-rich snapshot can exceed one Mongo document.  Prefer that
  // current archive over an older compact `health_snapshots.current` record;
  // otherwise a successful new collection appears to be stuck at its old
  // timestamp forever.
  if (baseline?.archiveId && baseline?.cloudMigration?.source === 'cloud') {
    try {
      const parts = (await importedArchive.find({ archiveId: baseline.archiveId }).sort({ partIndex: 1 }).limit(1_000).toArray()).map(plain);
      if (parts.length && parts.length === Number(parts[0].partCount ?? 1)) {
        const payload = parts.map((part: any) => part.payload).join('');
        const decoded = gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
        const snapshot = baseline.format === 'snapshot_json' ? JSON.parse(decoded) : JSON.parse(JSON.parse(decoded).payload_json);
        return { ...snapshot, cloudMigration: baseline.cloudMigration };
      }
    } catch {
      // If the newest archive is incomplete, keep the last regular snapshot
      // readable instead of treating the dashboard as unavailable.
    }
  }
  // Before the first complete cloud collection, retain the imported baseline
  // (if any); otherwise return the normal single-document snapshot.
  if (record?.snapshot?.cloudSync?.complete) return record.snapshot;
  if (baseline?.archiveId) {
    try {
      const parts = (await importedArchive.find({ archiveId: baseline.archiveId }).sort({ partIndex: 1 }).limit(1_000).toArray()).map(plain);
      if (parts.length && parts.length === Number(parts[0].partCount ?? 1)) {
        const payload = parts.map((part: any) => part.payload).join('');
        const decoded = gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
        const snapshot = baseline.format === 'snapshot_json' ? JSON.parse(decoded) : JSON.parse(JSON.parse(decoded).payload_json);
        return { ...snapshot, cloudMigration: baseline.cloudMigration };
      }
    } catch {
      // Fall through to the compact record below.
    }
  }
  return record?.snapshot ?? null;
}

export async function healthPage(page: string) {
  const current = await currentPages.findOne({ id: page });
  if (current?.snapshot) return current.snapshot;
  if (current?.snapshotGzipBase64) {
    try {
      return JSON.parse(gunzipSync(Buffer.from(current.snapshotGzipBase64, 'base64')).toString('utf8'));
    } catch {
      // Fall through to the legacy full snapshot if the projection is partial.
    }
  }
  return snapshotView(await latestSnapshot(), page);
}

export async function recentCollections(limit = 10) {
  return (await collections.find({}).sort({ startedAt: -1 }).limit(limit).toArray()).map(plain);
}

export async function healthTrend(hours: number) {
  const windowHours = normaliseTrendWindow(hours);
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoff).toISOString();
  const points: any[] = [];
  // health_trend_points_v2 stores only the chart metrics, so every row stays
  // tiny and a page of 200 is comfortably below the Mongo bridge response cap.
  for (let offset = 0; offset < 10_000; offset += 200) {
    const page = await trendPoints.find({ collectedAt: { $gte: cutoffIso } }).sort({ collectedAt: 1 }).skip(offset).limit(200).toArray();
    // health-live.db is the local serving/test store; its three seed points
    // are retained in the cloud archive but must not become production trend
    // evidence beside the historical collector records.
    points.push(...page.map(plain).filter((item: any) => item.source !== 'health-live-db'));
    if (page.length < 200) break;
  }
  // The browser chart consumes flattened, bucketed metric points. Persisted
  // cloud rows already carry the compact metric contract, so normalize them
  // through the same shape used by the local SQLite collector.
  return summarizeHealthTrend(points.map((item: any) => ({ collectedAt: item.collectedAt, snapshot: { overview: { score: item.score, warningCount: item.warningCount, criticalCount: item.criticalCount, activeIssues: item.activeIssues }, production: { blockedIssues: item.blockedIssues } } })), { windowHours });
}

// One-off migration of legacy fat trend rows (full overview/production
// projections) into the lightweight trend-point collection. Rows are read one
// at a time because the legacy documents are too large to page in bulk.
export async function backfillTrendPoints({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) {
  const rows: any[] = [];
  for (let index = 0; index < limit; index += 1) {
    const page = await trends.find({}).sort({ collectedAt: 1 }).skip(offset + index).limit(1).toArray();
    if (!page.length) break;
    rows.push(plain(page[0]));
  }
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row?.collectedAt) { skipped += 1; continue; }
    const point = trendPointFromSnapshot(row.snapshot, row.collectedAt, row.source);
    await trendPoints.updateOne({ id: point.id }, { $set: point }, { upsert: true });
    migrated += 1;
  }
  return { migrated, skipped, nextOffset: offset + rows.length, total: rows.length };
}

export async function issueDetail(id: string) {
  // The live page-projection flow (persistEvidence=false) never rewrites the
  // legacy `health_issues` evidence collections, so they can hold a stale or
  // partial set. The resumable sync collections are rewritten by every
  // completed collection and are the authoritative current Issue source.
  const issueRow = await issues.findOne({ id }) ?? await issues.findOne({ identifier: id });
  const syncRow = await syncIssues.findOne({ id }) ?? await syncIssues.findOne({ identifier: id }) ?? await syncIssues.findOne({ 'value.identifier': id });
  const issue = issueRow ?? syncRow;
  if (!issue) return null;
  // Sync rows wrap the compact Issue under `value`; legacy evidence rows are
  // stored flat. Normalize both before reading Run/message evidence.
  const isSyncRow = Boolean(syncRow && !issueRow);
  const parsed = isSyncRow ? plain(issue).value : plain(issue);
  const sourceRuns = isSyncRow ? syncRuns : runs;
  const sourceMessages = isSyncRow ? syncMessages : messages;
  const issueRuns = (await sourceRuns.find({ issueId: parsed.id }).sort({ lastHeartbeatAt: -1 }).limit(12).toArray()).map((row: any) => row.value);
  const issueMessages = (await sourceMessages.find({ issueId: parsed.id }).sort({ collectedAt: -1 }).limit(8).toArray()).map((row: any) => ({
    runId: row.runId,
    collectedAt: row.collectedAt,
    value: JSON.stringify(row.value).replace(/\s+/g, ' ').slice(0, 720),
    sizeBytes: JSON.stringify(row.value).length
  }));
  return {
    issue: parsed,
    runs: issueRuns,
    messages: issueMessages,
    counts: {
      runs: await sourceRuns.countDocuments({ issueId: parsed.id }),
      messages: await sourceMessages.countDocuments({ issueId: parsed.id })
    }
  };
}

export async function reworkIssueDetail(id: string) {
  const current = await currentReworkIssues.findOne({ id }) ?? await currentReworkIssues.findOne({ identifier: id });
  if (current?.item) return current.item;
  const historical = await loadHistoricalReworkIssues([id]);
  if (historical.items[0]) return historical.items[0];
  const snapshot = await latestSnapshot();
  return snapshot?.daily?.reworkIssues?.items?.find((item: any) => item.issueId === id || item.identifier === id) ?? null;
}

export async function restoreCurrentPageProjection(snapshot: any) {
  if (!snapshot?.generatedAt || !snapshot?.overview) throw new Error('恢复快照缺少生成时间或概览字段。');
  const collectedAt = new Date().toISOString();
  const pageNames = ['overview', 'production', 'agents', 'skills', 'risks'];
  for (const page of pageNames) {
    const pageJson = JSON.stringify(snapshotView(snapshot, page));
    await currentPages.updateOne(
      { id: page },
      { $set: { id: page, collectedAt, snapshotGzipBase64: gzipSync(Buffer.from(pageJson)).toString('base64') }, $unset: { snapshot: '' } },
      { upsert: true }
    );
  }
  return { collectedAt, pages: pageNames.length, reworkIssues: Number(snapshot?.daily?.reworkIssues?.count ?? 0) };
}

export async function saveCloudCollection({ snapshot, source, startedAt, persistEvidence = true }: any) {
  const collectedAt = new Date().toISOString();
  const runRows = [...source.runsByIssue.entries()].flatMap(([issueId, value]: any) => (Array.isArray(value) ? value : value.items ?? [])
    .map((run: any) => ({ id: run.id, issueId, lastHeartbeatAt: run.last_heartbeat_at ?? run.created_at, value: run })));
  const messageRows = [...source.messagesByRun.entries()].map(([runId, value]: any) => ({
    id: `${runId}:${collectedAt}`, runId, issueId: runRows.find((run: any) => run.id === runId)?.issueId ?? null, collectedAt, value
  }));
  if (persistEvidence) {
    await replaceRows(issues, source.issues.map((issue: any) => ({ ...issue })));
    await replaceRows(runs, runRows);
    await replaceRows(messages, messageRows);
  }
  if (persistEvidence) {
    await snapshots.updateOne({ id: 'current' }, { $set: { id: 'current', collectedAt, snapshot } }, { upsert: true });
  } else {
    // Historical Run evidence and repeated-rework projections already live in
    // their own cloud collections. Rewriting a second full snapshot archive
    // during every collection can exceed FN's 30-second request budget.
    // Persist only the exact page projections and per-Issue drill-down data.
    await restoreCurrentPageProjection(snapshot);
  }
  await trendPoints.updateOne({ id: collectedAt }, { $set: trendPointFromSnapshot(snapshot, collectedAt) }, { upsert: true });
  await collections.updateOne({ id: startedAt }, { $set: { id: startedAt, startedAt, finishedAt: collectedAt, status: 'completed', summary: snapshot.overview, cloudSync: snapshot.cloudSync } }, { upsert: true });
  await collectionState.updateOne({ id: 'current' }, { $set: { id: 'current', status: 'idle', finishedAt: collectedAt } }, { upsert: true });
  return collectedAt;
}

export async function saveCollectionFailure({ startedAt, error }: { startedAt: string; error: string }) {
  const finishedAt = new Date().toISOString();
  await collections.updateOne({ id: startedAt }, { $set: { id: startedAt, startedAt, finishedAt, status: 'failed', error } }, { upsert: true });
  await collectionState.updateOne({ id: 'current' }, { $set: { id: 'current', status: 'idle', finishedAt, error } }, { upsert: true });
}

function progress(state: any) {
  const runTotal = Number(state.issueIds?.length ?? 0);
  const messageTotal = Number(state.messageCount ?? 0);
  return { phase: state.phase, runs: { completed: Number(state.issueCursor ?? 0), total: runTotal }, messages: { completed: Number(state.messageCursor ?? 0), total: messageTotal } };
}

async function persistSyncState(state: any) {
  const next = { ...state, id: 'current', updatedAt: new Date().toISOString() };
  next.progress = progress(next);
  await syncState.updateOne({ id: 'current' }, { $set: next }, { upsert: true });
  return next;
}

async function readAll(collection: any, query = {}, pageSize = 100) {
  const rows: any[] = [];
  // Small pages keep each bridge response under its service limit; fetching
  // independent offsets in bounded parallel batches keeps finalization within
  // FN's 30s request budget even for hundreds of Run messages.
  let total: number | null = null;
  try {
    const count = await collection.countDocuments(query);
    if (Number.isFinite(Number(count))) total = Number(count);
  } catch {
    // Older bridge versions may not expose countDocuments; use the bounded
    // sequential fallback below in that case.
  }
  if (total != null) {
    const batchSize = 8;
    for (let base = 0; base < total; base += pageSize * batchSize) {
      const pages = await Promise.all(Array.from({ length: Math.min(batchSize, Math.ceil((total - base) / pageSize)) }, (_, index) =>
        collection.find(query).sort({ id: 1 }).skip(base + index * pageSize).limit(pageSize).toArray()
      ));
      rows.push(...pages.flat().map(plain));
    }
    return rows;
  }
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const page = await collection.find(query).sort({ id: 1 }).skip(offset).limit(pageSize).toArray();
    rows.push(...page.map(plain));
    if (page.length < pageSize) return rows;
  }
  return rows;
}

export async function getCloudSyncState() {
  const state = plain(await syncState.findOne({ id: 'current' }));
  return state?.phase ? state : null;
}

export async function acquireCloudCollectionLease(leaseId: string, force = false) {
  const now = Date.now();
  await collectionState.updateOne(
    { id: 'current' },
    { $setOnInsert: { id: 'current', status: 'idle', leaseId: null, leaseUntil: 0 } },
    { upsert: true }
  );
  // ?force=1 is an explicit operator recovery action. It is used after a
  // platform timeout has killed the old runner but left its lease document
  // behind; normal polling never bypasses this guard.
  if (force) await collectionState.updateOne({ id: 'current' }, { $set: { leaseId: null, leaseUntil: 0 } });
  const claimed = await collectionState.findOneAndUpdate(
    {
      id: 'current',
      $or: [
        { leaseUntil: { $lte: now } },
        { leaseUntil: { $exists: false } },
        { leaseId }
      ]
    },
    { $set: { leaseId, leaseUntil: now + CLOUD_COLLECTION_LEASE_MS } },
    { returnDocument: 'after' }
  );
  return plain(claimed)?.leaseId === leaseId;
}

export async function releaseCloudCollectionLease(leaseId: string) {
  await collectionState.updateOne(
    { id: 'current', leaseId },
    { $set: { leaseId: null, leaseUntil: 0 } }
  );
}

export async function initialiseCloudSync(source: any) {
  await Promise.all([syncIssues.deleteMany({}), syncRuns.deleteMany({}), syncMessages.deleteMany({}), syncMessageQueue.deleteMany({}), syncAgents.deleteMany({}), syncSkills.deleteMany({}), syncSquads.deleteMany({})]);
  await Promise.all([
    insertWithinServiceLimit(syncIssues, source.issues.map((value: any) => ({ id: value.id, value: syncIssue(value) }))),
    insertWithinServiceLimit(syncAgents, source.agents.map((value: any) => ({ id: value.id, value: syncAgent(value) }))),
    insertWithinServiceLimit(syncSkills, source.skills.map((value: any) => ({ id: value.id, value: syncSkill(value) }))),
    insertWithinServiceLimit(syncSquads, source.squads.map((value: any) => ({ id: value.id, value })))
  ]);
  const startedAt = new Date().toISOString();
  await collections.updateOne({ id: startedAt }, { $set: { id: startedAt, startedAt, status: 'running', mode: 'resumable_scoped_read_only' } }, { upsert: true });
  return persistSyncState({ status: 'running', startedAt, phase: 'runs', issueIds: source.issues.map((issue: any) => issue.id), issueCursor: 0, messageCursor: 0, messageCount: 0,
    core: { workspace: source.workspace, issueTotal: source.issueTotal, scope: source.scope, performanceScope: source.performanceScope,
      blockedIssueIds: source.issues.filter((issue: any) => issue.status === 'blocked').map((issue: any) => issue.id) } });
}

export async function saveCloudSyncRuns(state: any, rows: any[]) {
  const issueIds = rows.map((row) => row.issueId);
  await syncRuns.deleteMany({ issueId: { $in: issueIds } });
  const documents = rows.flatMap((row) => runRecords(row.value).filter((run: any) => run?.id).map((run: any) => ({ id: `${row.issueId}:${run.id}`, issueId: row.issueId, runId: run.id, lastHeartbeatAt: run.last_heartbeat_at ?? run.created_at ?? '', value: syncRun(run) })));
  await insertWithinServiceLimit(syncRuns, documents);
  const issueCursor = Math.min(state.issueIds.length, Number(state.issueCursor) + rows.length);
  return persistSyncState({ ...state, issueCursor, phase: issueCursor >= state.issueIds.length ? 'prepare_messages' : 'runs' });
}

export async function prepareCloudMessageQueue(state: any, productionLimit: number, recentLimit: number) {
  const productionIds = new Set(state.core?.performanceScope?.issueIds ?? []);
  const blockedIds = new Set(state.core?.blockedIssueIds ?? []);
  const newest = (left: any, right: any) => String(right.lastHeartbeatAt).localeCompare(String(left.lastHeartbeatAt));
  const selected = new Map<string, any>();
  // Do not read the entire syncRuns archive just to choose message evidence.
  // A full read can exceed FN's 30s request budget once historical Runs are
  // present. Query only the newest candidate needed by each selection rule.
  const [blockedLatest, productionLatest, recentLatest] = await Promise.all([
    Promise.all([...blockedIds].map(async (issueId) =>
      (await syncRuns.find({ issueId }, { sort: { lastHeartbeatAt: -1 }, limit: 1 }).project({ id: 1, issueId: 1, runId: 1, lastHeartbeatAt: 1 }).toArray()).map(plain)
    )).then((rows) => rows.flat()),
    productionIds.size
      ? syncRuns.find({ issueId: { $in: [...productionIds] } }, { sort: { lastHeartbeatAt: -1 }, limit: productionLimit }).project({ id: 1, issueId: 1, runId: 1, lastHeartbeatAt: 1 }).toArray().then((rows) => rows.map(plain))
      : Promise.resolve([]),
    syncRuns.find({}, { sort: { lastHeartbeatAt: -1 }, limit: recentLimit }).project({ id: 1, issueId: 1, runId: 1, lastHeartbeatAt: 1 }).toArray().then((rows) => rows.map(plain))
  ]);
  for (const issueId of blockedIds) {
    const candidate = blockedLatest.find((row) => row.issueId === issueId);
    if (candidate) selected.set(candidate.runId, candidate);
  }
  for (const candidate of productionLatest.sort(newest).slice(0, productionLimit)) selected.set(candidate.runId, candidate);
  for (const candidate of recentLatest.sort(newest).slice(0, recentLimit)) selected.set(candidate.runId, candidate);
  await syncMessageQueue.deleteMany({});
  await insertWithinServiceLimit(syncMessageQueue, [...selected.values()].map((row, order) => ({ id: row.runId, runId: row.runId, issueId: row.issueId, order })));
  return persistSyncState({ ...state, phase: selected.size ? 'messages' : 'finalize', messageCursor: 0, messageCount: selected.size });
}

export async function loadCloudMessageCandidates(state: any, limit: number) {
  return (await syncMessageQueue.find({}).sort({ order: 1 }).skip(Number(state.messageCursor ?? 0)).limit(limit).toArray()).map(plain);
}

export async function loadCloudSyncIssueCandidates(state: any, limit: number) {
  const ids = state.issueIds.slice(Number(state.issueCursor ?? 0), Number(state.issueCursor ?? 0) + limit);
  const rows = await syncIssues.find({ id: { $in: ids } }).limit(limit).toArray();
  const byId = new Map(rows.map((row: any) => [row.id, plain(row).value]));
  return ids.map((id: string) => byId.get(id)).filter(Boolean);
}

export async function saveCloudSyncMessages(state: any, rows: any[]) {
  const runIds = rows.map((row) => row.runId);
  await syncMessages.deleteMany({ runId: { $in: runIds } });
  await insertWithinServiceLimit(syncMessages, rows.map((row) => ({ id: row.runId, runId: row.runId, issueId: row.issueId, value: syncMessagePayload(row.value) })));
  const messageCursor = Math.min(Number(state.messageCount), Number(state.messageCursor) + rows.length);
  return persistSyncState({ ...state, messageCursor, phase: messageCursor >= Number(state.messageCount) ? 'finalize' : 'messages' });
}

export async function loadCloudSyncSource(state: any) {
  const [issueRows, runRows, messageRows, agentRows, skillRows, squadRows] = await Promise.all([readAll(syncIssues), readAll(syncRuns, {}, 20), readAll(syncMessages, {}, 10), readAll(syncAgents), readAll(syncSkills), readAll(syncSquads)]);
  const runsByIssue = new Map<string, any[]>();
  for (const row of runRows) {
    const values = runsByIssue.get(row.issueId) ?? [];
    values.push(row.value);
    runsByIssue.set(row.issueId, values);
  }
  return { ...state.core, agents: agentRows.map((row) => row.value), skills: skillRows.map((row) => row.value), squads: squadRows.map((row) => row.value), issues: issueRows.map((row) => row.value), runsByIssue, messagesByRun: new Map(messageRows.map((row) => [row.runId, row.value])) };
}

export async function completeCloudSync(state: any, cloudSync: any) {
  const completed = await persistSyncState({ ...state, status: 'completed', phase: 'completed', cloudSync });
  await syncState.updateOne({ id: 'current' }, { $set: { ...completed, status: 'completed' } }, { upsert: true });
  return completed;
}

export async function pruneCloudHistory(checkedAt: string, keepDays = 7) {
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedMs)) return { cutoff: null, runs: 0, messages: 0, trends: 0, collections: 0 };
  const cutoff = new Date(checkedMs - keepDays * 86400000).toISOString();
  const oldRunQuery = {
    $or: [
      { 'value.last_heartbeat_at': { $lt: cutoff } },
      { 'value.completed_at': { $lt: cutoff } },
      { 'value.started_at': { $lt: cutoff } },
      { 'value.created_at': { $lt: cutoff } }
    ]
  };
  const oldRunIds: string[] = [];
  for (let offset = 0; offset < 20_000; offset += 200) {
    const page = await historicalLineRuns.find(oldRunQuery, { sort: { id: 1 }, skip: offset, limit: 200 })
      .project({ id: 1, runId: 1 }).toArray();
    oldRunIds.push(...page.map((row: any) => plain(row)).map((row: any) => row.runId ?? row.id).filter(Boolean));
    if (page.length < 200) break;
  }
  let removedRuns = 0;
  let removedMessages = 0;
  for (let offset = 0; offset < oldRunIds.length; offset += 100) {
    const runIds = oldRunIds.slice(offset, offset + 100);
    removedRuns += Number((await historicalLineRuns.deleteMany({ runId: { $in: runIds } })).deletedCount ?? 0);
    removedMessages += Number((await historicalLineMessages.deleteMany({ runId: { $in: runIds } })).deletedCount ?? 0);
  }
  const [trendResult, legacyTrendResult, collectionResult] = await Promise.all([
    trendPoints.deleteMany({ collectedAt: { $lt: cutoff } }),
    trends.deleteMany({ collectedAt: { $lt: cutoff } }),
    collections.deleteMany({ startedAt: { $lt: cutoff } })
  ]);
  return {
    cutoff, runs: removedRuns, messages: removedMessages,
    trends: Number(trendResult?.deletedCount ?? 0) + Number(legacyTrendResult?.deletedCount ?? 0),
    collections: Number(collectionResult?.deletedCount ?? 0)
  };
}

export async function beginCloudCollection(startedAt: string) {
  const state = await collectionState.findOne({ id: 'current' });
  const runningAt = Date.parse(state?.startedAt ?? '');
  // A waitUntil tail has a 10-minute lifetime. A stale lock must never make
  // the dashboard permanently unrefreshable after an interrupted execution.
  if (state?.status === 'running' && Number.isFinite(runningAt) && Date.now() - runningAt < 11 * 60 * 1000) return false;
  await collectionState.updateOne({ id: 'current' }, { $set: { id: 'current', status: 'running', startedAt, error: null } }, { upsert: true });
  await collections.updateOne({ id: startedAt }, { $set: { id: startedAt, startedAt, status: 'running', mode: 'full_scoped_read_only' } }, { upsert: true });
  return true;
}

function importBatchId(migrationId: string, dataset: string, batch: number) {
  return `${migrationId}:${dataset}:${batch}`;
}

async function insertWithinServiceLimit(collection: any, documents: any[]) {
  // The FN Mongo bridge has a smaller payload cap than the HTTP request that
  // carries a migration batch. Split the bridge writes while retaining the
  // outer batch's all-or-retry semantics.
  let group: any[] = [];
  let groupBytes = 0;
  const flush = async () => {
    if (!group.length) return;
    await collection.insertMany(group);
    group = [];
    groupBytes = 0;
  };
  for (const document of documents) {
    const size = Buffer.byteLength(JSON.stringify(document));
    // The bridge response includes insertion metadata as well as the request.
    // Keep each operation well below its observed response cap.
    if (group.length && groupBytes + size > 2_000) await flush();
    group.push(document);
    groupBytes += size;
  }
  await flush();
}

export async function completedImportBatches(migrationId: string, dataset: string) {
  return (await importBatches.find({ migrationId, dataset, status: 'completed' }).sort({ batch: 1 }).limit(20_000).toArray())
    .map(plain)
    .map((item: any) => Number(item.batch))
    .filter(Number.isInteger);
}

export async function importHistoricalLineEvidenceBatch({ migrationId, dataset, batch, evidenceType, documents }: any) {
  const id = importBatchId(migrationId, dataset, batch);
  const completed = await importBatches.findOne({ id, status: 'completed' });
  if (completed) return { id, skipped: true, inserted: Number(completed.inserted ?? 0) };
  if (!['runs', 'messages'].includes(evidenceType)) throw new Error('历史证据类型必须为 runs 或 messages。');
  if (!Array.isArray(documents) || !documents.length || documents.length > 160) throw new Error('历史证据批次必须包含 1–160 条记录。');
  const target = evidenceType === 'runs' ? historicalLineRuns : historicalLineMessages;
  const prepared = documents.map((document: any, index: number) => {
    if (!document || typeof document.id !== 'string' || typeof document.runId !== 'string' || typeof document.issueId !== 'string' || !document.value) {
      throw new Error(`历史证据记录 ${index + 1} 格式无效。`);
    }
    if (Buffer.byteLength(JSON.stringify(document)) > 8_000) throw new Error(`历史证据记录 ${index + 1} 超过大小上限。`);
    return { ...document, migrationId, dataset, importBatchId: id, importedAt: new Date().toISOString() };
  });
  await target.deleteMany({ importBatchId: id });
  await insertWithinServiceLimit(target, prepared);
  await importBatches.updateOne({ id }, { $set: { id, migrationId, dataset, batch, status: 'completed', inserted: prepared.length, completedAt: new Date().toISOString() } }, { upsert: true });
  return { id, skipped: false, inserted: prepared.length };
}

export async function loadHistoricalLineEvidence({ issueIds, agentIds }: { issueIds: string[]; agentIds: string[] }) {
  if (!issueIds.length || !agentIds.length) return { runsByIssue: new Map(), messagesByRun: new Map(), runCount: 0, messageCount: 0 };
  // Historical evidence is already retained in the cloud. Re-reading a very
  // large archive on every interactive collection can monopolize the FN tail
  // and leave the collection permanently in `running`. The live sync remains
  // authoritative for the current snapshot; defer an oversized historical
  // replay to the dedicated import/backfill path instead.
  const historicalRunQuery = { issueId: { $in: issueIds }, agentId: { $in: agentIds } };
  let historicalRunCount = 0;
  try { historicalRunCount = Number(await historicalLineRuns.countDocuments(historicalRunQuery)); } catch { historicalRunCount = 0; }
  if (historicalRunCount > 6_000) {
    return {
      runsByIssue: new Map(), messagesByRun: new Map(), runCount: 0, messageCount: 0,
      skipped: true, error: `云端历史 Run ${historicalRunCount} 条，超过交互采集重读上限；保留云端历史，不在本轮重复扫描。`
    };
  }
  // Historical evidence documents can contain full Run/message payloads. The
  // Mongo bridge rejects a response that is too large even when the query is
  // otherwise valid, so page this read conservatively instead of requesting
  // 100 fat documents at once.
  const evidencePageSize = 10;
  const runRows = await readAll(historicalLineRuns, historicalRunQuery, evidencePageSize);
  const runIds = new Set(runRows.map((row) => row.runId));
  const messageRows = await readAll(historicalLineMessages, { issueId: { $in: issueIds } }, evidencePageSize);
  const runsByIssue = new Map<string, any[]>();
  for (const row of runRows) {
    const values = runsByIssue.get(row.issueId) ?? [];
    values.push(row.value);
    runsByIssue.set(row.issueId, values);
  }
  const messagesByRun = new Map(messageRows.filter((row) => runIds.has(row.runId)).map((row) => [row.runId, row.value]));
  return { runsByIssue, messagesByRun, runCount: runRows.length, messageCount: messagesByRun.size };
}

export async function importHistoricalReworkNodesBatch({ migrationId, dataset, batch, documents }: any) {
  const id = importBatchId(migrationId, dataset, batch);
  const completed = await importBatches.findOne({ id, status: 'completed' });
  if (completed) return { id, skipped: true, inserted: Number(completed.inserted ?? 0) };
  if (!Array.isArray(documents) || !documents.length || documents.length > 160) throw new Error('返工证据批次必须包含 1–160 条节点记录。');
  const prepared = documents.map((document: any, index: number) => {
    if (!document || typeof document.id !== 'string' || typeof document.issueId !== 'string' || typeof document.value?.node !== 'string') {
      throw new Error(`返工证据记录 ${index + 1} 格式无效。`);
    }
    if (Buffer.byteLength(JSON.stringify(document)) > 8_000) throw new Error(`返工证据记录 ${index + 1} 超过大小上限。`);
    return { ...document, migrationId, dataset, importBatchId: id, importedAt: new Date().toISOString() };
  });
  for (const document of prepared) await historicalReworkNodes.updateOne({ id: document.id }, { $set: document }, { upsert: true });
  await importBatches.updateOne({ id }, { $set: { id, migrationId, dataset, batch, status: 'completed', inserted: prepared.length, completedAt: new Date().toISOString() } }, { upsert: true });
  return { id, skipped: false, inserted: prepared.length };
}

export async function loadHistoricalReworkIssues(issueIds: string[]) {
  if (!issueIds.length) return { items: [], nodeCount: 0 };
  const rows: any[] = [];
  for (let offset = 0; offset < 5_000; offset += 100) {
    const page = await historicalReworkNodes.find({ issueId: { $in: issueIds } }).sort({ id: 1 }).skip(offset).limit(100).toArray();
    rows.push(...page.map(plain));
    if (page.length < 100) break;
  }
  const byIssue = new Map<string, any>();
  for (const row of rows) {
    const node = row.value;
    const issue = byIssue.get(row.issueId) ?? { issueId: row.issueId, identifier: row.identifier ?? row.issueId, title: row.title ?? '', reworkNodes: [] };
    issue.reworkNodes.push(node);
    byIssue.set(row.issueId, issue);
  }
  const items = [...byIssue.values()].map((issue) => {
    const nodes = issue.reworkNodes.sort((left: any, right: any) => Number(right.taskCount) - Number(left.taskCount) || String(right.lastAt ?? '').localeCompare(String(left.lastAt ?? '')) || String(left.node).localeCompare(String(right.node), 'zh-CN'));
    const primary = nodes[0] ?? {};
    return { ...issue, ...primary, reworkNodeCount: nodes.length, reworkNodes: nodes };
  }).sort((left, right) => Number(right.taskCount) - Number(left.taskCount) || String(right.lastAt ?? '').localeCompare(String(left.lastAt ?? '')) || String(left.identifier).localeCompare(String(right.identifier), 'zh-CN'));
  return { items, nodeCount: rows.length };
}

export async function importLocalArchiveBatch({ migrationId, dataset, batch, documents }: any) {
  const id = importBatchId(migrationId, dataset, batch);
  const completed = await importBatches.findOne({ id, status: 'completed' });
  if (completed) return { id, skipped: true, inserted: Number(completed.inserted ?? 0) };
  if (!Array.isArray(documents) || !documents.length || documents.length > 160) throw new Error('迁移批次必须包含 1–160 条记录。');
  const prepared = documents.map((document: any, index: number) => {
    if (!document || typeof document.id !== 'string' || typeof document.payload !== 'string' || document.encoding !== 'gzip-base64') {
      throw new Error(`迁移记录 ${index + 1} 格式无效。`);
    }
    if (document.payload.length > 4_500_000) throw new Error(`迁移记录 ${index + 1} 超过单条归档上限。`);
    return { ...document, migrationId, dataset, importBatchId: id, importedAt: new Date().toISOString() };
  });
  // A retry first removes only its own incomplete batch. This makes the
  // upload idempotent without touching a previous successful batch.
  await importedArchive.deleteMany({ importBatchId: id });
  await insertWithinServiceLimit(importedArchive, prepared);
  await importBatches.updateOne({ id }, { $set: { id, migrationId, dataset, batch, status: 'completed', inserted: prepared.length, completedAt: new Date().toISOString() } }, { upsert: true });
  return { id, skipped: false, inserted: prepared.length };
}

export async function importLocalTrendBatch({ migrationId, dataset, batch, documents }: any) {
  const id = importBatchId(migrationId, dataset, batch);
  const completed = await importBatches.findOne({ id, status: 'completed' });
  if (completed) return { id, skipped: true, inserted: Number(completed.inserted ?? 0) };
  if (!Array.isArray(documents) || !documents.length || documents.length > 600) throw new Error('趋势迁移批次必须包含 1–600 条记录。');
  const prepared = documents.map((document: any, index: number) => {
    if (!document || typeof document.id !== 'string' || !document.collectedAt || !document.snapshot) throw new Error(`趋势记录 ${index + 1} 格式无效。`);
    return { ...document, migrationId, dataset, importBatchId: id, importedAt: new Date().toISOString() };
  });
  await trends.deleteMany({ importBatchId: id });
  await insertWithinServiceLimit(trends, prepared);
  // Mirror the same history into the lightweight chart collection so trend
  // reads never touch the legacy fat snapshot rows again.
  const points = prepared.map((document: any) => trendPointFromSnapshot(document.snapshot, document.collectedAt, document.source)).filter((point: any) => point.collectedAt);
  for (const point of points) await trendPoints.updateOne({ id: point.id }, { $set: point }, { upsert: true });
  await importBatches.updateOne({ id }, { $set: { id, migrationId, dataset, batch, status: 'completed', inserted: prepared.length, completedAt: new Date().toISOString() } }, { upsert: true });
  return { id, skipped: false, inserted: prepared.length };
}

export async function importLocalCurrentSnapshot({ migrationId, dataset, archiveId }: any) {
  if (typeof archiveId !== 'string' || !archiveId) throw new Error('导入的当前快照缺少归档标识。');
  const firstPart = await importedArchive.findOne({ archiveId });
  if (!firstPart) throw new Error('完整分析快照尚未归档完成。');
  const cloudMigration = { source: 'local', migrationId, dataset, importedAt: new Date().toISOString() };
  await importBaselines.updateOne({ id: 'current' }, { $set: { id: 'current', archiveId, cloudMigration } }, { upsert: true });
  await importBatches.updateOne({ id: `${migrationId}:${dataset}:current` }, { $set: { id: `${migrationId}:${dataset}:current`, migrationId, dataset, batch: 'current', status: 'completed', inserted: 1, completedAt: new Date().toISOString() } }, { upsert: true });
  return { archiveId };
}

// --- Darwin Skill architecture review workbench (cloud-resident) ---

export async function saveArchitectureReview({ skillId, review }: any) {
  if (typeof skillId !== 'string' || !skillId || !review?.architectureScore) throw new Error('独立评审记录缺少 Skill ID 或评分。');
  const stored = { id: skillId, skillId, review, importedAt: new Date().toISOString() };
  await architectureReviews.updateOne({ id: skillId }, { $set: stored }, { upsert: true });
  return { skillId, saved: true };
}

export async function loadArchitectureReviews() {
  const rows = await architectureReviews.find({}).sort({ skillId: 1 }).limit(500).toArray();
  return new Map(rows.map((row: any) => [row.skillId, plain(row).review]));
}

export async function saveDarwinReviewPlan({ skillId, plan }: any) {
  if (typeof skillId !== 'string' || !skillId || !plan) throw new Error('评审测试 Prompt 计划缺少 Skill ID 或内容。');
  const stored = { id: skillId, skillId, plan, updatedAt: new Date().toISOString() };
  await darwinReviewPlans.updateOne({ id: skillId }, { $set: stored }, { upsert: true });
  return plan;
}

export async function loadDarwinReviewPlans() {
  const rows = await darwinReviewPlans.find({}).sort({ skillId: 1 }).limit(500).toArray();
  return new Map(rows.map((row: any) => [row.skillId, plain(row).plan]));
}

export async function saveMulticaReviewJob({ issue, skills }: any) {
  if (!issue?.id) throw new Error('Multica 评审任务缺少 Issue ID。');
  const stored = { id: issue.id, issue, skills: Array.isArray(skills) ? skills : [], savedAt: new Date().toISOString() };
  await multicaReviewJobs.updateOne({ id: issue.id }, { $set: stored }, { upsert: true });
  return stored;
}

export async function loadMulticaReviewJobs() {
  const rows = await multicaReviewJobs.find({}).sort({ savedAt: -1 }).limit(200).toArray();
  return rows.map((row: any) => plain(row)).flatMap((row: any) => (row.skills ?? []).map((skill: any) => ({
    skillId: skill.id,
    skillName: skill.name,
    sourceUpdatedAt: skill.sourceUpdatedAt ?? null,
    plan: skill.plan ?? null,
    issue: { id: row.issue.id, identifier: row.issue.identifier ?? null, batchId: row.issue.batchId ?? null, url: row.issue.url ?? null, status: row.issue.status ?? 'todo' }
  })));
}

// --- 互动方案使用汇总 (interaction scheme usage) ---

export async function saveSchemeUsage(usage: any) {
  if (!usage || !Array.isArray(usage.schemes)) throw new Error('互动方案汇总数据缺少 schemes 列表。');
  const stored = {
    id: 'latest',
    generatedAt: usage.generatedAt ?? new Date().toISOString(),
    schemeCount: usage.schemeCount ?? usage.schemes.length,
    issuesAnalysed: usage.issuesAnalysed ?? 0,
    totalUseCount: usage.totalUseCount ?? usage.schemes.reduce((total: number, scheme: any) => total + Number(scheme.useCount ?? 0), 0),
    totalIssueCoverage: usage.totalIssueCoverage ?? usage.schemes.reduce((total: number, scheme: any) => total + Number(scheme.issueCount ?? scheme.issues?.length ?? 0), 0),
    schemes: usage.schemes,
    analysed: usage.analysed ?? [],
    savedAt: new Date().toISOString()
  };
  await schemeUsage.updateOne({ id: 'latest' }, { $set: stored }, { upsert: true });
  return { savedAt: stored.savedAt, schemeCount: stored.schemeCount, issuesAnalysed: stored.issuesAnalysed };
}

export async function loadSchemeUsage() {
  const row = await schemeUsage.findOne({ id: 'latest' });
  return row ? plain(row) : null;
}
