import { REWORK_POLICY } from './measurement-rules.js';

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function observedAt(run) {
  return run.last_heartbeat_at ?? run.completed_at ?? run.started_at ?? run.created_at ?? null;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function labelForStage(value) {
  const normalized = normalizeText(value);
  return normalized ? `阶段 ${normalized}` : null;
}

/**
 * Run.heartbeat_stage is a lifecycle heartbeat (for example "completed"),
 * not a production node. Rework is anchored to the delegated production
 * stage recorded in the triggering or returning task text.
 */
export function executionNode(run) {
  const sources = [run.trigger_summary, run.result?.output, run.result?.user_visible_output]
    .filter(Boolean)
    .map((value) => String(value));
  for (const source of sources) {
    // A free-form occurrence of “阶段” (for example “阶段治理日志”) is
    // not a delegated production node. Accept a named node only when the
    // source actually uses paired quotation marks.
    const namedStage = source.match(/阶段[「“]\s*([^」”\n]{1,80})[」”]/);
    if (namedStage) return labelForStage(namedStage[1]);
    // Numbered Stage/阶段 labels remain a valid, compact node identity. Keep
    // the role/asset out of this part: `productionObject` supplies the asset
    // key, so unrelated prose after the stage number cannot split or create
    // a fictitious node.
    const numberedStage = source.match(/(?:\bStage|阶段)\s*(\d{1,2})(?:\s*[.．]\s*(\d{1,2}))?\b/i);
    if (numberedStage) return labelForStage(`${numberedStage[1]}${numberedStage[2] ? `.${numberedStage[2]}` : ''}`);
  }
  return null;
}

function productionObject(run) {
  const text = [run.trigger_summary, run.result?.output, run.result?.user_visible_output].filter(Boolean).join('\n');
  const match = text.match(/\b(?:web_s\d+[a-z0-9_]*|img_[a-z0-9_]+|vid_[a-z0-9_]+)\b/i)
    ?? text.match(/\bS\d{2}\.\d+\b/i)
    ?? text.match(/\brecords?\[\d+\]/i);
  return match ? match[0] : null;
}

function isProductionExecution(run) {
  const agent = normalizeText(run.agentName);
  const text = normalizeText([run.trigger_summary, run.result?.output, run.result?.user_visible_output].filter(Boolean).join('\n'));
  if (/项目经理|协调员|日志复盘/.test(agent)) return false;
  if (/no-action|等待|验收|核验|收口|路由|派单|状态核查/i.test(text) && !/修复|重产|重做|返工|重构建|重新发布|render|build/i.test(text)) return false;
  return /请(?:继续)?执行|请对.*(?:返工|重产|修复)|构建|生成|渲染|重产|重做|返工|修复|重新发布|rebuild|render/i.test(text);
}

function reworkNode(run) {
  if (!isProductionExecution(run)) return null;
  const stage = executionNode(run);
  const object = productionObject(run);
  // Asset-level identity is preferred, but a production line can be blocked
  // and repeatedly reactivated at a whole-stage gate before an individual
  // asset exists. Keep that stage-level evidence instead of reporting a false
  // zero for the entire Issue.
  return stage ? (object ? `${stage} · ${object}` : stage) : null;
}

export function selectRecentTerminalProductionIssues(issues, {
  now = new Date(),
  lookbackDays = REWORK_POLICY.lookbackDays,
  titleMarker = '颗粒生产'
} = {}) {
  const nowMs = timestamp(now);
  const startMs = nowMs - lookbackDays * 86400000;
  return issues
    .filter((issue) => ['done', 'cancelled'].includes(String(issue.status ?? '').toLowerCase()))
    .filter((issue) => String(issue.title ?? '').includes(titleMarker))
    .filter((issue) => timestamp(issue.updated_at ?? issue.completed_at) >= startMs)
    .map((issue) => ({ ...issue, reworkTerminalAt: issue.updated_at ?? issue.completed_at ?? null }));
}

/**
 * Returns the individual executions that are eligible for repeat-node
 * analysis. Keeping this explicit lets the dashboard report the real evidence
 * coverage for a zero-result window instead of confusing all retained history
 * with the subset inside the seven-day window.
 */
export function reworkCandidateRuns(runs, { since = null } = {}) {
  const sinceMs = timestamp(since);
  const candidates = [];
  for (const run of runs) {
    if (!run.issue_id || !run.agent_id) continue;
    if (sinceMs && timestamp(observedAt(run)) < sinceMs) continue;
    const node = reworkNode(run);
    if (node) candidates.push({ run, node });
  }
  return candidates;
}

function statusSummary(runs) {
  const counts = runs.reduce((summary, run) => {
    const status = String(run.status ?? 'unknown').toLowerCase();
    summary.set(status, (summary.get(status) ?? 0) + 1);
    return summary;
  }, new Map());
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([status, count]) => `${status} ×${count}`)
    .join('、');
}

