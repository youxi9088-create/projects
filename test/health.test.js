import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthSnapshot, refineBlockedIncidentEvidence } from '../src/health.js';
import { applyDarwinEvidence, auditSkillContent } from '../src/skill-audit.js';
import { parseArchitectureReview } from '../src/architecture-reviews.js';

function sourceFixture(overrides = {}) {
  const issue = { id: 'issue-1', identifier: 'RPG-1', title: '测试生产单', status: 'in_progress', updated_at: '2026-08-10T00:00:00Z', metadata: {} };
  const agent = { id: 'agent-1', name: '视频生产专员', status: 'working', model: 'model', skills: [] };
  const skill = { id: 'skill-1', name: 'video-skill', has_draft: true, published_at: null };
  return {
    workspace: { id: 'workspace-1', name: 'RPG2', slug: 'rpg2' },
    issueTotal: 1,
    issues: [issue],
    agents: [agent],
    skills: [skill],
    runsByIssue: new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'failed', error: 'InvalidParameter', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z', result: { output: 'called video-skill' } }]]]),
    messagesByRun: new Map([['run-1', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'video-skill' } }]]]),
    ...overrides
  };
}

const options = { now: '2026-08-10T01:00:00Z', runTimeoutMs: 30 * 60_000, stallWarningMs: 2 * 60 * 60_000, stallCriticalMs: 4 * 60 * 60_000, serviceChecks: [{ serviceName: 'Multica', status: 'healthy', checkedAt: '2026-08-10T01:00:00Z' }] };

test('识别失败和未发布 Skill，并标注日志识别调用量', () => {
  const snapshot = buildHealthSnapshot(sourceFixture(), options);
  assert.equal(snapshot.overview.status, 'warning');
  assert.ok(snapshot.incidents.some((incident) => incident.kind === 'task_failure'));
  assert.ok(snapshot.incidents.some((incident) => incident.kind === 'skill_unpublished'));
  assert.deepEqual(snapshot.skills.observedUsage[0].name, 'video-skill');
  assert.equal(snapshot.skills.observedUsage[0].observedCalls, 1);
});

test('run ownership follows the issue-runs collection key, not a mismatched embedded issue_id', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-active', identifier: 'RPG-479', title: 'active production', status: 'in_progress', updated_at: '2026-08-10T00:00:00Z', metadata: {} },
      { id: 'issue-blocked', identifier: 'RPG-478', title: 'blocked production', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: {} }
    ],
    runsByIssue: new Map([
      ['issue-active', [{
        id: 'run-cross-issue',
        // Stale metadata must not attach this active Issue run to RPG-478.
        issue_id: 'issue-blocked',
        agent_id: 'agent-1',
        status: 'completed',
        created_at: '2026-08-10T00:00:00Z',
        last_heartbeat_at: '2026-08-10T00:00:00Z',
        result: { output: 'native_audio_subtitle_v1 capability_preflight' }
      }]],
      ['issue-blocked', []]
    ]),
    messagesByRun: new Map([['run-cross-issue', []]])
  });
  const snapshot = buildHealthSnapshot(source, options);
  const blocked = snapshot.incidents.find((item) => item.kind === 'production_blocked');
  assert.equal(blocked.issue.identifier, 'RPG-478');
  assert.equal(blocked.run, null);
  assert.equal(blocked.analysis.coverage.find((item) => item.key === 'task_run').available, false);
  assert.equal(snapshot.incidents.some((item) => item.kind === 'production_blocked' && item.issue.identifier === 'RPG-479'), false);
});

test('one Issue is represented by only its highest-priority risk event', () => {
  const source = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-479', title: 'blocked production', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: {} }],
    runsByIssue: new Map([['issue-1', [{
      id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'failed', error: 'provider timeout',
      created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z'
    }]]]),
    messagesByRun: new Map([['run-1', []]])
  });
  const issueIncidents = buildHealthSnapshot(source, options).incidents.filter((incident) => incident.issue?.id === 'issue-1');
  assert.equal(issueIncidents.length, 1);
  assert.equal(issueIncidents[0].kind, 'production_blocked');
  assert.deepEqual(issueIncidents[0].relatedIncidents.map((incident) => incident.kind), ['task_failure']);
});

test('生产 Run 中的纯文本 Skill 名称不纳入 Skill 统计，只有显性 Skill 调用进入目录', () => {
  const source = sourceFixture({
    skills: [
      { id: 'skill-1', name: 'video-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' },
      { id: 'skill-2', name: 'asset-contract', has_draft: false, published_at: '2026-08-09T00:00:00Z' }
    ],
    runsByIssue: new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', trigger_summary: '请按 asset-contract 执行生产节点', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z' }]]]),
    messagesByRun: new Map([['run-1', []]])
  });
  const skills = buildHealthSnapshot(source, options).skills;
  const implicit = skills.assessments.find((skill) => skill.id === 'skill-2');
  assert.equal(skills.total, 0);
  assert.equal(skills.explicitObserved, 0);
  assert.equal(skills.implicitObserved, 0);
  assert.equal(implicit, undefined);
});

