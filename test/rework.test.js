import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReworkCause, executionNode, findReworkIssues, reworkCandidateRuns, selectRecentTerminalProductionIssues } from '../src/rework.js';

function run({ id, issueId = 'issue-1', agentId = 'agent-1', agentName = '游戏编剧', status = 'running', stage = '03 游戏编剧 / S01.1', at = '2026-08-11T00:00:00Z', error = null } = {}) {
  return {
    id,
    issue_id: issueId,
    agent_id: agentId,
    status,
    error,
    trigger_summary: `请执行阶段「${stage}」。`,
    last_heartbeat_at: at,
    issueIdentifier: issueId === 'issue-1' ? 'RPG-1' : 'RPG-2',
    issueTitle: '颗粒生产',
    agentName
  };
}

test('同一 Issue、执行节点被激活或执行超过两次才识别为一个返工 Issue，所有 Run 状态参与', () => {
  const items = findReworkIssues([
    run({ id: '1', status: 'running', at: '2026-08-11T00:00:00Z' }),
    run({ id: '2', status: 'completed', at: '2026-08-11T01:00:00Z' }),
    run({ id: '3', status: 'cancelled', at: '2026-08-11T02:00:00Z' }),
    run({ id: '4', status: 'failed', at: '2026-08-11T03:00:00Z', error: '审核反馈：交付物缺少互动规则说明' }),
    run({ id: '5', issueId: 'issue-2', status: 'failed' }),
    run({ id: '6', issueId: 'issue-2', status: 'failed' }),
    run({ id: '7', agentId: 'agent-2', status: 'failed' })
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].identifier, 'RPG-1');
  assert.equal(items[0].taskCount, 5);
  assert.match(items[0].node, /阶段 03 游戏编剧/);
  assert.match(items[0].statusSummary, /running ×1/);
  assert.match(items[0].statusSummary, /completed ×1/);
  assert.match(items[0].statusSummary, /cancelled ×1/);
  assert.match(items[0].statusSummary, /failed ×2/);
  assert.equal(items[0].reworkNodes.length, 1);
  assert.equal(items[0].reworkNodes[0].reasonType, '执行失败');
  assert.match(items[0].reworkNodes[0].reasonEvidence, /审核反馈/);
});

test('近七天返工只以窗口内的 Run 次数判定，不把旧执行带入', () => {
  const since = '2026-08-10T00:00:00Z';
  const oldRuns = ['old-1', 'old-2', 'old-3'].map((id, index) => run({ id, at: `2026-08-0${7 + index}T00:00:00Z` }));
  const recentTwo = ['recent-1', 'recent-2'].map((id, index) => run({ id, at: `2026-08-1${0 + index}T01:00:00Z` }));
  assert.equal(findReworkIssues([...oldRuns, ...recentTwo], { since }).length, 0);

  const recentThird = run({ id: 'recent-3', at: '2026-08-12T01:00:00Z' });
  const items = findReworkIssues([...oldRuns, ...recentTwo, recentThird], { since });
  assert.equal(items.length, 1);
  assert.equal(items[0].taskCount, 3);
  assert.equal(items[0].firstAt, '2026-08-10T01:00:00Z');
});

test('返工窗口证据单独报告可识别的生产节点 Run', () => {
  const candidates = reworkCandidateRuns([
    run({ id: 'eligible', at: '2026-08-10T01:00:00Z' }),
    run({ id: 'old', at: '2026-08-01T01:00:00Z' }),
    { ...run({ id: 'route', at: '2026-08-10T01:00:00Z' }), agentName: '项目经理', trigger_summary: '请路由到阶段「03 游戏编剧 / S01.1」。' }
  ], { since: '2026-08-10T00:00:00Z' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].run.id, 'eligible');
});

test('工作区返工范围选择近七天终态且标题包含颗粒生产的 Issue', () => {
  const selected = selectRecentTerminalProductionIssues([
    { id: '635', title: '【颗粒生产】样例', status: 'done', updated_at: '2026-08-21T09:00:00Z' },
    { id: '636', title: '【颗粒生产】取消样例', status: 'cancelled', updated_at: '2026-08-20T09:00:00Z' },
    { id: 'old', title: '【颗粒生产】旧样例', status: 'done', updated_at: '2026-08-10T09:00:00Z' },
    { id: 'active', title: '【颗粒生产】运行中', status: 'in_progress', updated_at: '2026-08-22T09:00:00Z' },
    { id: 'other', title: '非生产复盘', status: 'done', updated_at: '2026-08-22T09:00:00Z' }
  ], { now: '2026-08-24T09:00:00Z' });
  assert.deepEqual(selected.map((issue) => issue.id), ['635', '636']);
});

