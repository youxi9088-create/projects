import { ACTIVE_ISSUE_STATUSES } from './config.js';
import { applyDarwinEvidence } from './skill-audit.js';

const FAILURE_STATUSES = new Set(['failed', 'failure', 'error']);
// Timeout is a terminal failure for Agent execution health: it consumes the
// same reliability budget as an explicit error, but it is a distinct status
// value Multica reports separately from `error`.
const AGENT_FAILURE_STATUSES = new Set([...FAILURE_STATUSES, 'timeout', 'timed_out']);
const RUNNING_STATUSES = new Set(['queued', 'pending', 'running', 'preparing', 'in_progress']);

// The effective time of a Run is its most authoritative lifecycle timestamp:
// completion, last heartbeat, start, then creation. Every Agent execution
// health rule (window membership, sample counts) must use the same priority so
// a completed Run never leaves the 7-day window merely because its heartbeat
// column is stale, and a running Run is never mis-dated by its creation time.
function runEffectiveTime(run) {
  return timestamp(run.completed_at ?? run.last_heartbeat_at ?? run.started_at ?? run.created_at);
}

// An Issue belongs in exactly one risk queue.  This ordering follows the
// operator's recovery order: an explicit production block outranks execution
// signals, which in turn outrank a progression warning.  Issue-less events
// (for example service or Skill governance signals) remain independent.
const ISSUE_INCIDENT_PRIORITY = {
  production_blocked: 400,
  retry_loop: 330,
  task_timeout: 320,
  task_failure: 310,
  no_progress: 200
};

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function recentText(run, messages) {
  const result = run.result?.output ?? run.result?.user_visible_output ?? '';
  const messageText = messages ? JSON.stringify(messages).slice(0, 30_000) : '';
  return [run.trigger_summary, run.error, result, messageText].filter(Boolean).join('\n');
}