test('生产 Issue 状态分布只读取已进入小队直接指派采集范围的 Issue', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-1', identifier: 'RPG-1', title: '生产单', status: 'done', updated_at: '2026-08-10T00:00:00Z', metadata: {} },
      { id: 'issue-2', identifier: 'RPG-2', title: '生产单', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: {} }
    ],
    scope: { squadName: 'RPG互动教育游戏颗粒生产小队', issueAssignmentRule: 'assignee_type=squad && assignee_id=target-squad' }
  });
  const production = buildHealthSnapshot(source, options).production;
  assert.equal(production.productionIssueCount, 2);
  assert.deepEqual(production.issueStatusCounts, { done: 1, blocked: 1 });
});

test('识别长时间无推进与阻塞 Issue', () => {
  const blocked = sourceFixture({ issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '测试生产单', status: 'blocked', updated_at: '2026-08-09T00:00:00Z', metadata: { blocked_reason: '等待人工裁决' } }] });
  const snapshot = buildHealthSnapshot(blocked, options);
  assert.ok(snapshot.incidents.some((incident) => incident.kind === 'production_blocked'));
});

test('三次相同失败形成重复失败事件', () => {
  const repeated = sourceFixture({ runsByIssue: new Map([['issue-1', [1, 2, 3].map((attempt) => ({ id: `run-${attempt}`, issue_id: 'issue-1', agent_id: 'agent-1', status: 'failed', error: 'same error', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z' }))]]) });
  const snapshot = buildHealthSnapshot(repeated, options);
  assert.ok(snapshot.incidents.some((incident) => incident.kind === 'retry_loop'));
});

test('Agent health score separates score from evidence confidence', () => {
  const source = sourceFixture();
  source.issues[0].assignee_id = 'agent-1';
  source.skills[0].published_at = '2026-08-09T00:00:00Z';
  source.agents[0].skills = [{ id: 'skill-1' }];
  source.runsByIssue = new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z', result: { output: 'called video-skill' } }]]]);
  const agent = buildHealthSnapshot(source, options).agents[0];
  assert.equal(agent.score, 100);
  assert.equal(agent.confidence, 48);
  assert.equal(agent.status, 'healthy');
});

test('Agent 执行健康：timeout 计入失败、运行中 Run 只算覆盖不算失败', () => {
  // 近 7 天窗口（agentAnalysisLookbackMs）内：1 条 completed、1 条 timeout、1 条 running。
  const source = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '测试生产单', status: 'in_progress', updated_at: '2026-08-10T00:00:00Z', metadata: {} }],
    agents: [{ id: 'agent-1', name: '视频生产专员', status: 'working', model: 'model', skills: [] }],
    runsByIssue: new Map([['issue-1', [
      { id: 'run-done', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z', last_heartbeat_at: '2026-08-10T00:10:00Z' },
      { id: 'run-timeout', issue_id: 'issue-1', agent_id: 'agent-1', status: 'timeout', created_at: '2026-08-10T00:20:00Z', last_heartbeat_at: '2026-08-10T00:20:00Z' },
      { id: 'run-running', issue_id: 'issue-1', agent_id: 'agent-1', status: 'running', created_at: '2026-08-10T00:30:00Z', last_heartbeat_at: '2026-08-10T00:40:00Z' }
    ]]]),
    messagesByRun: new Map()
  });
  const agent = buildHealthSnapshot(source, options).agents[0];
  // 终态 = completed + timeout = 2；失败 = timeout = 1；running 不进成功率也不当失败。
  assert.equal(agent.recentRuns, 3);
  assert.equal(agent.failedRuns, 1);
  assert.equal(agent.reliability, 50);
  // 时间窗口使用有效发生时间（完成/心跳/开始/创建），completed_at 优先于 last_heartbeat_at。
  assert.equal(agent.analysisWindowHours, 24);
});

test('Agent 执行健康：仅有运行中 Run 的 Agent 不被记为失败', () => {
  const source = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '测试生产单', status: 'in_progress', updated_at: '2026-08-10T00:00:00Z', metadata: {} }],
    agents: [{ id: 'agent-1', name: '视频生产专员', status: 'working', model: 'model', skills: [] }],
    runsByIssue: new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'running', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:30:00Z' }]]]),
    messagesByRun: new Map()
  });
  const agent = buildHealthSnapshot(source, options).agents[0];
  assert.equal(agent.recentRuns, 1);
  assert.equal(agent.failedRuns, 0);
  assert.equal(agent.reliability, null);
});

test('Skill operational health remains separate from a missing Darwin full-content audit', () => {
  const source = sourceFixture();
  source.skills[0].published_at = '2026-08-09T00:00:00Z';
  source.agents[0].skills = [{ id: 'skill-1' }];
  source.runsByIssue = new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z', result: { output: 'called video-skill' } }]]]);
  const snapshot = buildHealthSnapshot(source, { ...options, skillEvaluations: [{ skillId: 'skill-1', suite: 'release-smoke', executedAt: '2026-08-10T00:30:00Z', passed: 8, total: 10, criticalFailures: 0 }] });
  const skill = snapshot.skills.assessments[0];
  assert.equal(skill.score, null);
  assert.equal(skill.operational.score, 92);
  assert.equal(skill.operational.confidence, 68);
  assert.equal(skill.regression.score, 80);
  assert.equal(skill.status, 'healthy');
});

test('Darwin audit uses recent granular-production terminal runs for performance', () => {
  const audit = auditSkillContent({
    updated_at: '2026-08-10T00:00:00Z',
    content: `---\nname: sample\ndescription: safe sample workflow\n---\n\n1. Read the input.\n2. Validate the result.\n3. Stop for user confirmation.\n\nIf validation fails, retry with a fallback.\n\nCHECKPOINT: user confirmation required.\n\nDo not overwrite files.`,
    files: []
  });
  const evaluated = applyDarwinEvidence(audit, {
    productionPerformance: {
      days: 7,
      titleMarker: '【颗粒生产】',
      issueCount: 2,
      terminalCalls: 5,
      successCalls: 4,
      failedCalls: 1,
      timeoutCalls: 1,
      successRate: 80,
      medianDurationMs: 120_000,
      medianDurationLabel: '2 分钟',
      sampleSufficient: true
    }
  });
  const architecture = evaluated.dimensions.find((dimension) => dimension.key === 'architecture');
  const performance = evaluated.dimensions.find((dimension) => dimension.key === 'performance');
  assert.equal(architecture.score, null);
  assert.equal(performance.score, 8);
  assert.equal(performance.evidence, 'recent_granular_production');
  assert.equal(evaluated.coverage, 88);
});

test('独立 Darwin 架构评审按 Skill ID 补全整体架构维度与加权覆盖', () => {
  const audit = auditSkillContent({
    content: '---\nname: sample\ndescription: production skill\n---\n\n1. Run.\n2. Validate.\n3. Stop.',
    files: []
  });
  const review = parseArchitectureReview(`# Darwin 架构评审：sample\n\n- Skill ID：\`skill-1\`\n\n| 维度 | 分数 | 依据 |\n|---|---:|---|\n| 整体架构 | 8 | 边界清晰。 |\n\n| ID | 优先级 | 问题 | 建议 | 验证 |\n|---|---|---|---|---|\n| P1-1 | P1 | 入口重复。 | 合并入口。 | 两个场景验证。 |`, { filePath: 'review.md' });
  const evaluated = applyDarwinEvidence(audit, { architectureReview: review });
  const architecture = evaluated.dimensions.find((dimension) => dimension.key === 'architecture');
  assert.equal(architecture.score, 8);
  assert.equal(architecture.evidence, 'independent_architecture_review');
  assert.equal(architecture.review.findings[0].id, 'P1-1');
  assert.equal(evaluated.coverage, 77);
});

test('Skill production performance only counts explicit evidence from recent granular-production Issues', () => {
  const source = sourceFixture();
  source.issues[0].title = '【颗粒生产】样例';
  source.skills[0].darwinAudit = auditSkillContent({
    content: '---\nname: video-skill\ndescription: production skill\n---\n\n1. Run.\n2. Validate.\n3. Stop.',
    files: []
  });
  source.performanceScope = { days: 7, titleMarker: '【颗粒生产】', issueIds: ['issue-1'], issueCount: 1, windowStart: '2026-08-03T01:00:00Z' };
  source.runsByIssue = new Map([['issue-1', [
    { id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:02:00Z', result: { output: 'video-skill' } },
    { id: 'run-2', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:03:00Z', result: { output: 'video-skill' } },
    { id: 'run-3', issue_id: 'issue-1', agent_id: 'agent-1', status: 'failed', error: 'timeout video-skill', created_at: '2026-08-10T00:00:00Z', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:04:00Z' }
  ]]]);
  source.messagesByRun = new Map(['run-1', 'run-2', 'run-3'].map((runId) => [runId, [{ type: 'tool_use', tool: 'Skill', input: { skill: 'video-skill' } }]]));
  const skill = buildHealthSnapshot(source, options).skills.assessments[0];
  assert.equal(skill.productionPerformance.successRate, 67);
  assert.equal(skill.productionPerformance.timeoutCalls, 1);
  assert.equal(skill.darwin.dimensions.find((dimension) => dimension.key === 'performance').evidence, 'recent_granular_production');
  assert.equal(skill.darwin.dimensions.find((dimension) => dimension.key === 'performance').score, 67);
});

test('Skill 实测覆盖计入非终态显式调用，但成功率只按终态 Run 计算', () => {
  const source = sourceFixture();
  source.issues[0].title = '【颗粒生产】样例';
  source.skills[0].darwinAudit = auditSkillContent({
    content: '---\nname: video-skill\ndescription: production skill\n---\n\n1. Run.\n2. Validate.\n3. Stop.',
    files: []
  });
  source.performanceScope = { days: 7, titleMarker: '【颗粒生产】', issueIds: ['issue-1'], issueCount: 1, windowStart: '2026-08-03T01:00:00Z' };
  source.runsByIssue = new Map([['issue-1', [
    { id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z' },
    { id: 'run-2', issue_id: 'issue-1', agent_id: 'agent-1', status: 'failed', error: 'timeout', created_at: '2026-08-10T00:01:00Z' },
    { id: 'run-3', issue_id: 'issue-1', agent_id: 'agent-1', status: 'running', created_at: '2026-08-10T00:02:00Z' },
    { id: 'run-4', issue_id: 'issue-1', agent_id: 'agent-1', status: 'in_progress', created_at: '2026-08-10T00:03:00Z' }
  ]]]);
  source.messagesByRun = new Map(['run-1', 'run-2', 'run-3', 'run-4'].map((runId) => [runId, [{ type: 'tool_use', tool: 'Skill', input: { skill: 'video-skill' } }]]));
  const performance = buildHealthSnapshot(source, options).skills.assessments[0].productionPerformance;
  assert.equal(performance.observedRuns, 4);
  assert.equal(performance.terminalCalls, 2);
  assert.equal(performance.nonTerminalCalls, 2);
  assert.equal(performance.successRate, 50);
  assert.equal(performance.sampleSufficient, false);
});

test('只有显性调用的生产 Skill 进入实测范围', () => {
  const source = sourceFixture({
    skills: [
      { id: 'skill-1', name: 'video-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' },
      { id: 'skill-2', name: 'unobserved-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' }
    ],
    runsByIssue: new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', trigger_summary: '按 unobserved-skill 处理后续生产', created_at: '2026-08-10T00:00:00Z' }]]]),
    messagesByRun: new Map([['run-1', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'video-skill' } }]]])
  });
  source.performanceScope = { days: 7, titleMarker: '【颗粒生产】', issueIds: ['issue-1'], issueCount: 1, windowStart: '2026-08-03T01:00:00Z' };
  const skills = buildHealthSnapshot(source, options).skills;
  assert.equal(skills.performanceEvaluation.scopeSkillCount, 1);
  assert.equal(skills.performanceEvaluation.observedSkillCount, 1);
  assert.equal(skills.performanceEvaluation.unobservedSkillCount, 0);
  assert.ok(skills.assessments.every((skill) => skill.id !== 'skill-2'));
});

test('Skill 目录纳入小队直接指派 Issue 中的全部显性调用，不限日期或标题', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-in-scope', identifier: 'RPG-1', title: '【颗粒生产】范围内', status: 'done', updated_at: '2026-08-10T00:00:00Z', metadata: {} },
      { id: 'issue-outside', identifier: 'RPG-2', title: '旧生产单', status: 'done', updated_at: '2026-08-10T00:00:00Z', metadata: {} }
    ],
    skills: [
      { id: 'skill-in', name: 'in-scope-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' },
      { id: 'skill-out', name: 'outside-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' }
    ],
    performanceScope: { kind: 'squad_direct_assignment_explicit_skill_calls', issueIds: ['issue-in-scope', 'issue-outside'], issueCount: 2, timeRange: 'all_retained_history' },
    runsByIssue: new Map([
      ['issue-in-scope', [{ id: 'run-in', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z' }, { id: 'run-old', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-01T00:00:00Z' }]],
      ['issue-outside', [{ id: 'run-out', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z' }]]
    ]),
    messagesByRun: new Map([
      ['run-in', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'in-scope-skill' } }]],
      ['run-old', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'outside-skill' } }]],
      ['run-out', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'outside-skill' } }]]
    ])
  });
  const skills = buildHealthSnapshot(source, options).skills;
  assert.deepEqual(skills.assessments.map((skill) => skill.name), ['in-scope-skill', 'outside-skill']);
});

