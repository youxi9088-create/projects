// daily-summary.js 纯函数单元测试（无数据库依赖）。
// 覆盖 shanghaiDayRange 时区边界与 buildDailyHealthSummary 的业务裁剪规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shanghaiDayRange, buildDailyHealthSummary } from '../src/daily-summary.js';

// UTC 2026-08-14T04:00:00Z === 上海 2026-08-14 12:00（用于固定“当日”锚点）
const NOW = new Date('2026-08-14T04:00:00Z');
const TODAY = '2026-08-14T03:00:00Z'; // 上海 11:00，落在范围内
const YESTERDAY = '2026-08-13T03:00:00Z'; // 上海 11:00，前一天

test('shanghaiDayRange 返回上海时区当日 00:00 至次日 00:00 的闭开区间', () => {
  const range = shanghaiDayRange(NOW);
  assert.equal(range.timezone, 'Asia/Shanghai');
  assert.equal(range.date, '2026-08-14');
  assert.equal(range.label, '8 月 14 日');
  // toISOString() 返回 UTC 表示：上海当日 00:00 === UTC 前一日 16:00
  assert.equal(range.startAt, '2026-08-13T16:00:00.000Z');
  assert.equal(range.endAt, '2026-08-14T16:00:00.000Z');
});

test('shanghaiDayRange 在 UTC 午夜边界正确切到上海次日', () => {
  // UTC 16:00 === 上海次日 00:00
  const range = shanghaiDayRange(new Date('2026-08-14T16:00:00Z'));
  assert.equal(range.date, '2026-08-15');
  // 该 UTC 时刻即上海次日 00:00，对应 UTC 8-14 16:00
  assert.equal(range.startAt, '2026-08-14T16:00:00.000Z');
  assert.equal(range.endAt, '2026-08-15T16:00:00.000Z');
});

test('shanghaiDayRange 拒绝无效时间锚点', () => {
  assert.throws(() => shanghaiDayRange(new Date('not-a-date')), /Invalid daily-summary time anchor/);
});

const baseSnapshot = {
  overview: { score: 82, warningCount: 3, criticalCount: 1, activeIssues: 5 },
  production: { blockedIssues: 2 },
  skills: { assessments: [{ id: 's-1', score: 60, confidence: 0.7 }] },
  agents: [{ id: 'a-1', score: 75, confidence: 0.8 }],
  incidents: [
    {
      id: 'inc-1', kind: 'production_blocked',
      issue: { id: 'i-1', identifier: 'RPG-1', title: '首屏阻塞' },
      analysis: { diagnosis: { node: '节点A', cause: '超阈值' }, confidence: 'high' },
      detail: '明细'
    },
    {
      id: 'inc-2', kind: 'stall',
      issue: { id: 'i-2', identifier: 'RPG-2', title: '停滞' },
      analysis: {}
    }
  ]
};

