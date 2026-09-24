import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { multicaJson } from '../src/multica.js';
import { findReworkIssues } from '../src/rework.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.env.RPG2_CLOUD_API_URL ?? 'https://f.new.ndhy.com/a/rpg2-health-monitor/api/import-local';
const migrationId = 'rpg2-rework-history-v1';
const dataset = 'historical-rework-nodes';

function migrationToken() {
  const values = new Map();
  for (const line of fs.readFileSync(path.join(projectRoot, '.env.production'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  const token = process.env.RPG2_MIGRATION_TOKEN ?? values.get('RPG2_MIGRATION_TOKEN') ?? values.get('MULTICA_TOKEN');
  if (!token) throw new Error('未找到迁移令牌。');
  return token;
}

async function request(pathname = '', options = {}) {
  const response = await fetch(`${endpoint}${pathname}`, { ...options, headers: { 'content-type': 'application/json', 'x-rpg2-migration-token': migrationToken(), ...(options.headers ?? {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error ?? '云端返工证据导入失败'}`);
  return data;
}

function compactNode(node) {
  return { ...node, reasonEvidence: String(node.reasonEvidence ?? '').slice(0, 1_200), reasonEvidenceExcerpt: String(node.reasonEvidenceExcerpt ?? '').slice(0, 480) };
}

const [squads, agents] = await Promise.all([multicaJson(['squad', 'list']), multicaJson(['agent', 'list'])]);
const target = (Array.isArray(squads) ? squads : []).find((item) => item.name === 'RPG互动教育游戏颗粒生产小队');
if (!target) throw new Error('未找到目标小队。');
const membersResponse = await multicaJson(['squad', 'member', 'list', target.id]);
const memberIds = new Set((Array.isArray(membersResponse) ? membersResponse : membersResponse.members ?? membersResponse.items ?? []).map((item) => item.agent_id ?? item.member_id ?? item.id).filter(Boolean));
const currentNames = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent.name]));
const db = new DatabaseSync(path.join(projectRoot, 'data', 'health.db'), { readOnly: true });
try {
  const rows = db.prepare(`SELECT r.*, i.identifier, i.title FROM runs r JOIN issues i ON i.id = r.issue_id WHERE i.assignee_type = ? AND i.assignee_id = ?`).all('squad', target.id);
  const messages = new Map(db.prepare('SELECT run_id, raw_json FROM run_messages').all().map((row) => [row.run_id, JSON.parse(row.raw_json)]));
  const runs = rows.filter((row) => memberIds.has(row.agent_id)).map((row) => ({ ...row, result: JSON.parse(row.result_json || '{}'), agentName: currentNames.get(row.agent_id) ?? row.agent_id, issueIdentifier: row.identifier, issueTitle: row.title, runMessages: messages.get(row.id) }));
  const documents = findReworkIssues(runs, { threshold: 3 }).flatMap((issue) => issue.reworkNodes.map((node) => ({
    id: `rework:${issue.issueId}:${Buffer.from(node.node).toString('base64url')}`,
    issueId: issue.issueId,
    identifier: issue.identifier,
    title: issue.title,
    value: compactNode(node)
  })));
  const existing = new Set((await request(`?migrationId=${encodeURIComponent(migrationId)}&dataset=${encodeURIComponent(dataset)}`)).completedBatches ?? []);
  if (!existing.has(0)) await request('', { method: 'POST', body: JSON.stringify({ kind: 'rework-history', migrationId, dataset, batch: 0, documents }) });
  console.log(`云端返工投影完成：${documents.length} 个节点、${new Set(documents.map((item) => item.issueId)).size} 个 Issue。`);
} finally {
  db.close();
}
