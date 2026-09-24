import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationId = 'rpg2-local-history-v1';
const endpoint = process.env.RPG2_CLOUD_API_URL ?? 'https://f.new.ndhy.com/a/rpg2-health-monitor/api/import-local';
const maxBatchBytes = 1_250_000;
const maxArchivePayloadChars = 20_000;

function loadProductionEnv() {
  const file = path.join(projectRoot, '.env.production');
  const values = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  const token = process.env.RPG2_MIGRATION_TOKEN ?? values.get('RPG2_MIGRATION_TOKEN') ?? values.get('MULTICA_TOKEN');
  if (!token) throw new Error('未找到迁移令牌；请在 .env.production 配置 RPG2_MIGRATION_TOKEN 或 MULTICA_TOKEN。');
  return token;
}

const migrationToken = loadProductionEnv();

function archiveDocument(source, table, row) {
  const rowId = String(row.__archive_rowid__);
  delete row.__archive_rowid__;
  const json = JSON.stringify(row);
  const archiveId = `${source}:${table}:${rowId}`;
  const payload = gzipSync(json).toString('base64');
  const partCount = Math.ceil(payload.length / maxArchivePayloadChars);
  return Array.from({ length: partCount }, (_, partIndex) => ({
    id: partCount === 1 ? archiveId : `${archiveId}:part:${partIndex + 1}`,
    archiveId,
    source,
    table,
    rowId,
    partIndex,
    partCount,
    encoding: 'gzip-base64',
    payload: payload.slice(partIndex * maxArchivePayloadChars, (partIndex + 1) * maxArchivePayloadChars),
    rawBytes: Buffer.byteLength(json)
  }));
}

async function request(pathname = '', options = {}) {
  const response = await fetch(`${endpoint}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-rpg2-migration-token': migrationToken,
      ...(options.headers ?? {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error ?? '云端迁移接口请求失败'}`);
  return data;
}

async function completedBatches(dataset) {
  const data = await request(`?migrationId=${encodeURIComponent(migrationId)}&dataset=${encodeURIComponent(dataset)}`);
  return new Set(data.completedBatches ?? []);
}

async function sendBatch(kind, dataset, batch, documents) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await request('', { method: 'POST', body: JSON.stringify({ kind, migrationId, dataset, batch, documents }) });
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

function sqlIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function migrateArchiveTable(source, file, table) {
  const dataset = `archive-${source}-${table}`;
  const completed = await completedBatches(dataset);
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare(`SELECT rowid AS __archive_rowid__, * FROM ${sqlIdentifier(table)} ORDER BY rowid ASC`).iterate();
  let batch = 0;
  let total = 0;
  let skipped = 0;
  let documents = [];
  let bytes = 0;
  async function flush() {
    if (!documents.length) return;
    if (completed.has(batch)) skipped += documents.length;
    else {
      const result = await sendBatch('archive', dataset, batch, documents);
      total += Number(result.inserted ?? 0);
    }
    process.stdout.write(`\r${dataset}: 批次 ${batch + 1}，本批 ${documents.length} 条，已迁移 ${total} 条，已跳过 ${skipped} 条`);
    batch += 1;
    documents = [];
    bytes = 0;
  }
  try {
    for (const row of rows) {
      for (const document of archiveDocument(source, table, row)) {
        const size = Buffer.byteLength(JSON.stringify(document));
        if (documents.length && (documents.length >= 160 || bytes + size > maxBatchBytes)) await flush();
        documents.push(document);
        bytes += size;
      }
    }
    await flush();
  } finally {
    db.close();
  }
  process.stdout.write(`\n${dataset}: 完成。\n`);
}

function sourceTables(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name").all().map((row) => row.name);
  } finally {
    db.close();
  }
}

async function migrateTrends(files) {
  const dataset = 'materialized-trends';
  const completed = await completedBatches(dataset);
  const byCollectedAt = new Map();
  for (const { file, source } of files) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of db.prepare('SELECT collected_at, score, blocked_issues, warning_count, critical_count, active_issues FROM health_trend_points ORDER BY collected_at ASC').iterate()) {
        byCollectedAt.set(row.collected_at, { source, ...row });
      }
    } finally {
      db.close();
    }
  }
  const documents = [...byCollectedAt.values()].sort((left, right) => left.collected_at.localeCompare(right.collected_at)).map((row) => ({
    id: `local:${row.collected_at}`,
    collectedAt: row.collected_at,
    source: row.source,
    snapshot: {
      overview: { score: row.score, warningCount: row.warning_count, criticalCount: row.critical_count, activeIssues: row.active_issues },
      production: { blockedIssues: row.blocked_issues }
    }
  }));
  let batch = 0;
  for (let index = 0; index < documents.length; index += 500) {
    const chunk = documents.slice(index, index + 500);
    if (!completed.has(batch)) await sendBatch('trend', dataset, batch, chunk);
    batch += 1;
  }
  console.log(`${dataset}: ${documents.length} 个历史趋势点已完成。`);
}

async function migrateCurrentSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT rowid AS __archive_rowid__ FROM current_snapshot WHERE id = 1').get();
    if (!row) throw new Error('本地历史数据库不存在 current_snapshot。');
    const archiveId = `health-db:current_snapshot:${row.__archive_rowid__}`;
    const result = await request('', { method: 'POST', body: JSON.stringify({ kind: 'current-snapshot', migrationId, dataset: 'current-analysis-baseline', archiveId }) });
    console.log(`current-analysis-baseline: 已启用完整分析快照归档 ${result.archiveId}。`);
  } finally {
    db.close();
  }
}

const sources = [
  { source: 'health-db', file: path.join(projectRoot, 'data', 'health.db') },
  { source: 'health-live-db', file: path.join(projectRoot, 'data', 'health-live.db') }
];

for (const source of sources) {
  if (!fs.existsSync(source.file)) throw new Error(`找不到本地数据库：${source.file}`);
  for (const table of sourceTables(source.file)) await migrateArchiveTable(source.source, source.file, table);
}
await migrateTrends(sources);
await migrateCurrentSnapshot(path.join(projectRoot, 'data', 'health.db'));
console.log('本地历史数据已迁移到云端归档；本地数据库未删除。');
