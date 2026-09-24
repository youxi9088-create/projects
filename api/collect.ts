import { config } from '../src/config.js';
import { multicaJson } from '../src/multica.js';
import { buildHealthSnapshot, productionLinePerformance, refineBlockedIncidentEvidence } from '../src/health.js';
import { buildDailyHealthSummary } from '../src/daily-summary.js';
import { findReworkIssues, reworkCandidateRuns, selectRecentTerminalProductionIssues } from '../src/rework.js';
import { acquireCloudCollectionLease, completeCloudSync, getCloudSyncState, initialiseCloudSync, loadCloudMessageCandidates, loadCloudSyncIssueCandidates, loadCloudSyncSource, loadHistoricalLineEvidence, loadSchemeUsage, prepareCloudMessageQueue, pruneCloudHistory, releaseCloudCollectionLease, saveCloudCollection, saveCloudSyncMessages, saveCloudSyncRuns, saveSchemeUsage, saveCollectionFailure } from './_store';
import { aggregateSchemeUsage, mergeSchemeUsage } from '../src/schemes.js';
import { waitUntil } from '@fn/functions';
import { randomUUID } from 'node:crypto';

// Keep the per-request Run fan-out small enough for the CLI bridge on issues
// with unusually large historical Run lists. A stalled child request must not
// consume the whole 30s HTTP budget for a slice.
const RUN_BATCH_SIZE = 1;
// A few run-message endpoints can be slow or unusually large. Four parallel
// reads keep each resumable request below FN's 30s response budget; the queue
// remains resumable so reducing the batch only affects total wall time.
const MESSAGE_BATCH_SIZE = 4;
let backgroundFinalization: Promise<any> | null = null;

async function listAllIssues() {
  const issues: any[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const page = await multicaJson(['issue', 'list', '--limit', '100', '--offset', String(offset), '--sort', 'created_at', '--direction', 'desc']);
    const rows = page.issues ?? [];
    issues.push(...rows);
    if (!page.has_more || !rows.length) return issues;
  }
  throw new Error('Issue 分页超过安全上限。');
}

async function collectCoreSource() {
  const [workspace, allAgents, skills, squads, issuePage] = await Promise.all([
    multicaJson(['workspace', 'get']), multicaJson(['agent', 'list']), multicaJson(['skill', 'list']), multicaJson(['squad', 'list']),
    listAllIssues()
  ]);
  const squadList = Array.isArray(squads) ? squads : [];
  const targetSquad = squadList.find((item: any) => item.id === config.targetSquadId);
  if (!targetSquad) throw new Error(`未找到目标小队 ID=${config.targetSquadId}；拒绝扩大采集范围。`);
  const membersResponse = await multicaJson(['squad', 'member', 'list', targetSquad.id]);
  const members = Array.isArray(membersResponse) ? membersResponse : membersResponse.members ?? membersResponse.items ?? [];
  const agentIds = new Set([
    ...members.filter((item: any) => !item.member_type || item.member_type === 'agent').map((item: any) => item.agent_id ?? item.member_id ?? item.id).filter(Boolean),
    ...(config.historicalSquadAgentIds ?? [])
  ]);
  const issues = issuePage.filter((issue: any) => issue.assignee_type === 'squad' && issue.assignee_id === targetSquad.id);
  return { workspace, agents: (Array.isArray(allAgents) ? allAgents : []).filter((agent: any) => agentIds.has(agent.id)), skills: Array.isArray(skills) ? skills : [], squads: [targetSquad], issues, issueTotal: issues.length,
    scope: { kind: 'squad_direct_assignment', squadId: targetSquad.id, squadName: targetSquad.name, agentIds: [...agentIds], memberCount: agentIds.size, currentMemberCount: members.length, historicalRosterIncluded: true, issueAssignmentRule: `assignee_type=squad && assignee_id=${targetSquad.id}` },
    // Skill coverage is not a recent-title sample: every explicit Skill tool
    // call by a squad member on every directly assigned Issue is in scope.
    performanceScope: { kind: 'squad_direct_assignment_explicit_skill_calls', squadId: targetSquad.id, squadName: targetSquad.name, issueIds: issues.map((issue: any) => issue.id), issueCount: issues.length, timeRange: 'all_retained_history' } };
}

