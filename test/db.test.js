// db.js 单元测试（隔离库）。
// 运行方式：HEALTH_DATA_PATH=<临时库路径> node --test test/db.test.js
// 本文件在测试进程启动时依赖环境变量 HEALTH_DATA_PATH 指向一个临时 SQLite 库，
// 并在 before 钩子中清空可能从 legacy 库引导进来的真实快照/趋势数据，保证隔离。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  db, trendPointFromSnapshot, saveSnapshot, latestSnapshot,
  saveHealthTrendPoint, healthTrend, saveServiceCheck, recentCollections,
  beginCollection, finishCollection, saveSkillAudits, loadSkillAudits, backfillHealthTrendPoints
} from '../src/db.js';

before(() => {
  // 隔离：清空可能从 legacy 库引导进来的真实快照/趋势数据
  const conn = db();
  conn.prepare('DELETE FROM current_snapshot').run();
  conn.prepare('DELETE FROM health_trend_points').run();
});

test('trendPointFromSnapshot 正确映射概览/生产字段', () => {
  const p = trendPointFromSnapshot({
    overview: { score: 90, warningCount: 2, criticalCount: 1, activeIssues: 4 },
    production: { blockedIssues: 3 }
  });
  assert.equal(p.score, 90);
  assert.equal(p.blockedIssues, 3);
  assert.equal(p.warningCount, 2);
  assert.equal(p.criticalCount, 1);
  assert.equal(p.activeIssues, 4);
});

test('trendPointFromSnapshot 对缺失字段回退为 0', () => {
  const p = trendPointFromSnapshot({});
  assert.equal(p.score, 0);
  assert.equal(p.blockedIssues, 0);
  assert.equal(p.warningCount, 0);
  assert.equal(p.criticalCount, 0);
  assert.equal(p.activeIssues, 0);
});

test('saveSnapshot 与 latestSnapshot 往返一致', () => {
  const payload = { overview: { score: 88 }, production: { blockedIssues: 2 }, skills: { assessments: [] }, agents: [], incidents: [] };
  saveSnapshot(payload, '2026-08-14T04:00:00Z');
  const back = latestSnapshot();
  assert.ok(back);
  assert.deepEqual(back.overview, payload.overview);
});

test('healthTrend 仅返回窗口内趋势点并给出汇总结构', () => {
  const conn = db();
  conn.prepare('DELETE FROM health_trend_points').run();
  saveHealthTrendPoint({ overview: { score: 80, warningCount: 1, criticalCount: 0, activeIssues: 3 }, production: { blockedIssues: 1 } }, new Date().toISOString());
  saveHealthTrendPoint({ overview: { score: 70, warningCount: 5, criticalCount: 2, activeIssues: 9 }, production: { blockedIssues: 4 } }, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
  const trend = healthTrend(24);
  assert.equal(trend.windowHours, 24);
  assert.ok(Array.isArray(trend.points));
  assert.equal(trend.points.length, 1);
  assert.equal(trend.points[0].score, 80);
  assert.equal(trend.sourceSnapshots, 1);
});

test('saveServiceCheck 与 beginCollection/finishCollection 写入可读', () => {
  saveServiceCheck({ serviceName: 'multica', status: 'ok', latencyMs: 42, detail: 'ok', checkedAt: '2026-08-14T04:00:00Z' });
  const id = beginCollection('2026-08-14T04:00:00Z');
  finishCollection(id, { finishedAt: '2026-08-14T04:05:00Z', status: 'success', summary: { ok: true } });
  const cols = recentCollections(10);
  const c = cols.find((row) => row.id === id);
  assert.ok(c, '应能按 id 找到本次采集记录');
  assert.equal(c.status, 'success');
  assert.deepEqual(c.summary, { ok: true });
});

test('saveSkillAudits 与 loadSkillAudits 往返为 Map', () => {
  saveSkillAudits([{ skillId: 's-1', audit: { sourceUpdatedAt: '2026-08-14T04:00:00Z', auditedAt: '2026-08-14T04:00:00Z', foo: 1 } }]);
  const map = loadSkillAudits();
  assert.equal(map.get('s-1').foo, 1);
});

test('backfillHealthTrendPoints 从旧全快照回填趋势点', () => {
  const conn = db();
  conn.prepare('INSERT INTO snapshots (collected_at, payload_json) VALUES (?, ?)').run(
    '2026-08-10T04:00:00Z',
    JSON.stringify({ overview: { score: 65, warningCount: 1, criticalCount: 0, activeIssues: 2 }, production: { blockedIssues: 1 } })
  );
  const res = backfillHealthTrendPoints({ days: 30 });
  assert.ok(res.migrated >= 1, `应至少回填 1 个点，实际 ${res.migrated}`);
});