function excerpt(value, max = 180) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} 小时${remainder ? ` ${remainder} 分钟` : ''}`;
}

function event({ id, severity, kind, title, detail, issue, run, agent, skill, evidence }) {
  return {
    id,
    severity,
    kind,
    title,
    detail,
    issue: issue ? { id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status } : null,
    run: run ? { id: run.id, status: run.status, agentId: run.agent_id, lastHeartbeatAt: run.last_heartbeat_at } : null,
    agent: agent ? { id: agent.id, name: agent.name } : null,
    skill: skill ? { id: skill.id, name: skill.name, publishedAt: skill.published_at } : null,
    evidence: evidence ?? [],
    detectedAt: new Date().toISOString()
  };
}

function incidentPriority(incident) {
  return ISSUE_INCIDENT_PRIORITY[incident.kind] ?? 100;
}

function consolidateIssueIncidents(incidents) {
  const grouped = new Map();
  const standalone = [];
  for (const incident of incidents) {
    if (!incident.issue?.id) {
      standalone.push(incident);
      continue;
    }
    const group = grouped.get(incident.issue.id) ?? [];
    group.push(incident);
    grouped.set(incident.issue.id, group);
  }
  const consolidated = [...grouped.values()].map((group) => {
    const ordered = [...group].sort((left, right) => {
      const severity = (right.severity === 'critical') - (left.severity === 'critical');
      return incidentPriority(right) - incidentPriority(left) || severity || left.id.localeCompare(right.id);
    });
    const [primary, ...related] = ordered;
    if (related.length) {
      primary.relatedIncidents = related.map((incident) => ({
        id: incident.id,
        kind: incident.kind,
        title: incident.title,
        detail: incident.detail,
        severity: incident.severity,
        evidence: incident.evidence
      }));
      primary.evidence = [
        ...(primary.evidence ?? []),
        `同一 Issue 的 ${related.length} 条较低优先级异常已合并至本条；打开详情可追查原始 Issue / Run 证据。`
      ];
    }
    return primary;
  });
  return [...consolidated, ...standalone];
}

function aggregateSkillUsage(skills, runs, messagesByRun, allowedAgentIds, scope) {
  const scopedIssueIds = new Set(scope?.issueIds ?? []);
  const windowStart = timestamp(scope?.windowStart);
  const usage = new Map(skills.map((skill) => [skill.id, {
    skill,
    observedCalls: 0,
    explicitRuns: new Set(),
    implicitEvidenceRuns: new Set(),
    failedCalls: 0
  }]));
  for (const run of runs) {
    if (allowedAgentIds?.size && !allowedAgentIds.has(run.agent_id)) continue;
    // The Skill catalogue is a performance-scope result, not an all-time
    // mention index.  This keeps explicit calls on older or non-granular
    // production Issues from appearing on the seven-day production page.
    if (scopedIssueIds.size && !scopedIssueIds.has(run.issue_id)) continue;
    if (windowStart && timestamp(run.last_heartbeat_at ?? run.completed_at ?? run.started_at ?? run.created_at) < windowStart) continue;
    const invokedSkills = invokedSkillNames(messagesByRun.get(run.id));
    for (const candidate of usage.values()) {
      if (!candidate.skill.name) continue;
      if (invokedSkills.has(candidate.skill.name)) {
        candidate.observedCalls += 1;
        candidate.explicitRuns.add(run.id);
        if (isProductionFailure(run)) candidate.failedCalls += 1;
        continue;
      }
    }
  }
  return [...usage.values()]
    // The dashboard's Skill population is deliberately limited to explicit
    // Skill tool calls made by member Agents on directly assigned Issues.
    .filter((item) => item.observedCalls > 0)
    .map((item) => ({
      id: item.skill.id,
      name: item.skill.name,
      observedCalls: item.observedCalls,
      distinctRuns: item.explicitRuns.size,
      implicitEvidenceRuns: item.implicitEvidenceRuns.size,
      evidenceMode: item.observedCalls && item.implicitEvidenceRuns.size ? 'mixed' : item.observedCalls ? 'explicit' : 'implicit',
      failedCalls: item.failedCalls,
      successRate: item.observedCalls ? Math.round(((item.observedCalls - item.failedCalls) / item.observedCalls) * 100) : null,
      publishedAt: item.skill.published_at,
      hasDraft: Boolean(item.skill.has_draft)
    }))
    .sort((left, right) => (right.observedCalls - left.observedCalls) || (right.implicitEvidenceRuns - left.implicitEvidenceRuns) || left.name.localeCompare(right.name, 'zh-CN'));
}

function runDurationMs(run) {
  const startedAt = timestamp(run.started_at ?? run.created_at);
  const endedAt = timestamp(run.completed_at ?? run.last_heartbeat_at);
  return startedAt && endedAt >= startedAt ? endedAt - startedAt : null;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

function isProductionFailure(run) {
  const status = String(run.status ?? '').toLowerCase();
  return FAILURE_STATUSES.has(status) || status === 'timeout' || status === 'timed_out' || Boolean(run.error);
}

function isTimeout(run) {
  return /timeout|timed out|超时/i.test(`${run.status ?? ''}\n${run.error ?? ''}\n${run.heartbeat_summary ?? ''}`);
}

function messageItems(messages) {
  if (Array.isArray(messages)) return messages;
  if (Array.isArray(messages?.items)) return messages.items;
  if (Array.isArray(messages?.messages)) return messages.messages;
  return [];
}

function invokedSkillNames(messages) {
  return new Set(messageItems(messages)
    .filter((message) => message.type === 'tool_use' && message.tool === 'Skill' && typeof message.input?.skill === 'string')
    .map((message) => message.input.skill));
}

/**
 * Darwin's performance dimension must be earned from production execution,
 * not inferred from a release flag or a synthetic suite. Every explicitly
 * attributed Run is sampled, including an in-progress Run. Only settled Runs
 * determine an outcome rate: an in-progress Run is evidence of work, never a
 * guessed success or failure.
 */
function granularProductionPerformance(skills, runs, messagesByRun, scope, allowedAgentIds) {
  const issueIds = new Set(scope?.issueIds ?? []);
  const windowStart = timestamp(scope?.windowStart);
  const records = new Map(skills.map((skill) => [skill.id, {
    skill,
    observedRuns: 0,
    terminalCalls: 0,
    nonTerminalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    timeoutCalls: 0,
    issueIds: new Set(),
    durations: []
  }]));
  if (!issueIds.size) return new Map();

  for (const run of runs) {
    if (!issueIds.has(run.issue_id)) continue;
    if (allowedAgentIds?.size && !allowedAgentIds.has(run.agent_id)) continue;
    if (windowStart && timestamp(run.last_heartbeat_at ?? run.completed_at ?? run.started_at ?? run.created_at) < windowStart) continue;
    const invokedSkills = invokedSkillNames(messagesByRun.get(run.id));
    if (!invokedSkills.size) continue;
    const completed = String(run.status ?? '').toLowerCase() === 'completed';
    const failed = isProductionFailure(run);
    const terminal = completed || failed;
    for (const record of records.values()) {
      if (!record.skill.name || !invokedSkills.has(record.skill.name)) continue;
      record.observedRuns += 1;
      record.issueIds.add(run.issue_id);
      if (!terminal) {
        record.nonTerminalCalls += 1;
        continue;
      }
      record.terminalCalls += 1;
      if (completed) record.successCalls += 1;
      if (failed) record.failedCalls += 1;
      if (isTimeout(run)) record.timeoutCalls += 1;
      const durationMs = runDurationMs(run);
      if (durationMs != null) record.durations.push(durationMs);
    }
  }

  return new Map([...records.entries()].map(([skillId, record]) => {
    const medianDurationMs = median(record.durations);
    const terminalCalls = record.terminalCalls;
    return [skillId, {
      scopeKind: scope.kind ?? null,
      timeRange: scope.timeRange ?? null,
      days: scope.days,
      windowStart: scope.windowStart,
      titleMarker: scope.titleMarker,
      issueCount: record.issueIds.size,
      scopeIssueCount: scope.issueCount ?? issueIds.size,
      observedRuns: record.observedRuns,
      terminalCalls,
      nonTerminalCalls: record.nonTerminalCalls,
      successCalls: record.successCalls,
      failedCalls: record.failedCalls,
      timeoutCalls: record.timeoutCalls,
      successRate: terminalCalls ? Math.round(record.successCalls / terminalCalls * 100) : null,
      medianDurationMs,
      medianDurationLabel: medianDurationMs == null ? null : duration(medianDurationMs),
      // All calls are visible in the real-world sample. A result score still
      // needs three settled calls, so active work cannot depress or inflate it.
      sampleSufficient: terminalCalls >= 3,
      outcomeSampleSufficient: terminalCalls >= 3
    }];
  }));
}

function hasExplicitBlockSignal(run, messages) {
  if (String(run.status ?? '').toLowerCase() === 'blocked') return true;
  const result = run.result?.output ?? run.result?.user_visible_output ?? '';
  const messageText = messageItems(messages).map((message) => (
    typeof message === 'string' ? message : message.content ?? message.text ?? JSON.stringify(message)
  )).join('\n');
  const evidence = [run.error, run.heartbeat_summary, result, messageText].filter(Boolean).join('\n');
  // Avoid treating an agent's retrospective prose (for example “a prior
  // blocker was fixed”) as another blockage.  A signal must describe this Run
  // as a state transition or an explicit gate decision.
  return /(?:issue\s+(?:status\s+)?(?:was\s+)?(?:marked|set|updated)|(?:marking|setting|updating)\s+(?:the\s+)?issue\s+(?:status\s+)?(?:to\s+)?)\s*(?:as\s+|to\s+)?blocked\b|Issue\s*(?:状态)?(?:已)?(?:标记|设置|更新).{0,20}blocked|(?:preflight|gate|门禁|阶段|stage)[^\n]{0,100}(?:\bBLOCK_STAGE\d+\b|\bdecision\s*(?:=|:)\s*(?:BLOCK|blocked|fail(?:ed)?[-\s]?closed)\b|\bverdict\s*(?:=|:)\s*(?:BLOCK|blocked|fail(?:ed)?[-\s]?closed)\b)/i.test(evidence);
}

function hasStalledNodeSignal(run, nowMs, thresholdMs) {
  const status = String(run.status ?? '').toLowerCase();
  if (!RUNNING_STATUSES.has(status)) return false;
  const lastProgressAt = timestamp(run.last_heartbeat_at ?? run.updated_at ?? run.started_at ?? run.created_at);
  return Boolean(lastProgressAt) && nowMs - lastProgressAt > thresholdMs;
}

/**
 * A production line is not uninterrupted when the coordinator has explicitly
 * parked it for a named human decision or human verification.  This must be
 * read from the Run's own return, rather than from copied historical comments
 * in tool output, so a later retrospective cannot retroactively create a
 * blockage.
 */
function hasHumanDecisionBlockSignal(run) {
  const result = run.result?.output ?? run.result?.user_visible_output ?? '';
  const evidence = [run.heartbeat_summary, run.trigger_summary, result].filter(Boolean).join('\n');
  const explicitWait = /(?:状态\s*[:：]?\s*阻塞|需(?:要)?人工(?:决策|确认|复验)|等待人工(?:决策|确认|复验)|升级人工(?:决策|复验)|human\s+(?:decision|verification).{0,40}(?:block|wait)|blocked.{0,40}human\s+(?:decision|verification))/i.test(evidence);
  const decisionTarget = /(?:吴林金|人工(?:成员|workspace\s*member|决策人)|member[-_\s]?review|human\s+(?:member|decision))/i.test(evidence);
  return explicitWait && decisionTarget;
}

function runEvidence(run) {
  const result = run.result?.output ?? run.result?.user_visible_output ?? '';
  return [run.trigger_summary, run.heartbeat_summary, run.error, result].filter(Boolean).join('\n');
}

/**
 * The line-performance metric follows the production execution chain, rather
 * than every later control-plane callback attached to the same Issue. A
 * post-completion retrospective, a PM route/close action, or a coordinator
 * dispatch must not turn an already-delivered line into a retry.
 */
function isProductionNodeRun(run) {
  const evidence = runEvidence(run);
  if (/(?:日志复盘|完成后复盘|post[-\s]?completion\s+(?:log\s+)?review|retrospective\s+(?:review|governance))/i.test(evidence)) return false;
  const controlPlaneAction = /(?:项目经理|协调(?:员)?|coordinator).{0,48}(?:路由|派单|收口|状态核查)|(?:路由|派单|收口|no[_\s-]?action|状态核查)/i.test(evidence);
  const productionAction = /(?:\bStage\s*\d+|阶段\s*\d+|颗粒生产|生产节点|构建|生成|渲染|重产|重做|返工|修复|rebuild|render)/i.test(evidence);
  return !(controlPlaneAction && !productionAction);
}

/**
 * "一次性" means no failed/cancelled production-node attempt and no recovery
 * restart. This is deliberately stricter than the four-hour no-progress
 * signal: a server-cancelled task that is later resumed is a broken first
 * attempt even when the gap itself is short.
 */
function hasProductionExecutionInterruption(run) {
  if (!isProductionNodeRun(run)) return false;
  const status = String(run.status ?? '').toLowerCase();
  if (FAILURE_STATUSES.has(status) || ['cancelled', 'canceled', 'timeout', 'timed_out'].includes(status) || run.error) return true;
  return /(?:task\s+cancelled(?:\s+by\s+server)?|任务(?:被)?取消|已取消(?:任务)?)/i.test(runEvidence(run));
}

function hasProductionRestartSignal(run) {
  if (!isProductionNodeRun(run)) return false;
  const trigger = String(run.trigger_summary ?? '');
  return /(?:请|已|重新)?(?:继续|恢复)(?:执行|生产|任务)|\b(?:resume|resumed|retry|restarted)\b/i.test(trigger);
}

/**
 * Terminal production lines are every directly-assigned done or cancelled
 * Issue. A block occurrence is one node Run carrying an explicit
 * blocked/gate state, a failed/cancelled/restarted production-node attempt, an
 * explicit named human decision wait, or a running node with no heartbeat for
 * over four hours. Post-completion review and control-plane callbacks are not
 * production nodes.
 */
export function productionLinePerformance(issues, runs, messagesByRun, { nowMs, nodeStallMs }) {
  const completedIssues = issues.filter((issue) => issue.status === 'done');
  const cancelledIssues = issues.filter((issue) => issue.status === 'cancelled');
  const runsByIssue = new Map();
  for (const run of runs) {
    const current = runsByIssue.get(run.issue_id) ?? [];
    current.push(run);
    runsByIssue.set(run.issue_id, current);
  }

  // A done Issue without any Run remains part of the business population, but
  // cannot support a run-through or duration conclusion. Cancellation remains
  // a terminal interruption even if its trace has already expired.
  const completedWithRuns = completedIssues.filter((issue) => (runsByIssue.get(issue.id) ?? []).length > 0);
  // `terminalIssues` below must include all completed records, not only the
  // records whose Run history happens to remain available.
  const allTerminalIssues = [...completedIssues, ...cancelledIssues];
  const terminalWithRuns = allTerminalIssues.filter((issue) => (runsByIssue.get(issue.id) ?? []).length > 0);
  const completedWithoutRuns = completedIssues.length - completedWithRuns.length;
  const terminalWithoutRuns = allTerminalIssues.length - terminalWithRuns.length;
  const durations = [];
  const onePassIssues = [];
  let terminalBlockOccurrences = 0;
  let blockedLineCount = 0;
  let onePassCount = 0;
  let observedBlockOccurrences = 0;
  let explicitBlockOccurrences = 0;
  let humanDecisionOccurrences = 0;
  let stalledNodeOccurrences = 0;
  let executionInterruptionOccurrences = 0;
  let cancellationOccurrences = 0;
  let linesWithMessageEvidence = 0;
  for (const issue of allTerminalIssues) {
    const issueRuns = runsByIssue.get(issue.id) ?? [];
    const hasFailedProductionAttempt = issueRuns.some(hasProductionExecutionInterruption);
    let blocks = issueRuns.reduce((count, run) => {
      const explicitlyBlocked = hasExplicitBlockSignal(run, messagesByRun.get(run.id));
      const stalled = hasStalledNodeSignal(run, nowMs, nodeStallMs);
      const executionInterrupted = hasProductionExecutionInterruption(run);
      if (explicitlyBlocked) explicitBlockOccurrences += 1;
      // A single node can satisfy both signals; it still represents only one
      // interruption in the line's retry path.
      if (stalled && !explicitlyBlocked) stalledNodeOccurrences += 1;
      if (executionInterrupted && !explicitlyBlocked && !stalled) executionInterruptionOccurrences += 1;
      return count + (explicitlyBlocked || stalled || executionInterrupted ? 1 : 0);
    }, 0);
    // A retained "continue"/"resume" callback still proves that an earlier
    // production attempt broke, even if the original failed Run has expired.
    // If that failed Run is present, it already supplied the one interruption
    // and the recovery must not be counted a second time.
    if (!hasFailedProductionAttempt && issueRuns.some(hasProductionRestartSignal)) {
      blocks += 1;
      executionInterruptionOccurrences += 1;
    }
    // Several relayed comments may repeat one decision wait. Count it once per
    // Issue run-through; it is still enough to exclude the line from one-pass.
    const humanDecisionBlocked = issueRuns.some(hasHumanDecisionBlockSignal);
    if (humanDecisionBlocked) {
      blocks += 1;
      humanDecisionOccurrences += 1;
    }
    if (issue.status === 'cancelled' && blocks === 0) {
      // Cancellation closes a line without delivery, so it is a minimum of
      // one interruption even if its historical Task trace is unavailable.
      blocks = 1;
      cancellationOccurrences += 1;
    }
    observedBlockOccurrences += blocks;
    terminalBlockOccurrences += blocks;
    if (blocks > 0) blockedLineCount += 1;
    // `done` is the business completion signal, but a line has not actually
    // run through unless its retained execution trace also has a completed
    // production Run. A done Issue with only failed/cancelled Runs must not
    // appear in the one-pass Issue drill-down.
    const productionRuns = issueRuns.filter(isProductionNodeRun);
    const completedProductionRuns = productionRuns.filter((run) => String(run.status ?? '').toLowerCase() === 'completed');
    const hasCompletedRun = completedProductionRuns.length > 0;
    // Successful production duration is the elapsed time of the final
    // completed production Run itself. A preceding failed/restarted Run is an
    // interruption (and excludes one-pass), not elapsed time of the recovered
    // successful execution. This also keeps post-completion control-plane
    // callbacks out of the production duration.
    const finalCompletedRun = [...completedProductionRuns].sort((left, right) => {
      const leftAt = timestamp(left.completed_at ?? left.last_heartbeat_at);
      const rightAt = timestamp(right.completed_at ?? right.last_heartbeat_at);
      return rightAt - leftAt;
    })[0];
    const successfulRunStartedAt = timestamp(finalCompletedRun?.started_at ?? finalCompletedRun?.created_at);
    const successfulRunCompletedAt = timestamp(finalCompletedRun?.completed_at ?? finalCompletedRun?.last_heartbeat_at);
    const successfulRunDurationMs = finalCompletedRun
      && Number.isFinite(successfulRunStartedAt)
      && Number.isFinite(successfulRunCompletedAt)
      && successfulRunCompletedAt >= successfulRunStartedAt
      ? successfulRunCompletedAt - successfulRunStartedAt
      : null;
    if (issue.status === 'done' && hasCompletedRun && blocks === 0) {
      onePassCount += 1;
      onePassIssues.push({
        id: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title ?? '未采集标题',
        completedAt: Number.isFinite(successfulRunCompletedAt) ? new Date(successfulRunCompletedAt).toISOString() : null,
        durationMs: successfulRunDurationMs,
        durationLabel: successfulRunDurationMs != null
          ? duration(successfulRunDurationMs)
          : '时长未采集'
      });
    }
    if (issueRuns.some((run) => messageItems(messagesByRun.get(run.id)).length > 0)) linesWithMessageEvidence += 1;

    // Cancellation is material for interruption probability, but it is not a
    // completed production duration. Keep this timing metric delivery-only.
    if (issue.status === 'done') {
      if (successfulRunDurationMs != null) durations.push(successfulRunDurationMs);
    }
  }

  const terminalIssueCount = allTerminalIssues.length;
  const onePassDenominator = completedIssues.length;
  const blockDenominator = terminalIssueCount;
  const durationDenominator = completedIssues.length;
  const durationCoverageComplete = durations.length === durationDenominator;
  const runHistoryComplete = completedWithRuns.length === completedIssues.length;
  const terminalRunHistoryComplete = terminalWithRuns.length === terminalIssueCount;
  const onePassStatus = !onePassDenominator ? 'no_completed_issues' : runHistoryComplete ? 'computed' : 'insufficient_run_history';
  const blockStatus = !blockDenominator ? 'no_terminal_issues' : terminalRunHistoryComplete ? 'computed' : 'insufficient_run_history';
  const durationStatus = !durationDenominator ? 'no_completed_issues' : durationCoverageComplete ? 'computed' : 'insufficient_run_history';
  const calculationStatus = onePassStatus === 'computed' && blockStatus === 'computed' && durationStatus === 'computed' ? 'computed' : 'insufficient_run_history';
  const percentage = (value, denominator) => denominator ? Math.round(value / denominator * 100) : null;
  const averageDurationMs = durations.length
    ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
    : null;
  // This is intentionally conditional: it answers how many times a line
  // stops after it has ceased to be a one-pass line, rather than diluting the
  // depth of interruption with lines that never stopped.
  const averageBlockOccurrences = blockDenominator
    ? Math.round(terminalBlockOccurrences / blockDenominator * 100) / 100
    : null;
  return {
    completedIssueCount: completedIssues.length,
    cancelledIssueCount: cancelledIssues.length,
    terminalIssueCount,
    denominator: terminalIssueCount,
    excludedWithoutRuns: completedWithoutRuns,
    terminalExcludedWithoutRuns: terminalWithoutRuns,
    onePassDenominator,
    blockDenominator,
    durationDenominator,
    onePassCount,
    onePassRate: onePassStatus === 'computed' ? percentage(onePassCount, onePassDenominator) : null,
    onePassIssues: onePassIssues.sort((left, right) => String(right.completedAt ?? '').localeCompare(String(left.completedAt ?? ''))),
    terminalLineCount: terminalIssueCount,
    blockedLineCount,
    blockedLineRate: percentage(blockedLineCount),
    terminalBlockOccurrences,
    averageBlockOccurrences: blockStatus === 'computed' ? averageBlockOccurrences : null,
    observedBlockOccurrences,
    explicitBlockOccurrences,
    humanDecisionOccurrences,
    stalledNodeOccurrences,
    executionInterruptionOccurrences,
    cancellationOccurrences,
    nodeStallHours: Math.round(nodeStallMs / 60 / 60_000),
    linesWithMessageEvidence,
    averageDurationMs: durationStatus === 'computed' ? averageDurationMs : null,
    averageDurationLabel: durationStatus === 'computed' && averageDurationMs != null ? duration(averageDurationMs) : null,
    durationSampleCount: durations.length,
    durationPopulation: 'done_final_completed_production_run',
    calculationStatus,
    runBackedCompletedIssueCount: completedWithRuns.length,
    completedRunBackedIssueCount: completedIssues.filter((issue) => (runsByIssue.get(issue.id) ?? []).some((run) => String(run.status ?? '').toLowerCase() === 'completed')).length,
    metricStatus: { onePass: onePassStatus, blockAverage: blockStatus, duration: durationStatus },
    calculationEvidence: calculationStatus === 'computed'
      ? `${completedWithRuns.length}/${completedIssues.length} 条 done Issue、${terminalWithRuns.length}/${terminalIssueCount} 条终态 Issue 均有 Run 历史；一次性跑通以全部完成单为分母，平均阻断以全部终态单为分母，时长以全部完成单为样本。`
      : durationStatus === 'insufficient_run_history' && runHistoryComplete && terminalRunHistoryComplete
        ? `全部 ${completedIssues.length} 条 done Issue 与 ${terminalIssueCount} 条终态 Issue 均有 Run 历史；但其中 ${durationDenominator - durations.length} 条完成单缺少可审计的成功生产起止时间，暂不能给出完整平均时长。`
        : `终态生产线为 ${terminalIssueCount} 条（done ${completedIssues.length} + cancelled ${cancelledIssues.length}）。当前有 ${completedWithRuns.length}/${completedIssues.length} 条 done Issue、${terminalWithRuns.length}/${terminalIssueCount} 条终态 Issue 具备 Run 历史；不能对缺少 Run 的生产线给出完整的跑通、阻断或时长结论。`
  };
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * Scores only the dimensions for which evidence exists. Confidence represents
 * how much of the intended model is backed by evidence, preventing configuration
 * checks from masquerading as a high quality-production score.
 */
function assess(dimensions) {
  const totalWeight = dimensions.reduce((total, item) => total + item.weight, 0);
  const measured = dimensions.filter((item) => item.value !== null && item.value !== undefined);
  const measuredWeight = measured.reduce((total, item) => total + item.weight, 0);
  const score = measuredWeight
    ? Math.round(measured.reduce((total, item) => total + clampPercent(item.value) * item.weight, 0) / measuredWeight)
    : null;
  const confidence = Math.round(dimensions.reduce((total, item) => total + item.weight * Math.max(0, Math.min(1, item.coverage ?? (item.value == null ? 0 : 1))), 0) / totalWeight * 100);
  return {
    score,
    confidence,
    dimensions: dimensions.map((item) => ({ key: item.key, label: item.label, score: item.value == null ? null : Math.round(clampPercent(item.value)), weight: item.weight, observed: item.value != null }))
  };
}

function assessmentStatus(assessment, hasCriticalIncident = false) {
  if (assessment.confidence < 40) return 'unknown';
  if (hasCriticalIncident || assessment.score < 60) return 'critical';
  if (assessment.score < 80) return 'warning';
  return 'healthy';
}

function assessmentGrade(assessment) {
  if (assessment.confidence < 40) return '证据不足';
  if (assessment.score >= 90) return 'A';
  if (assessment.score >= 80) return 'B';
  if (assessment.score >= 60) return 'C';
  return 'D';
}

function latestByTime(records) {
  return [...records].sort((left, right) => timestamp(right.executedAt ?? right.executed_at) - timestamp(left.executedAt ?? left.executed_at))[0] ?? null;
}

function latestRun(records) {
  return [...records].sort((left, right) => timestamp(right.last_heartbeat_at ?? right.completed_at ?? right.created_at) - timestamp(left.last_heartbeat_at ?? left.completed_at ?? left.created_at))[0] ?? null;
}

function blockedReason(issue) {
  return issue.metadata?.blocked_reason ?? issue.metadata?.blocker ?? issue.blocked_reason ?? null;
}

function runMessageCount(messages) {
  if (Array.isArray(messages)) return messages.length;
  if (Array.isArray(messages?.items)) return messages.items.length;
  if (Array.isArray(messages?.messages)) return messages.messages.length;
  return 0;
}

function messageRows(messages) {
  if (Array.isArray(messages)) return messages;
  if (Array.isArray(messages?.items)) return messages.items;
  if (Array.isArray(messages?.messages)) return messages.messages;
  return [];
}

function stageGateDiagnosis(issueRuns, messagesByRun) {
  const candidates = [];
  for (const run of issueRuns) {
    const rows = messageRows(messagesByRun.get(run.id));
    if (!rows.length) continue;
    const text = rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
    const gates = [...text.matchAll(/\bBLOCK_STAGE\s*0?(\d{1,2})\b/ig)];
    const gate = gates.at(-1);
    if (!gate) continue;
    const stage = Number(gate[1]);
    if (!Number.isFinite(stage)) continue;
    const hasPreflight = /preflight(?:_next_stage)?[\s\S]{0,240}BLOCK_STAGE|BLOCK_STAGE[\s\S]{0,240}preflight/i.test(text);
    const skillConstraint = /skill[- ]level[\s\S]{0,96}(?:互斥|constraint|conflict|incompat)|(?:互斥|constraint|conflict|incompat)[\s\S]{0,96}skill[- ]level/i.test(text);
    const explicitVerification = /(根因确认|已核验|verified root cause|root cause confirmed)/i.test(text);
    const webScopeConflict = /web_same_instance_rehydration/i.test(text) && /bind_existing/i.test(text) && /semantic_test_fixture/i.test(text);
    const confidence = hasPreflight && (skillConstraint || explicitVerification) ? 'high' : hasPreflight ? 'medium' : 'low';
    const stageLabel = String(stage).padStart(2, '0');
    const nextStageLabel = String(stage + 1).padStart(2, '0');
    candidates.push({
      score: (hasPreflight ? 4 : 0) + (skillConstraint ? 4 : 0) + (explicitVerification ? 3 : 0) + (webScopeConflict ? 2 : 0),
      observedAt: timestamp(run.last_heartbeat_at ?? run.completed_at ?? run.created_at),
      node: `Stage ${stageLabel}→${nextStageLabel} preflight 门禁`,
      cause: skillConstraint
        ? `门禁仍 ${gate[0].toUpperCase()}；运行消息标注为 Skill-level 互斥约束，非交付物缺陷。`
        : `门禁返回 ${gate[0].toUpperCase()}；需由门禁/Skill 维护方确认未通过规则。`,
      confidence,
      source: `Task ${run.id} 的运行消息`,
      evidence: [
        `Task ${run.id}：preflight decision=${gate[0].toUpperCase()}`,
        ...(skillConstraint ? ['运行消息声明为 Skill-level 互斥约束。'] : []),
        ...(webScopeConflict ? ['涉及 web_same_instance_rehydration、bind_existing 与 prerequisite:semantic_test_fixture。'] : [])
      ],
      actionKey: webScopeConflict ? 'stage_gate_scope' : 'stage_gate_review'
    });
  }
  return candidates.sort((left, right) => right.score - left.score || right.observedAt - left.observedAt)[0] ?? null;
}

function mostFrequent(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function readableExecutionContext({ issue, run, agent, messages, reason }) {
  if (!run) return null;
  const messageText = messageRows(messages).map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
  const text = [issue?.title, reason, run.result?.output, messageText].filter(Boolean).join('\n');
  const stageMatches = [...text.matchAll(/(?:^|[\\/\s])((?:0[1-9]|1[0-2])-[^\\/\n"\\]{1,42})/gm)]
    .map((match) => match[1].replace(/[，,。.;；:：]+$/, '').trim());
  const stage = mostFrequent(stageMatches);
  const subNode = mostFrequent([...text.matchAll(/(?:per-node|节点)[\\/]([^\\/\s"'`]+)/gi)].map((match) => match[1]));
  const route = mostFrequent([...text.matchAll(/\b(native[_-][a-z0-9_-]+_v\d+(?:\.\d+)*)\b/gi)].map((match) => match[1]));
  const gateCode = mostFrequent([
    ...text.matchAll(/\b([a-z][a-z0-9_-]*delivery_gate[a-z0-9_-]*)\b/gi),
    ...text.matchAll(/\b([a-z][a-z0-9_-]*(?:preflight|_gate)[a-z0-9_-]*)\b/gi)
  ].map((match) => match[1]));
  const hashLockMismatch = /(?:sha256|hash)[-_\s]*(?:lock|mismatch)|lock[^\n]{0,90}(?:lag|旧|old)|re-?pin/i.test(text);
  const agentName = agent?.name ?? '未识别执行 Agent';
  const location = [stage, subNode].filter(Boolean).join(' / ') || (run.heartbeat_stage && run.heartbeat_stage !== 'completed' ? run.heartbeat_stage : '未识别生产节点');
  const routeLabel = route ? `（${route}）` : '';
  const gateLabel = gateCode === 'native_audio_post_burned_delivery_gate'
    ? '字幕成片交付双重验证门禁'
    : gateCode ? `${gateCode} 门禁` : '下游交付/审核门禁';
  const nodeLabel = `${agentName} · ${location}${routeLabel}`;
  const completion = String(run.status ?? '').toLowerCase() === 'completed' ? '该节点执行已结束' : `该节点 Task 状态为 ${run.status ?? 'unknown'}`;
  const reviewAction = hashLockMismatch
    ? `需要交付协议 Skill 负责人审核并重新固定协议锁与当前门禁脚本哈希，然后重跑 ${gateLabel}。`
    : `需要 ${gateLabel} 的维护方审核下游条件并写回通过/阻断回执。`;
  return {
    taskId: run.id,
    agentName,
    stage,
    subNode,
    route,
    gateCode,
    gateLabel,
    nodeLabel,
    completion,
    reviewAction,
    requiresProtocolLockReview: hashLockMismatch && /(?:protocol|delivery-protocol|协议)/i.test(text),
    cause: hashLockMismatch
      ? `${completion}，但 ${gateLabel} 的协议锁与当前依赖哈希不一致，触发 fail-closed；这不是该节点交付物缺陷。`
      : `${completion}，仍等待 ${gateLabel} 的下游审核/回执。`
  };
}

