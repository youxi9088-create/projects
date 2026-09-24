const SHANGHAI_OFFSET = '+08:00';
const DAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value, max = 180) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized;
}

function fullText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function datePartsInShanghai(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function shanghaiDayRange(now = new Date()) {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) throw new Error('Invalid daily-summary time anchor.');
  const { year, month, day } = datePartsInShanghai(instant);
  const date = `${year}-${month}-${day}`;
  const start = new Date(`${date}T00:00:00${SHANGHAI_OFFSET}`);
  const end = new Date(start.getTime() + DAY_MS);
  return {
    date,
    label: `${Number(month)} 月 ${Number(day)} 日`,
    timezone: 'Asia/Shanghai',
    startAt: start.toISOString(),
    endAt: end.toISOString()
  };
}

function fallsInRange(value, range) {
  const at = timestamp(value);
  return at >= timestamp(range.startAt) && at < timestamp(range.endAt);
}

function issueItem(issue, extra = {}) {
  return {
    id: issue.id,
    identifier: issue.identifier ?? issue.id,
    title: text(issue.title, 130) || '未命名 Issue',
    ...extra
  };
}

function sortNewest(items, field) {
  return [...items].sort((left, right) => timestamp(right[field]) - timestamp(left[field]));
}

function capabilityItem(item, assessment, type) {
  const purpose = text(item.description || item.instructions, 160) || '平台未提供职责说明。';
  return {
    id: item.id,
    name: item.name || item.id,
    purpose,
    score: assessment?.score ?? null,
    scoreLabel: type === 'skill' ? 'Darwin 对齐评分' : 'Agent 健康度',
    confidence: assessment?.confidence ?? null,
    publishedAt: item.published_at ?? null,
    createdAt: item.created_at ?? null
  };
}

function blockerItem(incident) {
  const diagnosis = incident.analysis?.diagnosis;
  return {
    incidentId: incident.id,
    id: incident.issue?.id ?? incident.id,
    identifier: incident.issue?.identifier ?? incident.issue?.id ?? '未关联 Issue',
    title: text(incident.issue?.title, 130) || '未命名生产单',
    node: text(diagnosis?.node, 100) || '待补充执行链定位',
    cause: text(diagnosis?.cause || incident.detail, 180) || '尚未采集到可解释原因。',
    confidence: diagnosis?.confidence ?? incident.analysis?.confidence ?? 'low'
  };
}

/**
 * Builds a UI-ready daily operating brief from current source rows plus the
 * health snapshot. Completion events are authoritative only after the local
 * monitor has observed a status transition; a same-day `done.updated_at`
 * fallback is explicitly labelled as a proxy.
 */