test('全部关联 Skill 包含绑定但无显式调用的 Skill，total 为并集数量', () => {
  const source = sourceFixture({
    skills: [
      { id: 'skill-called', name: 'called-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' },
      { id: 'skill-bound', name: 'bound-only-skill', has_draft: true, published_at: null }
    ],
    agents: [{ id: 'agent-1', name: '视频生产专员', status: 'working', model: 'model', skills: [{ id: 'skill-bound' }, { id: 'skill-called' }] }]
  });
  source.runsByIssue = new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', created_at: '2026-08-10T00:00:00Z' }]]]);
  source.messagesByRun = new Map([['run-1', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'called-skill' } }]]]);
  const skills = buildHealthSnapshot(source, options).skills;
  // total = 绑定 Skill（bound-only + called）并集显式调用 Skill = 2；
  // called = 有显式调用证据的 = 1。
  assert.equal(skills.total, 2);
  assert.equal(skills.called, 1);
  const names = skills.assessments.map((skill) => skill.name);
  assert.ok(names.includes('called-skill'));
  assert.ok(names.includes('bound-only-skill'));
  const boundOnly = skills.assessments.find((skill) => skill.id === 'skill-bound');
  assert.equal(boundOnly.observedCalls, 0);
  assert.equal(boundOnly.boundAgentCount, 1);
  assert.equal(boundOnly.productionPerformance, null);
});