function fallbackBlockerDiagnosis({ run, reason, candidate, context }) {
  if (!run) {
    return {
      node: '执行节点未采集',
      cause: 'Issue 已 blocked，但缺少对应 Task Run 和运行消息，不能确认具体卡点或根因。',
      confidence: 'low',
      source: 'Issue 状态',
      evidence: ['Issue status=blocked；未采集到 Task Run'],
      actionKey: 'collect_trace'
    };
  }
  const stage = context?.nodeLabel
    ? `${context.nodeLabel} · ${context.gateLabel}`
    : run.heartbeat_stage && run.heartbeat_stage !== 'completed'
      ? `执行节点 · ${run.heartbeat_stage}`
      : '已结束节点的下游恢复门禁';
  const runFailure = FAILURE_STATUSES.has(run.status) || run.error;
  return {
    node: stage,
    cause: context?.cause ?? (reason
      ? `Issue 声明的阻塞原因：${reason}`
      : runFailure
        ? `Task 失败信号：${excerpt(run.error || run.heartbeat_summary || run.status, 180)}`
        : candidate.detail),
    confidence: reason || runFailure ? 'medium' : candidate.confidence,
    source: context ? `${context.nodeLabel} 的运行证据` : reason ? 'Issue blocked_reason' : '最近执行节点的运行证据',
    evidence: [
      `Task ${run.id} · ${run.status ?? 'unknown'}`,
      ...(reason ? [`Issue blocked_reason=${reason}`] : [])
    ],
    actionKey: context?.requiresProtocolLockReview ? 'protocol_lock_review' : runFailure ? 'task_failure' : candidate.kind,
    gateLabel: context?.gateLabel ?? null
  };
}