test('buildDailyHealthSummary 正确裁剪当日 Issue 流与 blockers', () => {
  const issues = [
    { id: 'i-new', identifier: 'RPG-NEW', title: '今日新建', created_at: TODAY, status: 'in_progress' },
    { id: 'i-old', identifier: 'RPG-OLD', title: '昨日新建', created_at: YESTERDAY, status: 'todo' },
    { id: 'i-done', identifier: 'RPG-DONE', title: '今日完成', created_at: YESTERDAY, status: 'done', updated_at: TODAY },
    { id: 'i-1', identifier: 'RPG-1', title: '首屏阻塞', created_at: YESTERDAY, status: 'blocked' }
  ];
  const completionEvents = [
    { issueId: 'i-done', previousStatus: 'in_progress', status: 'done', observedAt: TODAY },
    { issueId: 'i-1', previousStatus: 'blocked', status: 'done', observedAt: TODAY }
  ];
  const skills = [
    { id: 's-1', name: '技能A', description: '职责', created_at: TODAY, published_at: null },
    { id: 's-2', name: '技能B', description: '职责', created_at: YESTERDAY, published_at: TODAY }
  ];
  const agents = [{ id: 'a-1', name: '代理A', created_at: TODAY }];
  const reworkIssues = [{
    issueId: 'i-rw', identifier: 'RPG-RW', title: '返工单', node: '节点B', taskCount: 4, reworkNodeCount: 2,
    statusSummary: '多次重试',
    reworkNodes: [{ node: '节点B', taskCount: 4, statusSummary: '重试', reason: '不稳定', reasonType: 'flaky', reasonConfidence: '中', reasonSource: 'log', reasonEvidence: '证据文本' }]
  }];

  const result = buildDailyHealthSummary({ snapshot: baseSnapshot, issues, skills, agents, completionEvents, reworkIssues, now: NOW });

  assert.equal(result.schema, 'rpg2-daily-health-summary/v1');
  // 仅当日新建计入 started
  assert.equal(result.issueFlow.started.count, 1);
  assert.equal(result.issueFlow.started.items[0].id, 'i-new');
  // 两个完成事件均为已观测转移（exact），无 proxy
  assert.equal(result.issueFlow.completed.count, 2);
  assert.equal(result.issueFlow.completed.exactCount, 2);
  assert.equal(result.issueFlow.completed.proxyCount, 0);
  assert.match(result.issueFlow.completed.note, /本地监控已观测/);
  // 仅 production_blocked 类型进入 blockers
  assert.equal(result.blockers.count, 1);
  assert.equal(result.blockers.items[0].incidentId, 'inc-1');
  assert.equal(result.blockers.items[0].identifier, 'RPG-1');
  assert.equal(result.blockers.items[0].node, '节点A');
  assert.equal(result.blockers.items[0].cause, '超阈值');
  assert.equal(result.blockers.items[0].confidence, 'high');
  // capabilities 分类正确
  assert.equal(result.capabilities.createdSkills.count, 1);
  assert.equal(result.capabilities.createdSkills.items[0].id, 's-1');
  assert.equal(result.capabilities.publishedSkills.count, 1);
  assert.equal(result.capabilities.publishedSkills.items[0].id, 's-2');
  assert.equal(result.capabilities.createdAgents.count, 1);
  assert.equal(result.capabilities.createdAgents.items[0].id, 'a-1');
  // rework 透传与合并
  assert.equal(result.reworkIssues.threshold, 3);
  assert.equal(result.reworkIssues.count, 1);
  assert.equal(result.reworkIssues.items[0].issueId, 'i-rw');
  assert.equal(result.reworkIssues.items[0].reworkNodes[0].node, '节点B');
});

test('buildDailyHealthSummary 在缺少已观测转移时回退到 updated_at 代理完成', () => {
  const issues = [{ id: 'i-done', identifier: 'RPG-DONE', title: '今日完成', status: 'done', updated_at: TODAY }];
  const result = buildDailyHealthSummary({ snapshot: baseSnapshot, issues, skills: [], agents: [], completionEvents: [], reworkIssues: [], now: NOW });

  assert.equal(result.issueFlow.completed.count, 1);
  assert.equal(result.issueFlow.completed.exactCount, 0);
  assert.equal(result.issueFlow.completed.proxyCount, 1);
  assert.match(result.issueFlow.completed.note, /更新时间推定/);
});

test('buildDailyHealthSummary 对空输入不产生任何项', () => {
  const result = buildDailyHealthSummary({ snapshot: { overview: {}, production: {}, skills: {}, agents: [], incidents: [] }, issues: [], skills: [], agents: [], completionEvents: [], reworkIssues: [], now: NOW });
  assert.equal(result.issueFlow.started.count, 0);
  assert.equal(result.issueFlow.completed.count, 0);
  assert.equal(result.blockers.count, 0);
  assert.equal(result.capabilities.createdSkills.count, 0);
  assert.equal(result.reworkIssues.count, 0);
});