function sourceRunsWithContext(source: any) {
  const issuesById = new Map(source.issues.map((issue: any) => [issue.id, issue]));
  const agentsById = new Map(source.agents.map((agent: any) => [agent.id, agent]));
  return [...source.runsByIssue.entries()].flatMap(([issueId, value]: any) => {
    const issue = issuesById.get(issueId) ?? {};
    return (Array.isArray(value) ? value : value.items ?? []).map((run: any) => ({ ...run, issue_id: run.issue_id ?? issueId, issueIdentifier: issue.identifier ?? issueId, issueTitle: issue.title ?? '', issueDescription: issue.description ?? '', agentName: agentsById.get(run.agent_id)?.name ?? run.agent_id, runMessages: source.messagesByRun.get(run.id) ?? null }));
  });
}

function sourceRestrictedToSquadMembers(source: any) {
  const agentIds = new Set(source.scope?.agentIds ?? source.agents.map((agent: any) => agent.id));
  const runsByIssue = new Map();
  const permittedRunIds = new Set<string>();
  for (const [issueId, value] of source.runsByIssue.entries()) {
    const runs = (Array.isArray(value) ? value : value.items ?? value.runs ?? []).filter((run: any) => agentIds.has(run.agent_id));
    for (const run of runs) permittedRunIds.add(run.id);
    runsByIssue.set(issueId, runs);
  }
  const messagesByRun = new Map([...source.messagesByRun.entries()].filter(([runId]) => permittedRunIds.has(runId)));
  return { ...source, runsByIssue, messagesByRun };
}

function mergeLineHistory(source: any, historical: any) {
  const runsByIssue = new Map<string, any[]>();
  const addRuns = (candidate: any, overwrite: boolean) => {
    for (const [issueId, value] of candidate.runsByIssue.entries()) {
      const existing = new Map((runsByIssue.get(issueId) ?? []).map((run: any) => [run.id, run]));
      for (const run of Array.isArray(value) ? value : value.items ?? []) {
        if (overwrite || !existing.has(run.id)) existing.set(run.id, run);
      }
      runsByIssue.set(issueId, [...existing.values()]);
    }
  };
  // History is the fallback; a current retained Run always wins on the same ID.
  addRuns(historical, false);
  addRuns(source, true);
  return {
    ...source,
    runsByIssue,
    messagesByRun: new Map([...historical.messagesByRun.entries(), ...source.messagesByRun.entries()])
  };
}

function allRuns(source: any) {
  return [...source.runsByIssue.entries()].flatMap(([issueId, value]: any) => (Array.isArray(value) ? value : value.items ?? []).map((run: any) => ({ ...run, issue_id: run.issue_id ?? issueId })));
}

function runObservedAtMs(run: any) {
  const value = Date.parse(run.last_heartbeat_at ?? run.completed_at ?? run.started_at ?? run.created_at ?? '');
  return Number.isFinite(value) ? value : 0;
}

async function collectWorkspaceTerminalRework(checkedAt: string) {
  const [allIssues, allAgentsResponse] = await Promise.all([
    listAllIssues(),
    multicaJson(['agent', 'list'])
  ]);
  const lookbackDays = 7;
  const terminalIssues = selectRecentTerminalProductionIssues(allIssues, { now: checkedAt, lookbackDays });
  const runResults = await Promise.all(terminalIssues.map(async (issue: any) => {
    try { return [issue.id, await multicaJson(['issue', 'runs', issue.identifier ?? issue.id])] as const; }
    catch (error: any) { return [issue.id, { error: error.message, items: [] }] as const; }
  }));
  const runsByIssue = new Map(runResults.map(([issueId, value]) => [issueId, Array.isArray(value) ? value : value.items ?? []]));
  const allAgents = Array.isArray(allAgentsResponse) ? allAgentsResponse : allAgentsResponse.items ?? allAgentsResponse.agents ?? [];
  const source = { issues: terminalIssues, agents: allAgents, runsByIssue, messagesByRun: new Map() };
  const contextualRuns = sourceRunsWithContext(source);
  const candidates = reworkCandidateRuns(contextualRuns);
  const items = findReworkIssues(contextualRuns, { threshold: 3 });
  const failedRunReads = runResults.filter(([, value]: any) => value?.error).length;
  return {
    items,
    lookbackDays,
    windowStart: new Date(Date.parse(checkedAt) - lookbackDays * 86400000).toISOString(),
    terminalIssues,
    runsRead: contextualRuns.length,
    eligibleProductionNodeRuns: candidates.length,
    failedRunReads
  };
}

function commentRows(value: any) {
  return Array.isArray(value) ? value : value?.items ?? value?.comments ?? [];
}