function directRunMessageText(value) {
  if (!value) return '';
  const parsed = typeof value === 'string'
    ? (() => { try { return JSON.parse(value); } catch { return null; } })()
    : value;
  const messages = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
  // Tool outputs frequently embed whole Issue histories. They are useful in
  // the execution-chain viewer, but are not attributable cause evidence for
  // the current Run. Only retain the current agent's narrative text records.
  return messages
    .filter((message) => message?.type === 'text' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
}

function textSources(run) {
  const sources = [
    ['Task error', run.error],
    ['Task 委托', run.trigger_summary],
    ['Task 回传', run.result?.output],
    ['Task 用户可见回传', run.result?.user_visible_output],
    ['Task 心跳摘要', run.heartbeat_summary],
    ['本 Run 文本消息', directRunMessageText(run.runMessages)]
  ];
  return sources
    .map(([source, value]) => ({ source, text: normalizeText(typeof value === 'string' ? value : value ? JSON.stringify(value) : '') }))
    .filter((item) => item.text);
}

function conciseEvidence(value, limit = 220) {
  const text = normalizeText(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function evidenceSentence(text, matcher) {
  const match = text.match(new RegExp(`[^。！？\\n]{0,140}(?:${matcher.source})[^。！？\\n]{0,320}`, matcher.flags.replace('g', '')));
  return normalizeText(match?.[0] ?? text);
}

const causeRules = [
  {
    type: '生产门禁或质量校验',
    pattern: /BLOCK_STAGE|fail-closed|preflight.{0,60}(?:fail|block)|门禁(?:失败|未通过|阻塞)|(?:机器)?(?:校验|验证|检查|审核|验收)(?:失败|未通过)|\bgate\s*(?:failed|blocked)/i
  },
  {
    type: '审核或验收反馈',
    // Do not treat a bare "feedback" token as proof. The record must show a
    // rejection/return, or an explicitly human/member review outcome.
    pattern: /(?:审核|验收).{0,48}(?:退回|驳回|拒绝)|(?:人工|人类|member|human).{0,72}(?:审核|验收).{0,72}(?:反馈|退回|驳回|未通过|拒绝)|review\s*(?:rejected|returned)|not approved/i
  },
  {
    type: '交付物或依赖缺失',
    pattern: /缺少|缺失|未生成|不存在|找不到|未上传|依赖(?:缺失|不可用|失败)|missing|not found/i
  },
  {
    type: '运行环境或服务故障',
    pattern: /timeout|超时|daemon|服务不可用|connection|网络|重启/i
  },
  {
    type: '版本或发布状态修正',
    pattern: /回滚|重新发布|重新部署|发布失败|版本(?:不一致|错误|回退)/i
  },
  {
    type: '上游交付返修',
    pattern: /返工|重做|修复|修改|修订/i
  }
];

/**
 * Produces an evidence-led cause at production-node grain. A direct task
 * error is a fact; other categories are observed signals and retain their
 * original full text for review instead of pretending a regex is a verdict.
 */
export function analyzeReworkCause(runs) {
  const sources = runs.flatMap((run) => textSources(run).map((item) => ({ ...item, run })));
  const directError = sources.find((item) => item.source === 'Task error');
  if (directError) {
    return {
      type: '执行失败',
      confidence: '已确认',
      summary: `执行失败：${conciseEvidence(directError.text)}`,
      source: directError.source,
      evidenceExcerpt: directError.text,
      evidence: directError.text
    };
  }

  for (const rule of causeRules) {
    const evidence = sources.find((item) => rule.pattern.test(item.text));
    if (evidence) {
      return {
        type: rule.type,
        confidence: '运行线索',
        summary: `${rule.type}：${conciseEvidence(evidenceSentence(evidence.text, rule.pattern))}`,
        source: evidence.source,
        evidenceExcerpt: evidenceSentence(evidence.text, rule.pattern),
        evidence: evidence.text
      };
    }
  }

  return {
    type: '返工触发原因未采集',
    confidence: '证据不足',
    summary: '已确认同一生产线节点被重复激活或执行，但当前采集到的 Issue、Run 与运行消息未说明触发返工的具体原因。',
    source: '原因未采集',
    evidenceExcerpt: '重复执行事实来自该节点的 Run 计数与状态记录。',
    evidence: ''
  };
}

/**
 * A rework occurrence means one concrete production node was activated or
 * executed at least three times inside the same production Issue. Agent is an
 * evidence dimension only: a hand-off does not make repeated work disappear.
 * Every eligible Run lifecycle status participates; the item is counted once
 * at Issue grain.
 */
export function findReworkIssues(runs, { threshold = REWORK_POLICY.threshold, since = null } = {}) {
  const groups = new Map();
  for (const { run, node } of reworkCandidateRuns(runs, { since })) {
    const key = `${run.issue_id}\u0000${node}`;
    const group = groups.get(key) ?? {
      issueId: run.issue_id,
      identifier: run.issueIdentifier ?? run.issue_id,
      title: run.issueTitle ?? '',
      issueDescription: run.issueDescription ?? '',
      node,
      agentNames: new Set(),
      runs: []
    };
    if (run.agentName ?? run.agent_id) group.agentNames.add(run.agentName ?? run.agent_id);
    group.runs.push(run);
    groups.set(key, group);
  }

  // The threshold is deliberately at Issue → concrete-node grain. This makes
  // the queue reveal where a line is repeatedly reactivated after a blockage,
  // even when different squad members take turns on that same node.
  const qualifying = [...groups.values()].filter((group) => group.runs.length >= threshold);
  const analyzedNodes = qualifying.map((group) => {
    const analysis = analyzeReworkCause(group.runs);
    return {
      ...group,
      agentNames: [...group.agentNames].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      involvedAgentCount: group.agentNames.size,
      taskCount: group.runs.length,
      statusSummary: statusSummary(group.runs),
      reason: analysis.summary,
      reasonType: analysis.type,
      reasonConfidence: analysis.confidence,
      reasonSource: analysis.source,
      reasonEvidenceExcerpt: analysis.evidenceExcerpt,
      reasonEvidence: analysis.evidence,
      firstAt: [...group.runs].map(observedAt).filter(Boolean).sort((left, right) => timestamp(left) - timestamp(right))[0] ?? null,
      lastAt: [...group.runs].map(observedAt).filter(Boolean).sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null
    };
  });

  const byIssue = new Map();
  for (const group of analyzedNodes) {
    const existing = byIssue.get(group.issueId) ?? { ...group, groups: [] };
    existing.groups.push(group);
    if (group.taskCount > existing.taskCount || (group.taskCount === existing.taskCount && timestamp(group.lastAt) > timestamp(existing.lastAt))) {
      Object.assign(existing, group);
    }
    byIssue.set(group.issueId, existing);
  }

  return [...byIssue.values()]
    .map(({ runs: _runs, groups, ...issue }) => ({
      ...issue,
      reworkNodeCount: groups.length,
      reworkNodes: groups
        .map(({ runs: _runs, ...node }) => node)
        .sort((left, right) => right.taskCount - left.taskCount || timestamp(right.lastAt) - timestamp(left.lastAt) || left.node.localeCompare(right.node, 'zh-CN'))
    }))
    .sort((left, right) => right.taskCount - left.taskCount || timestamp(right.lastAt) - timestamp(left.lastAt) || left.identifier.localeCompare(right.identifier, 'zh-CN'));
}