function blockerRecoveryPlan({ diagnosis, candidate, run, agent }) {
  if (diagnosis.actionKey === 'protocol_lock_review') {
    return [{
      owner: '交付协议 Skill 负责人',
      action: `审核 ${diagnosis.gateLabel ?? '交付双重验证门禁'} 的依赖锁与当前生产 Skill 门禁脚本哈希；确认差异后重新固定锁并重跑该门禁。`,
      acceptance: '门禁不再因 dependency hash mismatch 而 fail-closed，新的门禁回执附回 Issue；无需重做已验收交付物。'
    }];
  }
  if (diagnosis.actionKey === 'stage_gate_scope') {
    return [
      {
        owner: '门禁 / Skill 发布方',
        action: '修改 web_same_instance_rehydration 的 scope：bind_existing web 按 bind_existing_scope 过滤，不再要求 semantic_test_fixture。',
        acceptance: '重跑 Stage preflight，web_same_instance_rehydration 不再为 not_evaluated。'
      },
      {
        owner: '门禁 / Skill 发布方',
        action: '在 preflight 决策中将 bind_existing 场景的 prerequisite:semantic_test_fixture 视为 deferred，而非 BLOCK 条件。',
        acceptance: 'preflight 不再返回 BLOCK_STAGE；同时保留 generate 场景的 semantic_test_fixture 校验。'
      },
      {
        owner: '项目经理',
        action: '仅在门禁复跑通过并写入新的回执后解除 blocked；不要重做已经验收的交付物。',
        acceptance: 'Issue 附上新门禁回执，状态恢复推进且可回放。'
      }
    ];
  }
  if (diagnosis.actionKey === 'runtime_identity_context') {
    return [{
      owner: '执行包装 / Agent 指令维护方',
      action: '在 Task 启动入口校验并记录 MULTICA_TASK_ID 与 canonical root；解析失败时直接失败返回，不进入后续生产。',
      acceptance: '重放同类 Task 时身份与工作目录均可解析，且日志包含可关联的 Task 标识。'
    }];
  }
  if (diagnosis.actionKey === 'dependency_or_wait') {
    return [{
      owner: '生产负责人',
      action: '在 Issue 中登记阻塞依赖、唯一 owner、恢复条件和预计复核时间；依赖未满足前不盲目重试。',
      acceptance: '依赖满足证据与恢复决定写回 Issue 或新运行消息。'
    }];
  }
  if (diagnosis.actionKey === 'task_failure') {
    return [{
      owner: agent?.name ?? '执行 Agent',
      action: '按 Task 错误定位输入、工具调用或下游返回值；修正后使用同一输入重放一次，避免直接批量重试。',
      acceptance: `新的 Task 成功结束，并且 ${run?.id ?? '原 Task'} 的失败原因有对应修复证据。`
    }];
  }
  return [{
    owner: diagnosis.actionKey === 'collect_trace' ? '采集与运行系统' : candidate.owner,
    action: diagnosis.actionKey === 'collect_trace'
      ? '补采该 Issue 的最近 Task Run、运行消息和下游门禁回执，再重新判断卡点。'
      : candidate.verification,
    acceptance: diagnosis.actionKey === 'collect_trace'
      ? '能够定位最近执行主体、Task 状态和至少一条过程证据。'
      : '复核结果写入 Issue 或新的运行消息，形成可回放的恢复证据。'
  }];
}