test('Agent 可使用保留 Run 的七天窗口进行可靠性分析', () => {
  const source = sourceFixture({
    runsByIssue: new Map([['issue-1', [{
      id: 'run-history', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed',
      created_at: '2026-08-05T00:00:00Z', last_heartbeat_at: '2026-08-05T00:00:00Z'
    }]]])
  });
  const agent = buildHealthSnapshot(source, { ...options, now: '2026-08-10T01:00:00Z', agentAnalysisLookbackMs: 7 * 86400000 }).agents[0];
  assert.equal(agent.recentRuns, 1);
  assert.equal(agent.reliability, 100);
  assert.equal(agent.analysisWindowHours, 168);
});

test('生产线 KPI 的业务分母包含全部完成单，但 Run 缺失时不产生不完整的数值', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-1', identifier: 'RPG-1', title: '一次性跑通', status: 'done', updated_at: '2026-08-10T00:10:00Z', metadata: {} },
      { id: 'issue-2', identifier: 'RPG-2', title: '一次阻断后完成', status: 'done', updated_at: '2026-08-10T00:20:00Z', metadata: {} },
      { id: 'issue-3', identifier: 'RPG-3', title: '没有运行记录', status: 'done', updated_at: '2026-08-10T00:20:00Z', metadata: {} }
    ],
    runsByIssue: new Map([
      ['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z' }]],
      ['issue-2', [
        { id: 'run-2a', issue_id: 'issue-2', agent_id: 'agent-1', status: 'failed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:05:00Z', result: { output: 'preflight decision=BLOCK_STAGE06' } },
        { id: 'run-2b', issue_id: 'issue-2', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:06:00Z', completed_at: '2026-08-10T00:20:00Z' }
      ]]
    ]),
    messagesByRun: new Map([['run-1', []], ['run-2a', []], ['run-2b', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.denominator, 3);
  assert.equal(line.onePassDenominator, 3);
  assert.equal(line.blockDenominator, 3);
  assert.equal(line.durationDenominator, 3);
  assert.equal(line.excludedWithoutRuns, 1);
  assert.equal(line.onePassCount, 1);
  assert.equal(line.onePassRate, null);
  assert.equal(line.blockedLineCount, 1);
  assert.deepEqual(line.onePassIssues.map((issue) => issue.identifier), ['RPG-1']);
  assert.equal(line.onePassIssues[0].durationLabel, '10 分钟');
  assert.equal(line.terminalLineCount, 3);
  assert.equal(line.terminalBlockOccurrences, 1);
  assert.equal(line.averageBlockOccurrences, null);
  assert.equal(line.averageDurationMs, null);
});