export function buildDailyHealthSummary({
  snapshot,
  issues = [],
  skills = [],
  agents = [],
  completionEvents = [],
  reworkIssues = [],
  includeFullReworkEvidence = false,
  now = new Date()
}) {
  const range = shanghaiDayRange(now);
  const skillAssessments = new Map((snapshot?.skills?.assessments ?? []).map((item) => [item.id, item]));
  const agentAssessments = new Map((snapshot?.agents ?? []).map((item) => [item.id, item]));
  const issuesById = new Map(issues.map((item) => [item.id, item]));

  const started = sortNewest(issues
    .filter((issue) => fallsInRange(issue.created_at, range))
    .map((issue) => issueItem(issue, { occurredAt: issue.created_at })), 'occurredAt');

  const exactCompletion = completionEvents
    .filter((event) => event.status === 'done' && event.previousStatus !== 'done' && fallsInRange(event.observedAt, range))
    .map((event) => {
      const issue = issuesById.get(event.issueId);
      return issue ? issueItem(issue, { occurredAt: event.observedAt, source: 'observed_transition' }) : null;
    })
    .filter(Boolean);
  const exactIds = new Set(exactCompletion.map((item) => item.id));
  const proxyCompletion = issues
    .filter((issue) => issue.status === 'done' && fallsInRange(issue.updated_at, range) && !exactIds.has(issue.id))
    .map((issue) => issueItem(issue, { occurredAt: issue.updated_at, source: 'updated_at_proxy' }));
  const completed = sortNewest([...exactCompletion, ...proxyCompletion], 'occurredAt');

  const blockers = (snapshot?.incidents ?? [])
    .filter((incident) => incident.kind === 'production_blocked')
    .map(blockerItem)
    .sort((left, right) => left.identifier.localeCompare(right.identifier, 'zh-CN'));

  const createdSkills = sortNewest(skills
    .filter((skill) => fallsInRange(skill.created_at, range))
    .map((skill) => capabilityItem(skill, skillAssessments.get(skill.id), 'skill')), 'createdAt');
  const publishedSkills = sortNewest(skills
    .filter((skill) => fallsInRange(skill.published_at, range) && !fallsInRange(skill.created_at, range))
    .map((skill) => capabilityItem(skill, skillAssessments.get(skill.id), 'skill')), 'publishedAt');
  const createdAgents = sortNewest(agents
    .filter((agent) => fallsInRange(agent.created_at, range))
    .map((agent) => capabilityItem(agent, agentAssessments.get(agent.id), 'agent')), 'createdAt');

  const repeated = reworkIssues.map((item) => ({
    issueId: item.issueId,
    identifier: item.identifier || item.issueId || '未识别 Issue',
    title: item.title || '',
    node: item.node || '未识别执行节点',
    taskCount: Number(item.taskCount) || 0,
    reworkNodeCount: Number(item.reworkNodeCount) || 1,
    statusSummary: text(item.statusSummary, 180) || '未采集到 Run 状态。',
    reworkNodes: (item.reworkNodes?.length ? item.reworkNodes : [item]).map((node) => ({
      node: node.node || '未识别执行节点',
      agentNames: Array.isArray(node.agentNames) ? node.agentNames : [],
      taskCount: Number(node.taskCount) || 0,
      statusSummary: text(node.statusSummary, 180) || '未采集到 Run 状态。',
      reason: text(node.reason, 1_200) || '重复执行已确认，但当前采集的生产线记录未提供明确返工原因。',
      reasonType: text(node.reasonType, 120) || '返工触发原因未采集',
      reasonConfidence: text(node.reasonConfidence, 80) || '证据不足',
      reasonSource: node.reasonSource || '原因未采集',
      reasonEvidenceExcerpt: text(node.reasonEvidenceExcerpt, 480),
      evidenceAvailable: Boolean(node.reasonEvidence),
      // Full raw evidence belongs to the on-demand Issue detail endpoint.
      // Keeping it out of the shared snapshot prevents every page navigation
      // from parsing and rendering evidence the operator has not opened.
      reasonEvidence: includeFullReworkEvidence ? fullText(node.reasonEvidence) : '',
      firstAt: node.firstAt ?? null,
      lastAt: node.lastAt ?? null
    })),
    firstAt: item.firstAt ?? null,
    lastAt: item.lastAt ?? null
  })).sort((left, right) => right.taskCount - left.taskCount || left.identifier.localeCompare(right.identifier, 'zh-CN'));

  return {
    schema: 'rpg2-daily-health-summary/v1',
    generatedAt: new Date(now).toISOString(),
    date: range,
    issueFlow: {
      started: { count: started.length, items: started },
      completed: {
        count: completed.length,
        exactCount: exactCompletion.length,
        proxyCount: proxyCompletion.length,
        items: completed,
        note: proxyCompletion.length
          ? '其中按 done 状态的更新时间推定；状态迁移历史从本地监控开始记录后会逐步替换为已观测转移。'
          : '均为本地监控已观测到的非 done → done 状态迁移。'
      }
    },
    blockers: { count: blockers.length, items: blockers },
    capabilities: {
      createdSkills: { count: createdSkills.length, items: createdSkills },
      publishedSkills: { count: publishedSkills.length, items: publishedSkills },
      createdAgents: { count: createdAgents.length, items: createdAgents }
    },
    reworkIssues: {
      threshold: 3,
      windowDays: 7,
      count: repeated.length,
      items: repeated,
      note: '返工口径由采集端提供；默认展示同一 Issue 内被重复激活或执行的生产节点，项目经理路由、协调派单、验收、等待与纯下游消费不纳入。'
    }
  };
}