function blockerCandidate(signalText) {
  if (!signalText) {
    return {
      state: 'needs_evidence',
      kind: 'missing_causal_evidence',
      confidence: 'low',
      title: '尚不能判断直接阻塞原因',
      detail: '当前只有流程状态或 Task 元数据；没有足以归因的执行消息、失败回传或依赖确认。',
      owner: '待确认',
      verification: '补充最近 Task 的运行消息、交付物状态与下游依赖状态。'
    };
  }
  if (/(MULTICA_TASK_ID|identity resolution|canonical root|任务身份|工作目录.*解析)/i.test(signalText)) {
    return {
      state: 'candidate',
      kind: 'runtime_identity_context',
      confidence: 'medium',
      title: '候选：运行身份或工作目录关联未建立',
      detail: '运行消息指向任务身份或 canonical root 解析失败；这是日志陈述支持的候选归因，仍需复现或补充配置证据确认。',
      owner: '执行包装或 Agent 指令',
      verification: '在同一运行环境确认 MULTICA_TASK_ID 与 canonical root 均可解析，再重放该管理步骤。'
    };
  }
  if (/(blocked|阻塞|等待|wait|依赖|审批|人工|权限|不可用|unavailable|pending)/i.test(signalText)) {
    return {
      state: 'candidate',
      kind: 'dependency_or_wait',
      confidence: 'medium',
      title: '候选：下游依赖、人工决策或权限条件未满足',
      detail: '运行消息包含等待或依赖信号；不能仅凭该信号确定具体责任方，需由生产负责人核对依赖台账。',
      owner: '生产负责人',
      verification: '记录阻塞依赖、当前 owner、恢复条件，并确认依赖已满足后再恢复生产。'
    };
  }
  return {
    state: 'candidate',
    kind: 'runtime_context_needs_review',
    confidence: 'low',
    title: '候选：执行上下文需要人工复核',
    detail: '已采集到执行上下文，但其中没有可直接验证的阻塞类型；不将摘要文本直接视为根因。',
    owner: '执行 Agent 与生产负责人',
    verification: '核对 Task 输入、输出、交付物和下游状态，补充能证明恢复条件的记录。'
  };
}

function blockerEvidenceExtras({ issue, run, agent, issueRuns, messagesByRun, messageCount, signalText, reason, context = null }) {
  const runAt = run?.last_heartbeat_at ?? run?.completed_at ?? run?.created_at ?? null;
  const candidate = blockerCandidate(signalText);
  const hasRun = Boolean(run);
  const totalMessageCount = issueRuns.reduce((total, item) => total + runMessageCount(messagesByRun.get(item.id)), 0);
  const diagnosis = stageGateDiagnosis(issueRuns, messagesByRun) ?? fallbackBlockerDiagnosis({ run, reason, candidate, context });
  const recoveryPlan = blockerRecoveryPlan({ diagnosis, candidate, run, agent });
  const coverage = [
    {
      key: 'issue_state',
      label: '流程状态',
      available: true,
      detail: `Issue status=blocked${reason ? '，且已提供 blocked_reason' : '，但未提供 blocked_reason'}`
    },
    {
      key: 'task_run',
      label: 'Task 执行记录',
      available: hasRun,
      detail: hasRun ? `${context?.nodeLabel ?? '最近执行节点'} · ${run.status ?? 'unknown'}${context?.gateLabel ? ` · 待 ${context.gateLabel}` : ''}` : '当前采集范围没有该 Issue 的 Task Run'
    },
    {
      key: 'run_message',
      label: 'Agent 运行消息',
      available: totalMessageCount > 0,
      detail: totalMessageCount > 0 ? `已采集 ${totalMessageCount} 条运行消息（覆盖 ${issueRuns.filter((item) => runMessageCount(messagesByRun.get(item.id)) > 0).length} 条 Task）` : '未采集到对应 Task 的运行消息'
    },
    {
      key: 'causal_evidence',
      label: '可验证归因',
      available: diagnosis.confidence === 'high' || diagnosis.confidence === 'medium',
      detail: diagnosis.confidence === 'high' ? `已命中 ${diagnosis.source} 中的明确门禁/根因说明` : diagnosis.confidence === 'medium' ? '存在待复核的流程、失败或依赖信号，不等同于已确认根因' : '当前没有足以确认直接根因的证据'
    }
  ];
  const timeline = [
    {
      at: issue.updated_at ?? null,
      source: 'Issue 状态',
      certainty: 'confirmed',
      statement: '生产单被显式标记为 blocked'
    },
    ...(hasRun ? [{
      at: runAt,
      source: 'Task Run',
      certainty: 'confirmed',
      statement: context ? `${context.nodeLabel}：${context.completion}${context.gateLabel ? `，后续为 ${context.gateLabel}` : ''}` : `最近执行节点状态为 ${run.status ?? 'unknown'}`
    }] : []),
    ...(totalMessageCount > 0 ? [{
      at: null,
      source: 'Agent 运行消息',
      certainty: 'observed',
      statement: `已采集 ${totalMessageCount} 条消息；原文用于支撑候选归因，不直接等同根因。`
    }] : [])
  ];
  return {
    schema: 'rpg-blocker-evidence/v1',
    conclusion: {
      state: 'confirmed',
      title: '已确认：生产单处于 blocked',
      detail: '这是流程状态事实；它不自动证明 Agent、Skill 或基础服务是直接根因。'
    },
    confidenceDetail: {
      chain: hasRun ? (messageCount > 0 ? 'high' : 'medium') : 'low',
      cause: candidate.confidence
    },
    candidate,
    diagnosis,
    coverage,
    timeline,
    recoveryPlan
  };
}

export function buildBlockingExecutionEvidence(issue, issueRuns, messagesByRun, agentsById, nowMs) {  const run = latestRun(issueRuns);
  const agent = run ? agentsById.get(run.agent_id) : agentsById.get(issue.assignee_id);
  const reason = blockedReason(issue);
  const evidence = [`Issue 状态：blocked`, `Issue 最后更新：${issue.updated_at ?? '未知'}`];
  const reasons = [{
    kind: 'workflow_state',
    title: '生产单被显式标记为 blocked',
    detail: reason ? `阻塞原因：${reason}` : 'Issue 未填写 blocked_reason，需要结合执行链确认恢复条件。',
    evidence: [`Issue status=blocked${reason ? `；blocked_reason=${reason}` : ''}`]
  }];
  if (!run) {
    reasons.push({
      kind: 'missing_execution_trace',
      title: '未采集到对应 Agent 的 Task Run',
      detail: '当前只能确认流程状态为 blocked，无法据此推断具体执行根因。',
      evidence: ['当前采集范围没有该 Issue 的 Run 记录']
    });
    return {
      run: null,
      agent: agent ?? null,
      evidence,
      detail: '生产单已处于 blocked；当前缺少对应 Task Run，需要补采执行日志后才能判断根因。',
      analysis: {
        confidence: 'low',
        summary: '已确认流程阻塞，但缺少执行日志，不能把阻塞简单归因为报错或 Agent 失效。',
        agentName: agent?.name ?? null,
        reasons,
        recoveryHint: '补采该生产线最近一次 Agent Run 与运行消息，确认依赖、人工决策或工具故障后再恢复。',
        ...blockerEvidenceExtras({
          issue,
          run: null,
          agent,
          issueRuns,
          messagesByRun,
          messageCount: 0,
          signalText: '',
          reason
        })
      }
    };
  }

  const runAt = run.last_heartbeat_at ?? run.completed_at ?? run.created_at;
  const messages = messagesByRun.get(run.id);
  const messageCount = runMessageCount(messages);
  const context = readableExecutionContext({ issue, run, agent, messages, reason });
  const runText = recentText(run, messageCount ? messages : null);
  const signalText = excerpt(runText, 220);
  const signalSource = messageCount ? 'Agent 运行消息' : 'Task 回传字段';
  const runStatus = run.status ?? 'unknown';
  evidence.push(`执行 Agent：${agent?.name ?? run.agent_id ?? '未识别'}`, `执行节点：${context?.nodeLabel ?? '未识别'} · ${runStatus}`, `最近心跳：${runAt ?? '未知'}`);
  reasons.push({
    kind: 'execution_chain',
    title: context?.nodeLabel ?? `最近执行来自 ${agent?.name ?? '未识别 Agent'}`,
    detail: context ? `${context.completion}${context.gateLabel ? `；后续门禁：${context.gateLabel}。` : ''}` : `执行状态为 ${runStatus}${run.heartbeat_stage ? `，阶段：${run.heartbeat_stage}` : ''}。`,
    evidence: [`Task ID=${run.id}`, `status=${runStatus}`, `last_heartbeat_at=${runAt ?? '未知'}`]
  });
  if (FAILURE_STATUSES.has(runStatus) || run.error) {
    const error = excerpt(run.error || run.heartbeat_summary || 'Task 标记失败', 180);
    evidence.push(`执行异常信号：${error}`);
    reasons.push({
      kind: 'execution_failure',
      title: '执行链出现失败信号',
      detail: error,
      evidence: [`Task error/status：${error}`]
    });
  } else if (RUNNING_STATUSES.has(runStatus)) {
    const age = nowMs - timestamp(runAt);
    evidence.push(`Task 仍在运行，距最近心跳：${duration(age)}`);
    reasons.push({
      kind: 'running_without_resolution',
      title: 'Task 尚未形成恢复结论',
      detail: `Task 仍为 ${runStatus}，距最近心跳 ${duration(age)}。`,
      evidence: [`Task status=${runStatus}`, `last_heartbeat_at=${runAt ?? '未知'}`]
    });
  } else {
    reasons.push({
      kind: 'post_run_block',
      title: context?.gateLabel ? `${context.gateLabel} 尚未关闭` : '已结束节点的下游条件尚未关闭',
      detail: context?.reviewAction ?? '需要检查该节点的交付物、下游依赖或人工审核条件，不能仅依据已结束状态判定已恢复。',
      evidence: [`Task ID=${run.id}`, `Task status=${runStatus}`]
    });
  }
  if (signalText) {
    const candidateKind = blockerCandidate(signalText).kind;
    const category = candidateKind === 'runtime_identity_context'
      ? 'runtime_identity_context'
      : candidateKind === 'dependency_or_wait'
        ? 'dependency_or_wait'
        : 'runtime_excerpt';
    evidence.push(`${signalSource}摘录：${signalText}`);
    reasons.push({
      kind: category,
      title: category === 'runtime_identity_context'
        ? `${signalSource}出现运行身份或工作目录信号`
        : category === 'dependency_or_wait'
          ? `${signalSource}出现等待或依赖信号`
          : `已保留${signalSource}摘录`,
      detail: signalText,
      evidence: [`来源：${signalSource}`, signalText]
    });
  }
  if (!messageCount) {
    reasons.push({
      kind: 'message_gap',
      title: '未采集到最近 Run 消息',
      detail: '已保留 Run 状态与心跳，但缺少 Agent 的过程说明。',
      evidence: [`Task=${run.id} 未命中 run-messages 采集范围`]
    });
  }
  return {
    run,
    agent: agent ?? null,
    evidence,
    detail: `生产单已被标记为 blocked；最近执行节点为 ${context?.nodeLabel ?? agent?.name ?? '未识别'}，状态为 ${runStatus}。请按门禁证据确认恢复条件。`,
    analysis: {
      confidence: messageCount && signalText ? 'high' : 'medium',
      summary: `阻塞结论来自 Issue 状态与对应 Agent 的最近 Task 链，而非仅凭一条报错文本。`,
      agentName: agent?.name ?? null,
      taskId: run.id,
      executionContext: context,
      reasons,
      recoveryHint: reason ?? '先确认最近 Task 的失败、等待或下游交付状态，再决定重试、补依赖或转人工。',
      ...blockerEvidenceExtras({
          issue,
          run,
          agent,
          issueRuns,
          messagesByRun,
        messageCount,
        signalText,
        reason,
        context
      })
    }
  };
}