test('已完成但没有 completed Run 的 Issue 不进入一次性跑通明细', () => {
  const source = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '状态完成但执行未跑通', status: 'done', updated_at: '2026-08-10T00:20:00Z', metadata: {} }],
    runsByIssue: new Map([['issue-1', [
      { id: 'run-failed', issue_id: 'issue-1', agent_id: 'agent-1', status: 'failed', error: 'provider timeout', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z' }
    ]]]),
    messagesByRun: new Map([['run-failed', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.onePassDenominator, 1);
  assert.equal(line.completedRunBackedIssueCount, 0);
  assert.equal(line.onePassCount, 0);
  assert.deepEqual(line.onePassIssues, []);
});

test('生产节点失败后恢复执行，不论间隔是否超过四小时，都不算一次性跑通', () => {
  const source = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-802', title: '服务取消后继续的生产单', status: 'done', updated_at: '2026-08-10T01:20:00Z', metadata: {} }],
    runsByIssue: new Map([['issue-1', [
      { id: 'run-failed', issue_id: 'issue-1', agent_id: 'agent-1', kind: 'direct', status: 'failed', error: 'task cancelled by server', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:20:00Z' },
      { id: 'run-resumed', issue_id: 'issue-1', agent_id: 'agent-1', kind: 'comment', status: 'completed', started_at: '2026-08-10T00:40:00Z', completed_at: '2026-08-10T01:20:00Z', trigger_summary: '阶段 03 继续执行生产任务。' }
    ]]]),
    messagesByRun: new Map([['run-failed', []], ['run-resumed', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.onePassCount, 0);
  assert.equal(line.blockedLineCount, 1);
  assert.equal(line.executionInterruptionOccurrences, 1);
  assert.deepEqual(line.onePassIssues, []);
});

test('成功生产时长只取最后一个完成生产 Run，不混入此前失败尝试', () => {
  const source = sourceFixture({
    issues: [{ id: 'issue-976', identifier: 'RPG-976', title: '失败后恢复的颗粒生产', status: 'done', updated_at: '2026-09-03T22:26:22Z', metadata: {} }],
    runsByIssue: new Map([['issue-976', [
      { id: 'run-failed', issue_id: 'issue-976', agent_id: 'agent-1', status: 'failed', started_at: '2026-09-03T09:28:35Z', completed_at: '2026-09-03T15:50:51Z' },
      { id: 'run-success', issue_id: 'issue-976', agent_id: 'agent-1', status: 'completed', started_at: '2026-09-03T15:50:56Z', completed_at: '2026-09-03T21:43:28Z' },
      { id: 'run-review', issue_id: 'issue-976', agent_id: 'agent-1', kind: 'comment', status: 'completed', started_at: '2026-09-03T21:43:30Z', completed_at: '2026-09-03T22:26:22Z', trigger_summary: '完成后日志复盘治理。' }
    ]]]),
    messagesByRun: new Map([['run-failed', []], ['run-success', []], ['run-review', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.onePassCount, 0);
  assert.deepEqual(line.onePassIssues, []);
  assert.equal(line.durationSampleCount, 1);
  assert.equal(line.averageDurationMs, 21_152_000);
  assert.equal(line.averageDurationLabel, '5 小时 52 分钟');
  assert.equal(line.durationPopulation, 'done_final_completed_production_run');
});

test('完成后的复盘与项目经理收口失败不影响生产线一次性跑通', () => {
  const source = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '完成生产单', status: 'done', updated_at: '2026-08-10T01:00:00Z', metadata: {} }],
    runsByIssue: new Map([['issue-1', [
      { id: 'run-production', issue_id: 'issue-1', agent_id: 'agent-1', kind: 'comment', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:30:00Z', trigger_summary: '阶段 05 生产交付完成。' },
      { id: 'run-review', issue_id: 'issue-1', agent_id: 'agent-1', kind: 'comment', status: 'failed', error: 'task cancelled by server', started_at: '2026-08-10T00:40:00Z', completed_at: '2026-08-10T01:00:00Z', trigger_summary: '完成后日志复盘治理。' }
    ]]]),
    messagesByRun: new Map([['run-production', []], ['run-review', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.onePassCount, 1);
  assert.equal(line.blockedLineCount, 0);
  assert.equal(line.executionInterruptionOccurrences, 0);
});

test('运行态节点超过四小时未推进按一次生产线阻断计入', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-1', identifier: 'RPG-1', title: '无阻断完成', status: 'done', updated_at: '2026-08-10T01:00:00Z', metadata: {} },
      { id: 'issue-2', identifier: 'RPG-2', title: '节点无推进后完成', status: 'done', updated_at: '2026-08-10T01:00:00Z', metadata: {} }
    ],
    runsByIssue: new Map([
      ['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z' }]],
      ['issue-2', [
        { id: 'run-2a', issue_id: 'issue-2', agent_id: 'agent-1', status: 'running', started_at: '2026-08-09T19:00:00Z', last_heartbeat_at: '2026-08-09T20:30:00Z' },
        { id: 'run-2b', issue_id: 'issue-2', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:40:00Z', completed_at: '2026-08-10T00:50:00Z' }
      ]]
    ]),
    messagesByRun: new Map([['run-1', []], ['run-2a', []], ['run-2b', []]])
  });
  const line = buildHealthSnapshot(source, { ...options, lineNodeStallMs: 4 * 60 * 60_000 }).production.linePerformance;
  assert.equal(line.onePassCount, 1);
  assert.equal(line.onePassRate, 50);
  assert.equal(line.averageBlockOccurrences, 0.5);
  assert.equal(line.stalledNodeOccurrences, 1);
  assert.equal(line.explicitBlockOccurrences, 0);
});

test('项目经理明确等待具名人工决策会排除一次性跑通', () => {
  const source = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '需人工裁决的生产单', status: 'done', updated_at: '2026-08-10T02:00:00Z', metadata: {} }],
    runsByIssue: new Map([['issue-1', [
      { id: 'run-pm', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z', result: { output: '状态：阻塞（需人工决策）。项目经理已升级人工决策人 吴林金；恢复条件为人工复验通过后再继续。' } },
      { id: 'run-audio', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:20:00Z', completed_at: '2026-08-10T00:30:00Z' }
    ]]]),
    messagesByRun: new Map([['run-pm', []], ['run-audio', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.onePassCount, 0);
  assert.equal(line.averageBlockOccurrences, 1);
  assert.equal(line.humanDecisionOccurrences, 1);
  assert.deepEqual(line.onePassIssues, []);
});

test('取消的生产线即使没有 Run 也纳入终态分母，但阻断均值等待历史 Run 补齐', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-1', identifier: 'RPG-1', title: '一次性完成', status: 'done', updated_at: '2026-08-10T00:10:00Z', metadata: {} },
      { id: 'issue-2', identifier: 'RPG-2', title: '已取消', status: 'cancelled', updated_at: '2026-08-10T00:20:00Z', metadata: {} }
    ],
    runsByIssue: new Map([['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z' }]]]),
    messagesByRun: new Map([['run-1', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.denominator, 2);
  assert.equal(line.cancelledIssueCount, 1);
  assert.equal(line.onePassCount, 1);
  assert.equal(line.cancellationOccurrences, 1);
  assert.equal(line.onePassRate, 100);
  assert.equal(line.blockedLineCount, 1);
  assert.equal(line.onePassCount + line.blockedLineCount, line.denominator);
  assert.equal(line.terminalLineCount, 2);
  assert.equal(line.terminalBlockOccurrences, 1);
  assert.equal(line.averageBlockOccurrences, null);
  assert.equal(line.metricStatus.blockAverage, 'insufficient_run_history');
});

test('没有任何完成生产线 Run 时不把取消单折算为生产线 KPI', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-1', identifier: 'RPG-1', title: '完成但无 Run', status: 'done', updated_at: '2026-08-10T00:10:00Z', metadata: {} },
      { id: 'issue-2', identifier: 'RPG-2', title: '已取消', status: 'cancelled', updated_at: '2026-08-10T00:20:00Z', metadata: {} }
    ],
    runsByIssue: new Map(),
    messagesByRun: new Map()
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.calculationStatus, 'insufficient_run_history');
  assert.equal(line.runBackedCompletedIssueCount, 0);
  assert.equal(line.onePassRate, null);
  assert.equal(line.averageBlockOccurrences, null);
  assert.equal(line.averageDurationMs, null);
});

test('已取消生产线不参与平均生产时长', () => {
  const source = sourceFixture({
    issues: [
      { id: 'issue-1', identifier: 'RPG-1', title: '完成', status: 'done', updated_at: '2026-08-10T00:10:00Z', metadata: {} },
      { id: 'issue-2', identifier: 'RPG-2', title: '取消', status: 'cancelled', updated_at: '2026-08-10T02:00:00Z', metadata: {} }
    ],
    runsByIssue: new Map([
      ['issue-1', [{ id: 'run-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z' }]],
      ['issue-2', [{ id: 'run-2', issue_id: 'issue-2', agent_id: 'agent-1', status: 'failed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T01:50:00Z' }]]
    ]),
    messagesByRun: new Map([['run-1', []], ['run-2', []]])
  });
  const line = buildHealthSnapshot(source, options).production.linePerformance;
  assert.equal(line.denominator, 2);
  assert.equal(line.durationSampleCount, 1);
  assert.equal(line.averageDurationMs, 600_000);
  assert.equal(line.durationPopulation, 'done_final_completed_production_run');
});

test('审核中 Issue 独立进入审核队列，不构成重要风险或无推进告警', () => {
  const review = sourceFixture({ issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '审核中的生产单', status: 'in_review', updated_at: '2026-08-01T00:00:00Z', metadata: {} }] });
  const snapshot = buildHealthSnapshot(review, options);
  assert.equal(snapshot.production.reviewCount, 1);
  assert.equal(snapshot.incidents.some((incident) => incident.kind === 'no_progress'), false);
  assert.equal(snapshot.incidents.some((incident) => incident.kind === 'production_blocked'), false);
  assert.equal(snapshot.overview.criticalCount, 0);
});