function isControlPlaneRunForLineTiming(run: any) {
  const result = run.result?.output ?? run.result?.user_visible_output ?? '';
  const evidence = [run.trigger_summary, run.heartbeat_summary, run.error, result].filter(Boolean).join('\n');
  if (/(?:日志复盘|完成后复盘|post[-\s]?completion\s+(?:log\s+)?review|retrospective\s+(?:review|governance))/i.test(evidence)) return true;
  const controlPlaneAction = /(?:项目经理|协调(?:员)?|coordinator).{0,48}(?:路由|派单|收口|状态核查)|(?:路由|派单|收口|no[_\s-]?action|状态核查)/i.test(evidence);
  const productionAction = /(?:\bStage\s*\d+|阶段\s*\d+|颗粒生产|生产节点|构建|生成|渲染|重产|重做|返工|修复|rebuild|render)/i.test(evidence);
  return controlPlaneAction && !productionAction;
}

async function issueLifecycleFallbacks(source: any, lineSource: any) {
  const memberIds = new Set(source.scope?.agentIds ?? []);
  const candidates = source.issues.filter((issue: any) => {
    if (!['done', 'cancelled'].includes(issue.status)) return false;
    const issueRuns = (lineSource.runsByIssue.get(issue.id) ?? []) as any[];
    const hasRetainedRun = issueRuns.length > 0;
    const productionRuns = issueRuns.filter((run: any) => !isControlPlaneRunForLineTiming(run));
    const hasCompletedRun = productionRuns.some((run: any) => String(run.status ?? '').toLowerCase() === 'completed');
    const hasStart = productionRuns.some((run: any) => Number.isFinite(Date.parse(run.started_at ?? run.created_at ?? '')));
    const hasCompletion = productionRuns.some((run: any) => String(run.status ?? '').toLowerCase() === 'completed' && Number.isFinite(Date.parse(run.completed_at ?? run.last_heartbeat_at ?? '')));
    // A retained completed Run without a usable start/end pair is sufficient
    // for one-pass and block KPIs, but not for delivery duration. Fetch only
    // these narrow lifecycle gaps instead of rereading every terminal Issue.
    return !hasRetainedRun || !hasCompletedRun || !hasStart || !hasCompletion;
  });
  const recoveredRuns: any[] = [];
  const evidence: any[] = [];
  // Lifecycle fallback is only for terminal Issues whose retained Run trace
  // is incomplete. Bound the remote reads so a large historical gap cannot
  // hold finalize past the FN request budget (the previous serial loop could
  // leave the cloud sync permanently in `running`).
  for (let offset = 0; offset < candidates.length; offset += 24) {
    await Promise.all(candidates.slice(offset, offset + 24).map(async (issue: any) => {
    try {
      const retainedRuns = (lineSource.runsByIssue.get(issue.id) ?? []) as any[];
      const hasRetainedRun = retainedRuns.length > 0;
      const [detail, usage] = await Promise.all([
        multicaJson(['issue', 'get', issue.identifier ?? issue.id]),
        multicaJson(['issue', 'usage', issue.identifier ?? issue.id])
      ]);
      const taskAgents = (usage.agent_breakdown ?? []).map((item: any) => item.agent_id).filter(Boolean);
      const targetTaskAgents = taskAgents.filter((agentId: string) => memberIds.has(agentId));
      const externalTaskAgents = [...new Set(taskAgents.filter((agentId: string) => !memberIds.has(agentId)))];
      const startedAt = detail.first_executed_at;
      // Comments are needed only after usage proves that this Issue has a
      // current target-squad executor. Avoid fetching hundreds of comment
      // histories for Issues whose historical tasks all belong to former or
      // external agents; those rows cannot be used for this scope anyway.
      const comments = targetTaskAgents.length
        ? await multicaJson(['issue', 'comment', 'list', issue.identifier ?? issue.id, '--full'])
        : { items: [] };
      const rows = commentRows(comments);
      // Issue.updated_at can arrive a few seconds before first_executed_at
      // during Multica's asynchronous status write. Use the latest auditable
      // Issue/comment event as the lifecycle end, then clamp a remaining clock
      // inversion to the start instead of creating a negative duration.
      const startedMs = Date.parse(startedAt ?? '');
      const observedEndMs = Math.max(...[issue.updated_at, detail.updated_at, ...rows.map((row: any) => row.created_at)]
        .map((value) => Date.parse(value ?? '')).filter(Number.isFinite));
      const completedAt = Number.isFinite(observedEndMs)
        ? new Date(Number.isFinite(startedMs) && observedEndMs < startedMs ? startedMs : observedEndMs).toISOString()
        : null;
      // The production population is defined by direct assignment to the
      // target squad. A subsequent governance/review Run from another Agent
      // must not erase a line that otherwise has target-squad execution
      // evidence. Keep only target-member task agents for this fallback.
      if (!startedAt || !completedAt || !targetTaskAgents.length) {
        evidence.push({ issueId: issue.id, identifier: issue.identifier, status: hasRetainedRun ? 'timing_unavailable' : 'not_eligible', reason: '缺少可审计的起止时间，或没有目标小队成员的任务执行记录。', externalTaskAgents });
        return;
      }
      const timestamps = [startedAt, completedAt, ...rows.map((row: any) => row.created_at).filter(Boolean)]
        .map((value) => Date.parse(value)).filter(Number.isFinite).sort((left, right) => left - right);
      const maxGapMs = timestamps.reduce((maximum, value, index) => index ? Math.max(maximum, value - timestamps[index - 1]) : 0, 0);
      const commentText = rows.map((row: any) => row.content ?? '').join('\n');
      const explicitBlock = /(?:状态\s*[:：]?\s*阻塞|issue\s+status.{0,30}\bblocked\b|\bBLOCK_STAGE\d+\b|等待人工(?:决策|确认|复验))/i.test(commentText);
      // Raw Runs can expire from Multica before a dashboard refresh. Preserve
      // a narrow, auditable recovery signal from the Issue timeline: a server
      // cancellation followed by an explicit continue/resume proves that the
      // first production attempt did not run through. Do not infer this from
      // generic retrospective prose or a short lifecycle gap alone.
      const serverCancelledThenResumed = /(?:task\s+cancelled\s+by\s+server|任务(?:被)?服务器取消|服务(?:端)?取消(?:任务)?).{0,1200}(?:两次?.{0,24}(?:继续|恢复)|(?:继续|恢复).{0,24}(?:执行|生产|任务)|\b(?:resume|resumed|retry|restarted)\b)|(?:两次?.{0,24}(?:继续|恢复)|(?:继续|恢复).{0,24}(?:执行|生产|任务)|\b(?:resume|resumed|retry|restarted)\b).{0,1200}(?:task\s+cancelled\s+by\s+server|任务(?:被)?服务器取消|服务(?:端)?取消(?:任务)?)/is.test(commentText);
      if (!hasRetainedRun) {
        recoveredRuns.push({
          id: `issue-lifecycle:${issue.id}`,
          issue_id: issue.id,
          agent_id: targetTaskAgents[0],
          status: 'completed',
          started_at: startedAt,
          completed_at: completedAt,
          heartbeat_summary: `Issue 生命周期补充证据：${Number(usage.task_count ?? 0)} 个任务、${rows.length} 条评论，最大事件间隔 ${Math.round(maxGapMs / 60_000)} 分钟。`,
          result: { output: '原始 Run 已结束且 Multica 不再返回；本条仅由 Issue 生命周期证据补齐。' }
        });
      } else {
        recoveredRuns.push({
          id: `issue-lifecycle-timing:${issue.id}`,
          issue_id: issue.id,
          agent_id: targetTaskAgents[0],
          status: 'completed',
          started_at: startedAt,
          completed_at: completedAt,
          heartbeat_summary: 'Issue 生命周期补齐：保留的 completed Run 缺少可用起止时间，时长按 first_executed_at 至 Issue.updated_at 计算。',
          result: { output: '仅补齐成功生产时长；原始 Run 状态和阻断判定保持不变。' }
        });
      }
      // A lifecycle gap longer than the same four-hour threshold is treated
      // conservatively as one interruption. Explicit lifecycle block records
      // also add one occurrence, without reclassifying generic comments.
      if (maxGapMs > (config.lineNodeStallMs ?? 4 * 60 * 60 * 1000) || explicitBlock || serverCancelledThenResumed) {
        recoveredRuns.push({
          id: `issue-lifecycle-block:${issue.id}`,
          issue_id: issue.id,
          agent_id: targetTaskAgents[0],
          status: serverCancelledThenResumed ? 'failed' : 'blocked',
          created_at: startedAt,
          completed_at: completedAt,
          heartbeat_summary: serverCancelledThenResumed
            ? 'Issue 生命周期记录了服务取消后的继续/恢复执行；原始失败 Run 已被清理，按一次生产中断补齐。'
            : maxGapMs > (config.lineNodeStallMs ?? 4 * 60 * 60 * 1000)
            ? `Issue 生命周期事件间隔超过 ${Math.round((config.lineNodeStallMs ?? 4 * 60 * 60 * 1000) / 60 / 60_000)} 小时。`
            : 'Issue 生命周期评论中存在明确阻塞或门禁信号。'
        });
      }
      evidence.push({ issueId: issue.id, identifier: issue.identifier, status: hasRetainedRun ? 'timing_recovered' : 'recovered', taskCount: Number(usage.task_count ?? 0), commentCount: rows.length, maxGapMinutes: Math.round(maxGapMs / 60_000), explicitBlock, serverCancelledThenResumed, taskAgents: targetTaskAgents, externalTaskAgents });
    } catch (error: any) {
      evidence.push({ issueId: issue.id, identifier: issue.identifier, status: 'unavailable', reason: error.message });
    }
    }));
  }
  return { runs: recoveredRuns, evidence };
}