test('缺少资产编号的阶段级生产节点仍可识别重复激活', () => {
  const items = findReworkIssues(['1', '2', '3'].map((id) => ({
    ...run({ id, stage: '06 游戏编导' }),
    trigger_summary: '请执行阶段「06 游戏编导」并完成返工修复。'
  })));
  assert.equal(items.length, 1);
  assert.equal(items[0].node, '阶段 06 游戏编导');
});

test('仅有生命周期心跳而缺少阶段节点时不认定为返工', () => {
  assert.equal(executionNode({ heartbeat_stage: 'completed', heartbeat_summary: 'Task completed' }), null);
});

test('阶段治理日志等泛文本不伪造生产节点', () => {
  assert.equal(executionNode({ result: { output: '阶段治理日志已生成，S01.1 产物已验证。' } }), null);
  assert.equal(executionNode({ result: { output: 'Stage 07 的 vid_s001 需要重新生成。' } }), '阶段 07');
});

test('返工按 Issue 和节点合并，不以单一 Agent 作为门槛', () => {
  const items = findReworkIssues([
    run({ id: 'a1', agentId: 'agent-a', agentName: '执行者 A', stage: '07 交付校验 / S07.1' }),
    run({ id: 'a2', agentId: 'agent-a', agentName: '执行者 A', stage: '07 交付校验 / S07.1' }),
    run({ id: 'b1', agentId: 'agent-b', agentName: '执行者 B', stage: '07 交付校验 / S07.1' })
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].reworkNodeCount, 1);
  assert.equal(items[0].reworkNodes[0].taskCount, 3);
  assert.equal(items[0].reworkNodes[0].involvedAgentCount, 2);
  assert.deepEqual(items[0].reworkNodes[0].agentNames, ['执行者 A', '执行者 B']);
});

test('正常 review 或验收完成文本不作为返工原因', () => {
  const items = findReworkIssues(['1', '2', '3'].map((id) => ({
    ...run({ id, stage: '08 质量校验 / S08.1' }),
    result: { output: 'quality review passed; acceptance completed' }
  })));

  assert.equal(items[0].reworkNodes[0].reasonType, '返工触发原因未采集');
});

test('项目经理的泛阶段路由不计入返工，具体产出节点的生产执行才计入', () => {
  const managerRoutes = ['pm-1', 'pm-2', 'pm-3', 'pm-4'].map((id) => run({
    id,
    agentId: 'pm',
    agentName: '项目经理',
    stage: '08 素材生产 / web_s032'
  }));
  const productionRuns = ['web-1', 'web-2', 'web-3'].map((id) => run({
    id,
    agentId: 'web-producer',
    agentName: 'Web互动生产专员',
    stage: '08 素材生产 / web_s032 修复并重构建'
  }));

  const items = findReworkIssues([...managerRoutes, ...productionRuns]);

  assert.equal(items.length, 1);
  assert.equal(items[0].taskCount, 3);
  assert.match(items[0].node, /web_s032/);
  assert.doesNotMatch(items[0].node, /^阶段 08$/);
});

test('孤立 feedback 和读取历史评论的工具输出不能归因为审核反馈', () => {
  const analysis = analyzeReworkCause([{
    trigger_summary: 'continue production execution',
    runMessages: JSON.stringify([
      { type: 'tool_result', output: 'historical issue comment: feedback received last month' },
      { type: 'text', content: 'I am checking the current output and will continue.' }
    ])
  }]);

  assert.equal(analysis.type, '返工触发原因未采集');
  assert.equal(analysis.confidence, '证据不足');
});

test('审核驳回必须有明确退回或驳回语义，且展示原始依据', () => {
  const analysis = analyzeReworkCause([{
    result: { output: '审核驳回：web_s032 缺少交互规则说明，请修复后重新构建。' }
  }]);

  assert.equal(analysis.type, '审核或验收反馈');
  assert.match(analysis.summary, /web_s032/);
  assert.match(analysis.evidenceExcerpt, /审核驳回/);
});