test('阻塞事件保留对应 Agent 的执行链，而不是只显示报错文本', () => {
  const blocked = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '被阻塞的生产单', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: { blocked_reason: '等待素材服务恢复' } }],
    messagesByRun: new Map([['run-1', [{ content: '等待素材服务恢复后重试，当前依赖不可用。' }]]])
  });
  const snapshot = buildHealthSnapshot(blocked, options);
  const incident = snapshot.incidents.find((item) => item.kind === 'production_blocked');
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.analysis.agentName, '视频生产专员');
  assert.equal(incident.analysis.schema, 'rpg-blocker-evidence/v1');
  assert.equal(incident.analysis.conclusion.state, 'confirmed');
  assert.equal(incident.analysis.candidate.kind, 'dependency_or_wait');
  assert.equal(incident.analysis.confidenceDetail.chain, 'high');
  assert.equal(incident.analysis.coverage.find((item) => item.key === 'run_message').available, true);
  assert.ok(incident.analysis.recoveryPlan.length >= 1);
  assert.ok(incident.analysis.reasons.some((reason) => reason.kind === 'workflow_state'));
  assert.ok(incident.analysis.reasons.some((reason) => reason.kind === 'execution_chain'));
  assert.ok(incident.evidence.some((line) => line.startsWith('执行 Agent：')));
});

