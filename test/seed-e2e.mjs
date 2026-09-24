// 为前端 E2E 准备受控快照：写入一个临时 SQLite 库，供隔离测试实例读取。
// 必须在导入任何 src 模块前设置 HEALTH_DATA_PATH（config 在导入时冻结），故使用动态 import。
// 复用了 test/server.test.js 的快照构造逻辑，保证 /api/health 返回真实结构而非 null。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.HEALTH_DATA_PATH) {
  process.env.HEALTH_DATA_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'rpg2-e2e-')), 'health-live.db');
}
process.env.TARGET_SQUAD_NAME = process.env.TARGET_SQUAD_NAME ?? '__nonexistent_test_squad__';

const { db, saveSnapshot } = await import('../src/db.js');
const { buildHealthSnapshot } = await import('../src/health.js');

db(); // 建立表结构
const source = {
  workspace: { id: 'ws-test', name: '测试工作区', slug: 'test' },
  issueTotal: 2,
  issues: [
    { id: 'i-1', identifier: 'RPG-1', title: '【颗粒生产】生产单A', status: 'done', updated_at: '2026-08-10T00:10:00Z', metadata: {} },
    { id: 'i-2', identifier: 'RPG-2', title: '被阻塞的生产单', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: { blocked_reason: '等待素材服务恢复' } }
  ],
  agents: [{ id: 'a-1', name: '视频生产专员', status: 'working', model: 'm', skills: [{ id: 's-1' }] }],
  skills: [
    { id: 's-1', name: 'video-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' },
    { id: 's-2', name: 'asset-contract', has_draft: false, published_at: '2026-08-09T00:00:00Z' }
  ],
  runsByIssue: new Map([
    ['i-1', [{ id: 'r-1', issue_id: 'i-1', agent_id: 'a-1', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z', result: { output: 'video-skill 与 asset-contract 完成' } }]],
    ['i-2', [{ id: 'r-2', issue_id: 'i-2', agent_id: 'a-1', status: 'failed', error: 'provider timeout', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z' }]]
  ]),
  messagesByRun: new Map([
    ['r-1', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'video-skill' } }]],
    ['r-2', [{ content: '等待素材服务恢复后重试。' }]]
  ]),
  scope: { squadName: '测试小队', issueAssignmentRule: 'x' },
  performanceScope: { days: 7, titleMarker: '【颗粒生产】', issueIds: ['i-1'], issueCount: 1, windowStart: '2026-08-03T00:00:00Z' }
};
const options = {
  now: '2026-08-10T01:00:00Z',
  runTimeoutMs: 30 * 60_000,
  stallWarningMs: 2 * 3_600_000,
  stallCriticalMs: 4 * 3_600_000,
  lineNodeStallMs: 4 * 3_600_000,
  serviceChecks: [{ serviceName: 'Multica', status: 'healthy', checkedAt: '2026-08-10T01:00:00Z' }],
  skillEvaluations: []
};
saveSnapshot(buildHealthSnapshot(source, options), '2026-08-10T01:00:00Z');
console.log(`E2E_SEED_DB=${process.env.HEALTH_DATA_PATH}`);