// The realtime source used for live risk detection rarely retains the terminal
// Run/message history Multica has already cleaned up. Historical line evidence
// is merged into `lineSource` for production KPI, Agent and Skill assembly, but
// blocked-Issue analysis must not be left with the realtime-only "no trace"
// fallback. Re-run only the blocked incidents' evidence chain against the
// merged source, replacing run / agent / evidence / analysis without touching
// any other realtime risk state.
export function refineBlockedIncidentEvidence(snapshot, lineSource, agentsById, nowMs) {
  const runsByIssue = new Map();
  for (const [issueId, value] of (lineSource?.runsByIssue ?? new Map()).entries()) {
    runsByIssue.set(issueId, Array.isArray(value) ? value : (value?.items ?? []));
  }
  const refined = [];
  for (const incident of snapshot?.incidents ?? []) {
    if (incident.kind !== 'production_blocked' || !incident.issue?.id) continue;
    const issue = (lineSource?.issues ?? []).find((candidate) => candidate.id === incident.issue.id);
    if (!issue) continue;
    const issueRuns = runsByIssue.get(issue.id) ?? [];
    const chain = buildBlockingExecutionEvidence(issue, issueRuns, lineSource.messagesByRun ?? new Map(), agentsById ?? new Map(), nowMs);
    incident.detail = chain.detail;
    incident.run = chain.run ? { id: chain.run.id, status: chain.run.status, agentId: chain.run.agent_id, lastHeartbeatAt: chain.run.last_heartbeat_at } : null;
    incident.agent = chain.agent ? { id: chain.agent.id, name: chain.agent.name } : null;
    incident.evidence = chain.evidence;
    incident.analysis = chain.analysis;
    refined.push({ issueId: issue.id, identifier: issue.identifier ?? issue.id, hasRun: Boolean(chain.run), confidence: chain.analysis?.confidence ?? 'low' });
  }
  return refined;
}

function describeAgentAnomaly({ agentIncidents, progressEvents, failedRuns, terminalRuns, bindings, publishedBindings, confidence, status }) {
  const reasons = [];
  const blocked = progressEvents.filter((item) => item.kind === 'production_blocked');
  const slow = progressEvents.filter((item) => item.kind === 'no_progress');
  const execution = agentIncidents.filter((item) => ['task_failure', 'retry_loop', 'task_timeout'].includes(item.kind));
  if (blocked.length) reasons.push({
    severity: 'critical',
    title: `关联 ${blocked.length} 条已阻塞生产线`,
    detail: blocked.map((item) => item.issue?.identifier ?? item.issue?.id).filter(Boolean).slice(0, 4).join('、'),
    evidence: blocked.slice(0, 4).flatMap((item) => item.evidence ?? [])
  });
  if (execution.length) reasons.push({
    severity: 'warning',
    title: `近窗口有 ${execution.length} 条执行异常`,
    detail: execution.map((item) => item.title).slice(0, 2).join('；'),
    evidence: execution.slice(0, 3).flatMap((item) => item.evidence ?? [])
  });
  if (slow.length) reasons.push({
    severity: 'warning',
    title: `负责生产单中有 ${slow.length} 条推进偏慢`,
    detail: '这是推进风险，不等同于生产阻塞。',
    evidence: slow.slice(0, 3).flatMap((item) => item.evidence ?? [])
  });
  if (terminalRuns.length && failedRuns.length) reasons.push({
    severity: 'warning',
    title: `近窗口 Task 成功率 ${Math.round((terminalRuns.length - failedRuns.length) / terminalRuns.length * 100)}%`,
    detail: `${failedRuns.length}/${terminalRuns.length} 条终态 Task 以失败结束。`,
    evidence: []
  });
  if (bindings.length && publishedBindings.length < bindings.length) reasons.push({
    severity: 'warning',
    title: `绑定 Skill 发布就绪 ${Math.round(publishedBindings.length / bindings.length * 100)}%`,
    detail: `${bindings.length - publishedBindings.length} 个已绑定 Skill 尚未发布。`,
    evidence: []
  });
  if (!reasons.length && confidence < 40) reasons.push({
    severity: 'info',
    title: '当前证据不足，暂不下健康结论',
    detail: '缺少近窗口终态 Run、直接负责生产单或绑定发布状态中的足够证据。',
    evidence: []
  });
  const summary = reasons.length
    ? reasons.slice(0, 2).map((item) => item.title).join('；')
    : status === 'healthy' ? '当前可观测窗口没有发现执行或推进异常。' : '当前没有足够证据说明异常原因。';
  return { summary, reasons };
}