test('阻塞分析从全部运行消息提炼 Stage 门禁卡点和具体修改动作', () => {
  const blocked = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '门禁阻塞的生产单', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: {} }],
    messagesByRun: new Map([['run-1', [{ content: 'Stage 06 已复跑 Stage 06→07 preflight 门禁；preflight decision=BLOCK_STAGE06。根因确认：skill-level 互斥约束，非交付物缺陷。唯一未过项 web_same_instance_rehydration，bind_existing 缺少 prerequisite:semantic_test_fixture。' }]]])
  });
  const snapshot = buildHealthSnapshot(blocked, options);
  const incident = snapshot.incidents.find((item) => item.kind === 'production_blocked');
  assert.equal(incident.analysis.diagnosis.node, 'Stage 06→07 preflight 门禁');
  assert.match(incident.analysis.diagnosis.cause, /Skill-level 互斥约束/);
  assert.equal(incident.analysis.diagnosis.confidence, 'high');
  assert.match(incident.analysis.recoveryPlan[0].action, /web_same_instance_rehydration/);
  assert.match(incident.analysis.recoveryPlan[1].action, /prerequisite:semantic_test_fixture/);
});

test('已结束 Task 会转换为执行角色、生产节点和具体审核门禁', () => {
  const taskId = '0de87e21-c49a-4bc7-8dfb-2639395f0e80';
  const blocked = sourceFixture({
    issues: [{
      id: 'issue-1', identifier: 'RPG-287', title: '无标点字幕 canary', status: 'blocked', updated_at: '2026-08-10T00:00:00Z',
      metadata: { blocked_reason: 'native_audio_post_burned_delivery_gate sha256-lock lags draft gate; dependency hash mismatch; needs protocol skill owner to re-pin the lock.' }
    }],
    runsByIssue: new Map([['issue-1', [{
      id: taskId, issue_id: 'issue-1', agent_id: 'agent-1', status: 'completed', heartbeat_stage: 'completed',
      created_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z', last_heartbeat_at: '2026-08-10T00:10:00Z',
      result: { output: 'native_audio_subtitle_v1 finished; visual gate passed.' }
    }]]]),
    messagesByRun: new Map([[taskId, [{ content: '/project-output/RPG-287/07-素材生产/video-production/per-node/S02.2/ native_audio_post_burned_delivery_gate' }]]])
  });
  const incident = buildHealthSnapshot(blocked, options).incidents.find((item) => item.kind === 'production_blocked');
  assert.equal(incident.analysis.executionContext.nodeLabel, '视频生产专员 · 07-素材生产 / S02.2（native_audio_subtitle_v1）');
  assert.equal(incident.analysis.diagnosis.node, '视频生产专员 · 07-素材生产 / S02.2（native_audio_subtitle_v1） · 字幕成片交付双重验证门禁');
  assert.match(incident.analysis.recoveryPlan[0].owner, /交付协议 Skill 负责人/);
  assert.match(incident.analysis.recoveryPlan[0].action, /重新固定锁/);
});