async function nextSlice() {
  let state = await getCloudSyncState();
  // A completed state is a stable result. Ordinary polling must not turn the
  // final successful slice into a brand-new collection; only ?force=1 starts
  // a fresh sweep.
  if (state?.status === 'completed' && state.phase === 'completed') return state;
  // A full scoped sweep can legitimately run longer than eleven minutes.
  // Expiry must be based on the last persisted cursor update, not the time
  // the sweep started; otherwise a healthy long run is reset to issue 1.
  const stateUpdatedAt = Date.parse(state?.updatedAt ?? state?.startedAt ?? '');
  const stateStale = state?.status === 'running'
    && Number.isFinite(stateUpdatedAt)
    && Date.now() - stateUpdatedAt > 11 * 60 * 1000;
  // A client disconnect can leave the resumable state in `running` even
  // though FN has already aborted the 30-second request. Do not keep retrying
  // a stale finalize forever; start a fresh full sweep while retaining all
  // historical evidence collections.
  if (!state || state.status !== 'running' || stateStale) state = await initialiseCloudSync(await collectCoreSource());
  let stage = state.phase;
  let finalizeStep = '';
  try {
  if (state.phase === 'runs') {
    const selected = await loadCloudSyncIssueCandidates(state, RUN_BATCH_SIZE);
    state = await saveCloudSyncRuns(state, await Promise.all(selected.map(async (issue: any) => {
      try { return { issueId: issue.id, value: await multicaJson(['issue', 'runs', issue.identifier ?? issue.id]) }; }
      catch (error: any) { return { issueId: issue.id, value: { error: error.message, items: [] } }; }
    })));
  }
  if (state.phase === 'prepare_messages') state = await prepareCloudMessageQueue(state, config.cloudMessageCandidateLimit, config.runMessageLimit);
  stage = state.phase;
  if (state.phase === 'messages') {
    const selected = await loadCloudMessageCandidates(state, MESSAGE_BATCH_SIZE);
    state = await saveCloudSyncMessages(state, await Promise.all(selected.map(async (candidate: any) => {
      try { return { ...candidate, value: await multicaJson(['issue', 'run-messages', candidate.runId, '--issue', candidate.issueId]) }; }
      catch (error: any) { return { ...candidate, value: { error: error.message, items: [] } }; }
    })));
    // Do not fall through into the expensive finalization in the same 30s
    // request that writes the last message batch. The next poll observes the
    // finalize phase and hands it to waitUntil under the collection lease.
    if (state.phase === 'finalize') return state;
  }
  if (state.phase === 'finalize') {
    finalizeStep = 'load_sync_source';
    // The collection already contains only Issues directly assigned to the
    // target squad. Restrict every downstream metric to Runs owned by its
    // member Agents, so cross-squad hand-offs never leak into this dashboard.
    const source = sourceRestrictedToSquadMembers(await loadCloudSyncSource(state));
    const checkedAt = new Date().toISOString();
    const runCount = [...source.runsByIssue.values()].reduce((count: number, value: any) => count + (Array.isArray(value) ? value.length : value.items?.length ?? value.runs?.length ?? 0), 0);
    const serviceChecks = [{ serviceName: 'Multica 云端 CLI / 工作区读取', status: 'healthy', latencyMs: 0, detail: `已只读获取工作区 ${source.workspace.name}、${source.issues.length} 条 Issue、${runCount} 条 Run 与 ${source.messagesByRun.size} 条 Run 消息。`, checkedAt }];
    const snapshot: any = buildHealthSnapshot(source, { ...config, serviceChecks, skillEvaluations: [], now: checkedAt });
    // Current state and risks remain based on the realtime source.  Terminal
    // production KPIs, repeated-rework evidence, the complete explicit Skill
    // catalogue and Agent execution samples also need retained Run history:
    // Multica stops returning old finished Runs from its live endpoint.
    finalizeStep = 'prune_cloud_history';
    const historyPrune = await pruneCloudHistory(checkedAt, 7);
    finalizeStep = 'load_historical_line_evidence';
    let historical: any;
    try {
      historical = await loadHistoricalLineEvidence({ issueIds: source.issues.map((issue: any) => issue.id), agentIds: source.scope?.agentIds ?? [] });
    } catch (error: any) {
      // Historical rows are an enhancement for terminal KPI backfill. If the
      // bridge rejects a fat legacy document, do not discard the fresh
      // realtime collection; continue with an explicit degraded marker.
      historical = { runsByIssue: new Map(), messagesByRun: new Map(), runCount: 0, messageCount: 0, error: error?.message ?? String(error) };
    }
    const lineSource = mergeLineHistory(source, historical);
    finalizeStep = 'build_execution_snapshot';
    const executionEvidenceSnapshot: any = buildHealthSnapshot(lineSource, {
      ...config,
      serviceChecks,
      skillEvaluations: [],
      now: checkedAt,
      // Agent execution health uses its own recent window. Current incidents
      // still retain their shorter realtime threshold inside buildHealthSnapshot.
      agentAnalysisLookbackMs: config.productionPerformanceDays * 86400000
    });
    snapshot.agents = executionEvidenceSnapshot.agents;
    snapshot.skills = executionEvidenceSnapshot.skills;
    // Blocked-Issue analysis must not be left on the realtime-only fallback.
    // Historical Run/message evidence is merged into `lineSource` for KPI and
    // Skill assembly; re-run only the blocked incidents' evidence chain against
    // that merged source, replacing run / agent / evidence / analysis in place.
    const refinedBlocked = refineBlockedIncidentEvidence(snapshot, lineSource, new Map(source.agents.map((agent: any) => [agent.id, agent])), Date.parse(checkedAt));
    if (refinedBlocked.length) snapshot.blockedEvidenceRefinement = {
      refined: refinedBlocked.length,
      withRun: refinedBlocked.filter((item: any) => item.hasRun).length,
      confidence: Object.fromEntries(['high', 'medium', 'low'].map((level) => [level, refinedBlocked.filter((item: any) => item.confidence === level).length])),
      issues: refinedBlocked,
      detail: `已对 ${refinedBlocked.length} 个 blocked Issue 合并云端历史 Run/消息证据重新判定卡点。`
    };
    // Rework is deliberately a separate workspace-wide terminal-production
    // analysis. Do not reuse the target-squad current-snapshot scope: a
    // recently finished granular-production Issue can be assigned elsewhere.
    finalizeStep = 'collect_workspace_rework';
    const workspaceRework = await collectWorkspaceTerminalRework(checkedAt);
    finalizeStep = 'issue_lifecycle_fallbacks';
    const lifecycle = await issueLifecycleFallbacks(source, lineSource);
    for (const run of lifecycle.runs) {
      const values = lineSource.runsByIssue.get(run.issue_id) ?? [];
      values.push(run);
      lineSource.runsByIssue.set(run.issue_id, values);
    }
    const linePerformance: any = productionLinePerformance(source.issues, allRuns(lineSource), lineSource.messagesByRun, {
      nowMs: Date.parse(checkedAt), nodeStallMs: config.lineNodeStallMs ?? 4 * 60 * 60 * 1000
    });
    linePerformance.historyEvidence = {
      source: 'cloud_historical_line_evidence_v1',
      historicalRuns: historical.runCount,
      historicalMessages: historical.messageCount,
      realtimeRuns: runCount,
      mergedRuns: allRuns(lineSource).length,
      lifecycleFallbackIssueCount: lifecycle.evidence.filter((item: any) => ['recovered', 'timing_recovered'].includes(item.status)).length,
      lifecycleFallbacks: lifecycle.evidence,
      detail: historical.skipped
        ? `${historical.error} 三项生产线 KPI 本轮使用实时保留 Run ${runCount} 条；历史证据仍保留在云端。`
        : historical.runCount
          ? `三项生产线 KPI 已合并云端历史 Run ${historical.runCount} 条、历史消息 ${historical.messageCount} 条；当前实时 Run ${runCount} 条优先。${lifecycle.evidence.some((item: any) => ['recovered', 'timing_recovered'].includes(item.status)) ? `另有 ${lifecycle.evidence.filter((item: any) => item.status === 'recovered').length} 条终态 Issue 的原始 Run 已被清理，${lifecycle.evidence.filter((item: any) => item.status === 'timing_recovered').length} 条保留 completed Run 缺少时间戳，均按可审计的 Issue 生命周期补齐并明确标注。` : ''}`
          : '尚未导入云端历史 Run 证据；三项生产线 KPI 目前只能使用实时保留 Run。'
    };
    snapshot.production.linePerformance = linePerformance;
    const skillScope = snapshot.skills.performanceScope ?? {};
    const scopedIssueIds = new Set(skillScope.issueIds ?? []);
    const withinSkillScope = (run: any) => {
      const at = Date.parse(run.last_heartbeat_at ?? run.completed_at ?? run.started_at ?? run.created_at ?? '');
      const skillWindowStart = Date.parse(skillScope.windowStart ?? '');
      return scopedIssueIds.has(run.issue_id) && (!Number.isFinite(skillWindowStart) || (Number.isFinite(at) && at >= skillWindowStart));
    };
    const scopedHistoricalRuns = allRuns(historical).filter(withinSkillScope);
    const scopedRealtimeRuns = allRuns(source).filter(withinSkillScope);
    const scopedHistoricalRunIds = new Set(scopedHistoricalRuns.map((run: any) => run.id));
    const scopedRealtimeRunIds = new Set(scopedRealtimeRuns.map((run: any) => run.id));
    const scopedHistoricalMessages = [...historical.messagesByRun.keys()].filter((runId) => scopedHistoricalRunIds.has(runId)).length;
    const scopedRealtimeMessages = [...source.messagesByRun.keys()].filter((runId) => scopedRealtimeRunIds.has(runId)).length;
    snapshot.skills.analysisEvidence = {
      runsAnalysed: scopedHistoricalRuns.length + scopedRealtimeRuns.length,
      runsWithMessages: scopedHistoricalMessages + scopedRealtimeMessages,
      historicalRuns: scopedHistoricalRuns.length,
      historicalMessages: scopedHistoricalMessages,
      realtimeRuns: scopedRealtimeRuns.length,
      realtimeMessages: scopedRealtimeMessages,
      scopedIssueCount: skillScope.issueCount ?? 0,
      // `called` 是有显式调用证据的 Skill；`total` 现为绑定 Skill 总数。
      relatedSkillCount: snapshot.skills.total,
      explicitSkillCount: snapshot.skills.called,
      status: snapshot.skills.called ? 'identified' : 'no_explicit_calls_observed',
      detail: snapshot.skills.called
        ? `本轮在该小队直接指派的 ${skillScope.issueCount ?? 0} 个 Issue 中，合并历史 Run ${scopedHistoricalRuns.length} 条、历史消息 ${scopedHistoricalMessages} 条和实时 Run ${scopedRealtimeRuns.length} 条、实时消息 ${scopedRealtimeMessages} 条，识别到 ${snapshot.skills.called} 个显式调用 Skill（小队绑定 Skill 共 ${snapshot.skills.total} 个）。`
        : `本轮在该小队直接指派的 ${skillScope.issueCount ?? 0} 个 Issue 中，合并历史 Run ${scopedHistoricalRuns.length} 条、历史消息 ${scopedHistoricalMessages} 条和实时 Run ${scopedRealtimeRuns.length} 条、实时消息 ${scopedRealtimeMessages} 条，未观察到显式 Skill 工具调用。`
    };
    snapshot.daily = buildDailyHealthSummary({ snapshot, issues: source.issues, skills: source.skills, agents: source.agents, reworkIssues: workspaceRework.items, includeFullReworkEvidence: true, now: checkedAt });
    const rework = snapshot.daily.reworkIssues;
    const coverage = `在工作区筛选 ${workspaceRework.windowStart} 起近 7×24 小时内更新为 done/cancelled、标题包含“颗粒生产”的 ${workspaceRework.terminalIssues.length} 个 Issue；读取 ${workspaceRework.runsRead} 条 Run，其中 ${workspaceRework.eligibleProductionNodeRuns} 条可识别为生产节点执行。`;
    rework.analysisEvidence = {
      scope: 'workspace_recent_terminal_granular_production',
      windowDays: workspaceRework.lookbackDays,
      windowStart: workspaceRework.windowStart,
      terminalIssueCount: workspaceRework.terminalIssues.length,
      runsAnalysed: workspaceRework.eligibleProductionNodeRuns,
      runsRead: workspaceRework.runsRead,
      eligibleProductionNodeRuns: workspaceRework.eligibleProductionNodeRuns,
      failedRunReads: workspaceRework.failedRunReads,
      status: rework.count ? 'identified' : 'no_qualifying_repeat',
      detail: rework.count
        ? `${coverage} 已识别 ${rework.count} 个满足阈值的 Issue。`
        : `${coverage} 未出现重复至少 ${rework.threshold} 次的节点。`
    };
    rework.note = `返工范围：工作区近 ${workspaceRework.lookbackDays} 天内更新为 done/cancelled 且标题包含“颗粒生产”的 Issue。同一 Issue 内，同一生产节点被重复激活或执行至少 ${rework.threshold} 次；优先按阶段+产出物、缺少产出物时按阶段识别。项目经理路由、协调派单、验收、等待与纯下游消费不纳入。${rework.analysisEvidence.detail}`;
    snapshot.generatedAt = checkedAt;
    snapshot.cloudSync = { complete: true, mode: 'resumable_scoped_read_only', issues: source.issues.length, runs: runCount, runsWithMessages: source.messagesByRun.size, messageEvidenceLimit: config.cloudMessageCandidateLimit, historyPrune, startedAt: state.startedAt, finishedAt: checkedAt };
    // 互动方案使用汇总：对已完成的颗粒生产 Issue（status=done）提取互动方案并
    // 与既有结论合并，供"互动方案"页面展示中英文名、使用次数与涉及 Issue。
    finalizeStep = 'scheme_usage';
    try {
      const doneIssues = source.issues.filter((issue: any) => issue.status === 'done');
      const incoming = aggregateSchemeUsage(doneIssues.map((issue: any) => ({
        identifier: issue.identifier ?? issue.id,
        title: issue.title ?? '',
        runs: lineSource.runsByIssue.get(issue.id) ?? [],
        messagesByRun: lineSource.messagesByRun
      })), checkedAt);
      const merged = mergeSchemeUsage(await loadSchemeUsage(), incoming);
      await saveSchemeUsage(merged);
      snapshot.cloudSync.schemeUsage = { issuesAnalysed: merged.issuesAnalysed, schemeCount: merged.schemeCount, generatedAt: merged.generatedAt };
    } catch (schemeError: any) {
      // 方案汇总失败不阻断健康快照落库，只记录到 cloudSync 供页面提示。
      snapshot.cloudSync.schemeUsage = { error: schemeError.message };
    }
    finalizeStep = 'save_cloud_collection';
    await saveCloudCollection({ snapshot, source, startedAt: state.startedAt, persistEvidence: false });
    state = await completeCloudSync(state, snapshot.cloudSync);
  }
  return state;
  } catch (error: any) {
    throw new Error(`${stage} 阶段失败${finalizeStep ? `（${finalizeStep}）` : ''}：${error.message}`);
  }
}