export function buildHealthSnapshot(source, options) {
  const now = options.now ? new Date(options.now) : new Date();
  const nowMs = now.getTime();
  const incidentLookbackMs = options.incidentLookbackMs ?? 24 * 60 * 60 * 1000;
  const agentsById = new Map(source.agents.map((agent) => [agent.id, agent]));
  const issuesById = new Map(source.issues.map((issue) => [issue.id, issue]));
  const runs = [...source.runsByIssue.entries()].flatMap(([issueId, value]) => {
    const records = Array.isArray(value) ? value : value.items ?? [];
    // The issue-runs endpoint used to collect this record is the ownership
    // boundary. An embedded issue_id can be stale and must not reassign the
    // run into another Issue's causal chain.
    return records.map((run) => ({
      ...run,
      reported_issue_id: run.issue_id ?? null,
      issue_id: issueId
    }));
  });
  const scopedAgentIds = new Set(source.scope?.agentIds ?? source.agents.map((agent) => agent.id));
  const usage = aggregateSkillUsage(source.skills, runs, source.messagesByRun, scopedAgentIds, source.performanceScope);
  const observedUsageBySkill = new Map(usage.map((item) => [item.id, item]));
  // A Skill belongs to this dashboard only when a target-squad Agent made an
  // explicit Skill-tool call while handling a directly assigned Issue.
  const visibleSkills = source.skills.filter((skill) => observedUsageBySkill.has(skill.id));
  let incidents = [];
  const failureGroups = new Map();

  for (const run of runs) {
    const issue = issuesById.get(run.issue_id);
    const agent = agentsById.get(run.agent_id);
    const lastHeartbeat = timestamp(run.last_heartbeat_at ?? run.started_at ?? run.created_at);
    if ((FAILURE_STATUSES.has(run.status) || run.error) && lastHeartbeat >= nowMs - incidentLookbackMs) {
      const fingerprint = excerpt(run.error || run.heartbeat_summary || run.status, 96).toLowerCase();
      const key = `${run.issue_id}:${run.agent_id}:${fingerprint}`;
      const group = failureGroups.get(key) ?? [];
      group.push(run);
      failureGroups.set(key, group);
    }
    if (RUNNING_STATUSES.has(run.status) && lastHeartbeat && nowMs - lastHeartbeat > options.runTimeoutMs) {
      incidents.push(event({
        id: `timeout:${run.id}`,
        severity: 'critical',
        kind: 'task_timeout',
        title: '任务心跳超时',
        detail: `最后心跳距今 ${duration(nowMs - lastHeartbeat)}，超过 ${duration(options.runTimeoutMs)} 的运行阈值。`,
        issue,
        run,
        agent,
        evidence: [`最后心跳：${run.last_heartbeat_at ?? '无'}`, `Task 状态：${run.status}`]
      }));
    }
  }

  for (const [key, retries] of failureGroups) {
    const run = retries[0];
    const issue = issuesById.get(run.issue_id);
    const agent = agentsById.get(run.agent_id);
    incidents.push(event({
      id: `failure:${key}`,
      severity: 'critical',
      kind: retries.length >= 3 ? 'retry_loop' : 'task_failure',
      title: retries.length >= 3 ? '检测到同因重复失败' : '任务执行失败',
      detail: retries.length >= 3
        ? `同一 Issue / Agent / 错误指纹在 ${duration(incidentLookbackMs)} 内失败 ${retries.length} 次；应停止盲目重试并排查根因。`
        : `最近 ${duration(incidentLookbackMs)} 内发生失败：${excerpt(run.error || run.heartbeat_summary || run.status)}。`,
      issue,
      run,
      agent,
      evidence: retries.map((item) => `Task ${item.id}：${excerpt(item.error || item.heartbeat_summary || item.status, 90)}`)
    }));
  }

  const activeIssues = source.issues.filter((issue) => ACTIVE_ISSUE_STATUSES.has(issue.status));
  // 审核中是独立运营队列，不作为生产风险或“无推进”事件处理。
  const progressTrackedIssues = activeIssues.filter((issue) => ['in_progress', 'blocked'].includes(issue.status));
  for (const issue of progressTrackedIssues) {
    const issueRuns = runs.filter((run) => run.issue_id === issue.id);
    const latestRun = [...issueRuns].sort((left, right) => timestamp(right.last_heartbeat_at ?? right.updated_at ?? right.created_at) - timestamp(left.last_heartbeat_at ?? left.updated_at ?? left.created_at))[0];
    const progressAt = Math.max(timestamp(issue.updated_at), timestamp(latestRun?.last_heartbeat_at ?? latestRun?.completed_at ?? latestRun?.created_at));
    const age = progressAt ? nowMs - progressAt : Number.POSITIVE_INFINITY;
    const agent = latestRun ? agentsById.get(latestRun.agent_id) : null;
    if (issue.status === 'blocked') {
      incidents.push(event({
        id: `blocked:${issue.id}`,
        severity: 'critical',
        kind: 'production_blocked',
        title: '生产单处于阻塞状态',
        detail: `最近有效更新距今 ${duration(age)}。${issue.metadata?.blocked_reason ? `原因：${issue.metadata.blocked_reason}` : '请通过 Issue 与最近 Task 证据确认恢复条件。'}`,
        issue,
        run: latestRun,
        agent,
        evidence: [`Issue 状态：blocked`, `最后更新：${issue.updated_at ?? '无'}`]
      }));
    } else if (age > options.stallCriticalMs) {
      incidents.push(event({
        id: `stalled-critical:${issue.id}`,
        severity: 'critical',
        kind: 'no_progress',
        title: '生产单长期无有效推进',
        detail: `最近有效更新距今 ${duration(age)}，超过红灯阈值 ${duration(options.stallCriticalMs)}。`,
        issue,
        run: latestRun,
        agent,
        evidence: [`Issue 状态：${issue.status}`, `最后更新：${issue.updated_at ?? '无'}`]
      }));
    } else if (age > options.stallWarningMs) {
      incidents.push(event({
        id: `stalled-warning:${issue.id}`,
        severity: 'warning',
        kind: 'no_progress',
        title: '生产单推进偏慢',
        detail: `最近有效更新距今 ${duration(age)}，超过黄灯阈值 ${duration(options.stallWarningMs)}。`,
        issue,
        run: latestRun,
        agent,
        evidence: [`Issue 状态：${issue.status}`, `最后更新：${issue.updated_at ?? '无'}`]
      }));
    }
  }

  // “重要风险”只对应生产单的明确 blocked 状态。执行失败、超时和推进变慢需要
  // 处理，但在没有状态级阻塞证据时只能作为告警，不能冒充生产线已被阻塞。
  for (const incident of incidents) {
    if (incident.kind === 'production_blocked') {
      const issue = issuesById.get(incident.issue?.id);
      const issueRuns = runs.filter((run) => run.issue_id === issue?.id);
      const chain = buildBlockingExecutionEvidence(issue, issueRuns, source.messagesByRun, agentsById, nowMs);
      incident.detail = chain.detail;
      incident.run = chain.run ? { id: chain.run.id, status: chain.run.status, agentId: chain.run.agent_id, lastHeartbeatAt: chain.run.last_heartbeat_at } : null;
      incident.agent = chain.agent ? { id: chain.agent.id, name: chain.agent.name } : null;
      incident.evidence = chain.evidence;
      incident.analysis = chain.analysis;
      continue;
    }
    if (incident.severity === 'critical') incident.severity = 'warning';
    if (incident.kind === 'no_progress') {
      incident.title = '生产单长期无推进（推进风险）';
      incident.detail = `${incident.detail} 审核中状态不纳入该规则。`;
    }
  }

  const unpublishedSkills = visibleSkills.filter((skill) => skill.has_draft && !skill.published_at);
  if (unpublishedSkills.length) {
    incidents.push(event({
      id: 'unpublished-skills',
      severity: 'warning',
      kind: 'skill_unpublished',
      title: '存在仅草稿、未发布的 Skill',
      detail: `${unpublishedSkills.length} 个 Skill 有草稿但没有已发布版本；这是运行时可用性风险，不等同于当前生产故障。`,
      evidence: unpublishedSkills.slice(0, 12).map((skill) => `${skill.name} · ${skill.id}`)
    }));
  }

  for (const service of options.serviceChecks) {
    if (service.status === 'healthy') continue;
    incidents.push(event({
      id: `service:${service.serviceName}`,
      severity: 'warning',
      kind: 'service_health',
      title: `基础服务异常：${service.serviceName}`,
      detail: service.detail || '探针没有返回健康结果。',
      evidence: [`探针状态：${service.status}`, `检测时间：${service.checkedAt}`]
    }));
  }

  incidents = consolidateIssueIncidents(incidents);

  const criticalCount = incidents.filter((item) => item.severity === 'critical').length;
  const warningCount = incidents.filter((item) => item.severity === 'warning').length;
  const healthScore = Math.max(0, 100 - Math.min(70, criticalCount * 8) - Math.min(20, warningCount * 2));
  const status = criticalCount ? 'critical' : warningCount ? 'warning' : 'healthy';
  const productionPerformanceBySkill = granularProductionPerformance(source.skills, runs, source.messagesByRun, source.performanceScope, scopedAgentIds);
  const linePerformance = productionLinePerformance(source.issues, runs, source.messagesByRun, {
    nowMs,
    nodeStallMs: options.lineNodeStallMs ?? 4 * 60 * 60 * 1000
  });
  // `source.issues` is already the collection's production population: only
  // Issues directly assigned to the target production squad enter the source.
  // Keep the explicit name here so dashboard consumers never mistake this for
  // a workspace-wide Issue-status count.
  const productionIssues = source.issues;
  const issueStatusCounts = Object.fromEntries(productionIssues.reduce((groups, issue) => {
    groups.set(issue.status || 'unknown', (groups.get(issue.status || 'unknown') ?? 0) + 1);
    return groups;
  }, new Map()));
  const reviewIssues = productionIssues
    .filter((issue) => issue.status === 'in_review')
    .sort((left, right) => timestamp(left.updated_at) - timestamp(right.updated_at))
    .slice(0, 8)
    .map((issue) => ({ id: issue.id, identifier: issue.identifier, title: issue.title, updatedAt: issue.updated_at, assigneeId: issue.assignee_id ?? null }));
  const skillById = new Map(source.skills.map((skill) => [skill.id, skill]));
  const boundAgentsBySkill = new Map(source.skills.map((skill) => [skill.id, []]));
  for (const agent of source.agents) {
    for (const binding of agent.skills ?? []) {
      if (boundAgentsBySkill.has(binding.id)) boundAgentsBySkill.get(binding.id).push(agent);
    }
  }
  // "关联 Skill" = 至少一个小队 Agent 绑定的 Skill，或在本小队直接指派
  // Issue 中有显式调用证据的 Skill（并集）。它是有显式调用 Skill 的超集：
  // 默认展示范围仍只列出有调用证据的 Skill，但“全部关联 Skill”筛选和总数
  // 必须覆盖所有绑定 Skill，否则绑定关系会从目录里消失。
  const relatedSkills = source.skills.filter((skill) => (boundAgentsBySkill.get(skill.id) ?? []).length > 0 || observedUsageBySkill.has(skill.id));
  const evaluationsBySkill = new Map();
  for (const evaluation of options.skillEvaluations ?? []) {
    const current = evaluationsBySkill.get(evaluation.skillId) ?? [];
    current.push(evaluation);
    evaluationsBySkill.set(evaluation.skillId, current);
  }
  const skillAssessments = relatedSkills.map((skill) => {
    const bindings = boundAgentsBySkill.get(skill.id) ?? [];
    const usageRecord = observedUsageBySkill.get(skill.id);
    const evaluation = latestByTime(evaluationsBySkill.get(skill.id) ?? []);
    const productionPerformance = productionPerformanceBySkill.get(skill.id) ?? null;
    const totalCases = evaluation?.total ?? 0;
    const passRate = totalCases ? clampPercent(evaluation.passed / totalCases * 100) : null;
    const qualityScore = passRate == null ? null : evaluation.criticalFailures > 0 ? Math.min(passRate, 50) : passRate;
    const runtimeScore = usageRecord ? usageRecord.successRate : null;
    const operationalAssessment = assess([
      { key: 'released', label: '发布就绪', weight: 15, value: skill.published_at ? 100 : 0, coverage: 1 },
      { key: 'bound', label: '绑定覆盖', weight: 5, value: bindings.length ? 100 : 0, coverage: 1 },
      { key: 'runtime', label: '运行可靠性', weight: 40, value: runtimeScore, coverage: usageRecord ? Math.min(1, usageRecord.observedCalls / 5) : 0 },
      { key: 'quality', label: '回归质量', weight: 40, value: qualityScore, coverage: evaluation ? 1 : 0 }
    ]);
    const darwin = applyDarwinEvidence(skill.darwinAudit, {
      productionPerformance,
      architectureReview: skill.architectureReview
    });
    const darwinScore = darwin?.score == null ? null : Math.round(darwin.score * 10);
    const hasCritical = incidents.some((item) => item.skill?.id === skill.id && item.severity === 'critical');
    const status = assessmentStatus(operationalAssessment, hasCritical);
    return {
      id: skill.id,
      name: skill.name,
      // The top-level score is deliberately Darwin-aligned. Operational health
      // remains separate, so missing test prompts cannot look like a bad score.
      score: darwinScore,
      confidence: darwin?.coverage ?? 0,
      grade: darwin ? assessmentGrade({ score: darwinScore, confidence: darwin.coverage }) : 'insufficient_evidence',
      status,
      publishedAt: skill.published_at,
      hasDraft: Boolean(skill.has_draft),
      boundAgentCount: bindings.length,
      observedCalls: usageRecord?.observedCalls ?? 0,
      implicitEvidenceRuns: usageRecord?.implicitEvidenceRuns ?? 0,
      evidenceMode: usageRecord?.evidenceMode ?? 'none',
      runtimeSuccessRate: runtimeScore,
      productionPerformance,
      regression: evaluation ? { suite: evaluation.suite ?? '未命名回归集', executedAt: evaluation.executedAt ?? evaluation.executed_at, passed: evaluation.passed, total: evaluation.total, criticalFailures: evaluation.criticalFailures ?? 0, score: qualityScore, evidenceUrl: evaluation.evidenceUrl ?? null } : null,
      darwin: darwin ? {
        schema: darwin.schema,
        score: darwinScore,
        coverage: darwin.coverage,
        missingWeight: darwin.missingWeight,
        mode: darwin.mode,
        auditedAt: darwin.auditedAt,
        content: darwin.content,
        runtimeGate: darwin.runtimeGate,
        architectureReview: skill.architectureReview,
        dimensions: darwin.dimensions.map((dimension) => ({
          ...dimension,
          score: dimension.score == null ? null : Math.round(dimension.score * 10)
        }))
      } : null,
      operational: {
        score: operationalAssessment.score,
        confidence: operationalAssessment.confidence,
        grade: assessmentGrade(operationalAssessment),
        dimensions: operationalAssessment.dimensions
      },
      dimensions: darwin?.dimensions.map((dimension) => ({ ...dimension, score: dimension.score == null ? null : Math.round(dimension.score * 10) })) ?? []
    };
  }).sort((left, right) => {
    const severity = { critical: 0, warning: 1, unknown: 2, healthy: 3 };
    return severity[left.status] - severity[right.status] || left.confidence - right.confidence || (left.score ?? 101) - (right.score ?? 101) || left.name.localeCompare(right.name, 'zh-CN');
  });
  const performanceObservedSkills = skillAssessments.filter((skill) => skill.productionPerformance?.observedRuns > 0);
  const performanceScoredSkills = performanceObservedSkills.filter((skill) => skill.productionPerformance?.sampleSufficient);

  const agentAnalysisLookbackMs = options.agentAnalysisLookbackMs ?? incidentLookbackMs;
  const agentAnalysisWindowHours = Math.round(agentAnalysisLookbackMs / 3_600_000);
  const agentRows = source.agents.map((agent) => {
    const agentRuns = runs.filter((run) => run.agent_id === agent.id);
    // Window membership uses the Run's effective lifecycle time (completion /
    // last heartbeat / start / creation) so a settled Run cannot drift out of
    // the 7-day analysis window on a stale heartbeat column.
    const recentRuns = agentRuns.filter((run) => runEffectiveTime(run) >= nowMs - agentAnalysisLookbackMs);
    // Only terminal Runs enter the success/failure rate. Running Runs count as
    // observed coverage but are never guessed as either success or failure.
    const terminalRuns = recentRuns.filter((run) => run.status === 'completed' || AGENT_FAILURE_STATUSES.has(run.status) || run.error);
    const failedRuns = terminalRuns.filter((run) => AGENT_FAILURE_STATUSES.has(run.status) || run.error);
    const activeRuns = recentRuns.filter((run) => RUNNING_STATUSES.has(run.status));
    const timeoutCount = incidents.filter((item) => item.kind === 'task_timeout' && item.agent?.id === agent.id).length;
    const directIssues = progressTrackedIssues.filter((issue) => issue.assignee_id === agent.id);
    const progressEvents = incidents.filter((item) => ['no_progress', 'production_blocked'].includes(item.kind) && item.issue && directIssues.some((issue) => issue.id === item.issue.id));
    const bindings = agent.skills ?? [];
    const publishedBindings = bindings.filter((binding) => skillById.get(binding.id)?.published_at).length;
    const agentIncidents = incidents.filter((item) => item.agent?.id === agent.id);
    const assessment = assess([
      { key: 'reliability', label: '任务成功率', weight: 40, value: terminalRuns.length ? (terminalRuns.length - failedRuns.length) / terminalRuns.length * 100 : null, coverage: terminalRuns.length ? Math.min(1, terminalRuns.length / 5) : 0 },
      { key: 'timeliness', label: '运行时效', weight: 20, value: activeRuns.length ? (timeoutCount ? 0 : 100) : null, coverage: activeRuns.length ? 1 : 0 },
      { key: 'progress', label: '负责生产单推进', weight: 25, value: directIssues.length ? clampPercent(100 - progressEvents.length / directIssues.length * 100) : null, coverage: directIssues.length ? 1 : 0 },
      { key: 'skillReadiness', label: '绑定 Skill 发布就绪', weight: 15, value: bindings.length ? publishedBindings / bindings.length * 100 : null, coverage: bindings.length ? 1 : 0 }
    ]);
    const hasCritical = agentIncidents.some((item) => item.severity === 'critical') || progressEvents.some((item) => item.severity === 'critical');
    const status = assessmentStatus(assessment, hasCritical);
    const anomaly = describeAgentAnomaly({
      agentIncidents,
      progressEvents,
      failedRuns,
      terminalRuns,
      bindings,
      publishedBindings,
      confidence: assessment.confidence,
      status
    });
    return {
      id: agent.id,
      name: agent.name,
      platformStatus: agent.status,
      model: agent.model || '未配置',
      skillCount: bindings.length,
      runs: agentRuns.length,
      recentRuns: recentRuns.length,
      analysisWindowHours: agentAnalysisWindowHours,
      failedRuns: failedRuns.length,
      incidents: agentIncidents.length + progressEvents.length,
      score: assessment.score,
      confidence: assessment.confidence,
      grade: assessmentGrade(assessment),
      status,
      reliability: terminalRuns.length ? Math.round((terminalRuns.length - failedRuns.length) / terminalRuns.length * 100) : null,
      directIssueCount: directIssues.length,
      progressRiskCount: progressEvents.length,
      publishedBindingRate: bindings.length ? Math.round(publishedBindings / bindings.length * 100) : null,
      anomalySummary: anomaly.summary,
      anomalyReasons: anomaly.reasons,
      dimensions: assessment.dimensions,
      updatedAt: agent.updated_at
    };
  }).sort((left, right) => {
    const severity = { critical: 0, warning: 1, unknown: 2, healthy: 3 };
    return severity[left.status] - severity[right.status] || left.confidence - right.confidence || (left.score ?? 101) - (right.score ?? 101) || left.name.localeCompare(right.name, 'zh-CN');
  });
  const stageRows = Object.entries(runs.reduce((groups, run) => {
    const stage = run.heartbeat_stage || '未标注阶段';
    const value = groups.get(stage) ?? { stage, total: 0, completed: 0, failed: 0, running: 0 };
    value.total += 1;
    value.completed += run.status === 'completed' ? 1 : 0;
    value.failed += FAILURE_STATUSES.has(run.status) || run.error ? 1 : 0;
    value.running += RUNNING_STATUSES.has(run.status) ? 1 : 0;
    groups.set(stage, value);
    return groups;
  }, new Map())).map(([, value]) => value).sort((left, right) => right.total - left.total);

  return {
    generatedAt: now.toISOString(),
    workspace: {
      id: source.workspace.id,
      name: source.workspace.name,
      slug: source.workspace.slug,
      issueTotal: source.issueTotal,
      scope: source.scope ?? null
    },
    overview: { status, score: healthScore, criticalCount, warningCount, activeIssues: activeIssues.length, observedRuns: runs.length },
    production: {
      issueStatusCounts,
      productionIssueCount: productionIssues.length,
      activeIssues: activeIssues.length,
      blockedIssues: productionIssues.filter((issue) => issue.status === 'blocked').length,
      reviewCount: productionIssues.filter((issue) => issue.status === 'in_review').length,
      reviewIssues,
      stages: stageRows,
      linePerformance
    },
    agents: agentRows,
    skills: {
      // total = 关联 Skill 总数（至少一个小队 Agent 绑定的 Skill）。
      // called = 其中有显式调用证据的 Skill（默认展示范围）。
      total: relatedSkills.length,
      called: visibleSkills.length,
      explicitObserved: usage.filter((skill) => skill.observedCalls > 0).length,
      implicitObserved: usage.filter((skill) => skill.implicitEvidenceRuns > 0).length,
      published: relatedSkills.filter((skill) => skill.published_at).length,
      draft: relatedSkills.filter((skill) => skill.has_draft).length,
      unpublished: relatedSkills.filter((skill) => skill.has_draft && !skill.published_at).length,
      observedUsage: usage,
      assessments: skillAssessments,
      performanceEvaluation: {
        scopeSkillCount: relatedSkills.length,
        observedSkillCount: performanceObservedSkills.length,
        unobservedSkillCount: relatedSkills.length - performanceObservedSkills.length,
        scoredSkillCount: performanceScoredSkills.length,
        observedRunCount: performanceObservedSkills.reduce((total, skill) => total + skill.productionPerformance.observedRuns, 0),
        terminalRunCount: performanceObservedSkills.reduce((total, skill) => total + skill.productionPerformance.terminalCalls, 0),
        nonTerminalRunCount: performanceObservedSkills.reduce((total, skill) => total + skill.productionPerformance.nonTerminalCalls, 0)
      },
      evaluated: skillAssessments.filter((skill) => skill.regression).length,
      darwinAudited: skillAssessments.filter((skill) => skill.darwin).length,
      performanceScope: source.performanceScope ?? null,
      scoringModel: {
        name: 'Darwin 对齐 Skill 评价 v1',
        dimensions: ['Frontmatter 7%', '工作流清晰度 12%', '失败模式编码 12%', '检查点 6%', '可执行具体性 18%', '资源整合 4%', '整体架构 12%', '实测表现 23%', '反例与黑名单 6%'],
        caveat: 'Skill 覆盖该小队直接指派的全部 Issue：仅计小队成员产生的显式 Skill 工具调用。终态与非终态均计入覆盖；结果分只以至少 3 个终态 Run 计算。',
        operationalModel: ['发布就绪 15%', '绑定覆盖 5%', '运行可靠性 40%', '固定回归质量 40%']
      },
      note: '关联 Skill 目录覆盖至少一个小队 Agent 绑定的全部 Skill；调用次数只统计显式调用（Run 消息中的 Skill 工具调用）。任务描述、回传文本或消息中的同名文本均不计入调用，也不会补全目录。'
    },
    services: options.serviceChecks,
    incidents: incidents.sort((left, right) => (left.severity === right.severity ? left.title.localeCompare(right.title, 'zh-CN') : left.severity === 'critical' ? -1 : 1)),
    coverage: {
      issuesCollected: source.issues.length,
      issuesReportedByMultica: source.issueTotal,
      runsCollected: runs.length,
      runsWithMessages: source.messagesByRun.size,
      collectorMode: '只读定时拉取',
      scope: source.scope ?? null
    }
  };
}