test('缺少 Task 和运行消息时只确认阻塞事实，不虚构根因', () => {
  const blocked = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-1', title: '缺少执行证据的阻塞单', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: {} }],
    runsByIssue: new Map(),
    messagesByRun: new Map()
  });
  const snapshot = buildHealthSnapshot(blocked, options);
  const incident = snapshot.incidents.find((item) => item.kind === 'production_blocked');
  assert.equal(incident.analysis.conclusion.state, 'confirmed');
  assert.equal(incident.analysis.candidate.kind, 'missing_causal_evidence');
  assert.equal(incident.analysis.confidenceDetail.chain, 'low');
  assert.equal(incident.analysis.coverage.find((item) => item.key === 'task_run').available, false);
  assert.equal(incident.analysis.coverage.find((item) => item.key === 'run_message').available, false);
});

test('refineBlockedIncidentEvidence 用合并历史证据替换实时缺证据的阻塞分析', () => {
  // 实时 source 没有该 Issue 的 Run/消息：第一轮快照只能给出低置信占位。
  const realtime = sourceFixture({
    issues: [{ id: 'issue-1', identifier: 'RPG-200', title: '化学概念颗粒', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: {} }],
    runsByIssue: new Map(),
    messagesByRun: new Map()
  });
  const snapshot = buildHealthSnapshot(realtime, options);
  const before = snapshot.incidents.find((item) => item.kind === 'production_blocked');
  assert.equal(before.analysis.confidenceDetail.chain, 'low');
  assert.equal(before.analysis.coverage.find((item) => item.key === 'task_run').available, false);

  // 历史证据合并进 lineSource 后，只重算阻塞证据链，不重算其他实时风险。
  const historicalRun = {
    id: 'run-hist-1', issue_id: 'issue-1', agent_id: 'agent-1', status: 'blocked',
    heartbeat_stage: 'Stage 07', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:30:00Z',
    heartbeat_summary: 'preflight decision=BLOCK_STAGE07；等待人工确认交付物。'
  };
  const lineSource = {
    ...realtime,
    runsByIssue: new Map([['issue-1', [historicalRun]]]),
    messagesByRun: new Map([['run-hist-1', [{ content: 'Stage 06 已复跑 Stage 06→07 preflight 门禁；preflight decision=BLOCK_STAGE07。根因确认：等待人工确认交付物。' }]]])
  };
  const refined = refineBlockedIncidentEvidence(snapshot, lineSource, new Map(realtime.agents.map((agent) => [agent.id, agent])), Date.parse('2026-08-10T01:00:00Z'));
  assert.equal(refined.length, 1);
  assert.equal(refined[0].issueId, 'issue-1');
  assert.equal(refined[0].hasRun, true);
  assert.equal(refined[0].confidence, 'high');

  const after = snapshot.incidents.find((item) => item.kind === 'production_blocked');
  assert.equal(after.run?.id, 'run-hist-1');
  assert.equal(after.analysis.confidenceDetail.chain, 'high');
  assert.equal(after.analysis.coverage.find((item) => item.key === 'task_run').available, true);
  assert.equal(after.analysis.coverage.find((item) => item.key === 'run_message').available, true);
  assert.equal(after.analysis.executionContext.taskId, 'run-hist-1');
  // 非阻塞风险不被历史数据重算：仍保持实时快照状态。
  assert.equal(snapshot.incidents.filter((item) => item.kind === 'production_blocked').length, 1);
});
