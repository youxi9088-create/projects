import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.env.RPG2_CLOUD_API_URL ?? 'https://f.new.ndhy.com/a/rpg2-health-monitor/api/import-local';
const migrationId = 'rpg2-line-history-v1';
const datasetPrefix = 'historical-line-evidence';
const targetSquadId = '00c28d20-adae-4905-aede-d492c89a474d';
const maxBatchBytes = 1_100_000;

function envToken() {
  const values = new Map();
  for (const line of fs.readFileSync(path.join(projectRoot, '.env.production'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  const token = process.env.RPG2_MIGRATION_TOKEN ?? values.get('RPG2_MIGRATION_TOKEN') ?? values.get('MULTICA_TOKEN');
  if (!token) throw new Error('未找到迁移令牌。');
  return token;
}

const migrationToken = envToken();

function shortText(value, limit = 600) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function json(value, fallback = {}) {
  if (!value || typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function compactResult(value) {
  const parsed = json(value, {});
  const source = parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed;
  return {
    output: shortText(source?.output ?? source?.content ?? source?.text ?? '', 700),
    user_visible_output: shortText(source?.user_visible_output ?? source?.userVisibleOutput ?? '', 700)
  };
}

function compactMessage(value) {
  const parsed = json(value, {});
  const rows = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.messages ?? [];
  return {
    items: rows.slice(0, 12).map((item) => ({
      type: item?.type,
      tool: item?.tool,
      content: shortText(item?.content, 800),
      text: shortText(item?.text, 800),
      input: item?.input?.skill ? { skill: shortText(item.input.skill, 180) } : undefined
    }))
  };
}

async function request(pathname = '', options = {}) {
  const response = await fetch(`${endpoint}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-rpg2-migration-token': migrationToken, ...(options.headers ?? {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error ?? '云端历史证据导入失败'}`);
  return data;
}

async function completed(dataset) {
  const result = await request(`?migrationId=${encodeURIComponent(migrationId)}&dataset=${encodeURIComponent(dataset)}`);
  return new Set(result.completedBatches ?? []);
}

async function send(dataset, evidenceType, batch, documents) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await request('', { method: 'POST', body: JSON.stringify({ kind: 'line-history', migrationId, dataset, evidenceType, batch, documents }) });
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

async function uploadRows(dataset, evidenceType, rows) {
  const done = await completed(dataset);
  let batch = 0;
  let imported = 0;
  let skipped = 0;
  let documents = [];
  let bytes = 0;
  async function flush() {
    if (!documents.length) return;
    if (done.has(batch)) skipped += documents.length;
    else imported += Number((await send(dataset, evidenceType, batch, documents)).inserted ?? 0);
    process.stdout.write(`\r${evidenceType}: 批次 ${batch + 1}，本批 ${documents.length} 条，已导入 ${imported} 条，已跳过 ${skipped} 条`);
    batch += 1;
    documents = [];
    bytes = 0;
  }
  for (const document of rows) {
    const size = Buffer.byteLength(JSON.stringify(document));
    if (documents.length && (documents.length >= 160 || bytes + size > maxBatchBytes)) await flush();
    documents.push(document);
    bytes += size;
  }
  await flush();
  process.stdout.write(`\n${evidenceType}: 完成，源记录 ${rows.length} 条。\n`);
}

const databaseFile = path.join(projectRoot, 'data', 'health.db');
if (!fs.existsSync(databaseFile)) throw new Error(`找不到历史数据库：${databaseFile}`);
const db = new DatabaseSync(databaseFile, { readOnly: true });
try {
  const runRows = db.prepare(`
    SELECT r.id, r.issue_id, r.agent_id, r.status, r.attempt, r.max_attempts, r.error,
      r.heartbeat_stage, r.heartbeat_summary, r.created_at, r.started_at, r.completed_at,
      r.last_heartbeat_at, r.result_json
    FROM runs r
    JOIN issues i ON i.id = r.issue_id
    WHERE i.assignee_type = 'squad' AND i.assignee_id = ?
    ORDER BY r.id
  `).all(targetSquadId);
  const runIds = runRows.map((row) => row.id);
  const runDocuments = runRows.map((row) => ({
    id: `history-run:${row.id}`,
    runId: row.id,
    issueId: row.issue_id,
    agentId: row.agent_id,
    value: {
      id: row.id, issue_id: row.issue_id, agent_id: row.agent_id, status: row.status,
      attempt: row.attempt, max_attempts: row.max_attempts, error: shortText(row.error, 500),
      heartbeat_stage: row.heartbeat_stage, heartbeat_summary: shortText(row.heartbeat_summary, 700),
      created_at: row.created_at, started_at: row.started_at, completed_at: row.completed_at,
      last_heartbeat_at: row.last_heartbeat_at, result: compactResult(row.result_json)
    }
  }));
  const messageRows = [];
  for (let index = 0; index < runIds.length; index += 900) {
    const placeholders = runIds.slice(index, index + 900).map(() => '?').join(',');
    messageRows.push(...db.prepare(`SELECT run_id, issue_id, raw_json FROM run_messages WHERE run_id IN (${placeholders}) ORDER BY run_id`).all(...runIds.slice(index, index + 900)));
  }
  const messageDocuments = messageRows.map((row) => ({
    id: `history-message:${row.run_id}`,
    runId: row.run_id,
    issueId: row.issue_id,
    value: compactMessage(row.raw_json)
  }));
  console.log(`准备导入历史生产线证据：${runDocuments.length} 条 Run、${messageDocuments.length} 条消息（仅直接指派目标小队的旧记录）。`);
  await uploadRows(`${datasetPrefix}-runs`, 'runs', runDocuments);
  await uploadRows(`${datasetPrefix}-messages`, 'messages', messageDocuments);
} finally {
  db.close();
}