async function runSliceWithLease(force: boolean) {
  const leaseId = randomUUID();
  if (!(await acquireCloudCollectionLease(leaseId, force))) {
    const current = await getCloudSyncState();
    return { locked: true, state: current };
  }
  let deferRelease = false;
  try {
    const current = await getCloudSyncState();
    if (!force && current?.status === 'running' && current.phase === 'finalize') {
      if (!backgroundFinalization) {
        const background = nextSlice().catch(async (error: any) => {
          const latest = await getCloudSyncState();
          if (latest?.startedAt) await saveCollectionFailure({ startedAt: latest.startedAt, error: error?.message ?? String(error) });
        }).finally(async () => {
          backgroundFinalization = null;
          await releaseCloudCollectionLease(leaseId);
        });
        backgroundFinalization = background;
        waitUntil(background);
        deferRelease = true;
      }
      return { locked: false, background: true, state: current };
    }
    if (force) await initialiseCloudSync(await collectCoreSource());
    return { locked: false, state: await nextSlice() };
  } finally {
    if (!deferRelease) await releaseCloudCollectionLease(leaseId);
  }
}

export async function POST(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get('force') === '1';
    const result: any = await runSliceWithLease(force);
    const state = result.state;
    if (result.locked) return Response.json({ accepted: true, collection: 'running', progress: state?.progress ?? null }, { status: 202 });
    return Response.json({ accepted: true, collection: state?.status === 'completed' ? 'completed' : 'running', progress: state?.progress ?? null }, { status: result.background ? 202 : 200 });
  } catch (error: any) { return Response.json({ error: error.message ?? '云端采集失败。' }, { status: 500 }); }
}
