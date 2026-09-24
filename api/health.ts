import { mongodb } from '@fn/mongodb';
import { gunzipSync } from 'node:zlib';
import { multicaJson } from '../src/multica.js';
import { config } from '../src/config.js';
import { productionLinePerformance } from '../src/health.js';

// Do not import the full collector store on the hot read path. Its historical
// collections are only for batch collection/recovery, while a dashboard page
// needs one small, current projection.
const currentPages = mongodb.collection<any>('health_current_pages_v3');

let liveProductionCache: { at: number; value: any } | null = null;

async function listAllIssues() {
  const issues: any[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const page = await multicaJson(['issue', 'list', '--limit', '100', '--offset', String(offset), '--sort', 'created_at', '--direction', 'desc']);
    const rows = page.issues ?? [];
    issues.push(...rows);
    if (!page.has_more || !rows.length) return issues;
  }
  return issues;
}

async function mapWithConcurrency(items: any[], limit: number, mapper: (item: any) => Promise<any>) {
  const results: any[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) results.push(await mapper(items[next++]));
  });
  await Promise.all(workers);
  return results;
}

async function collectLiveProduction() {
  if (liveProductionCache && Date.now() - liveProductionCache.at < 120_000) return liveProductionCache.value;
  const [squads, issueRows] = await Promise.all([
    multicaJson(['squad', 'list']),
    listAllIssues()
  ]);
  const targetSquad = (Array.isArray(squads) ? squads : []).find((item: any) => item.id === config.targetSquadId);
  if (!targetSquad) throw new Error(`未找到目标小队 ID=${config.targetSquadId}`);
  const membersResponse = await multicaJson(['squad', 'member', 'list', targetSquad.id]);
  const members = Array.isArray(membersResponse) ? membersResponse : membersResponse.members ?? membersResponse.items ?? [];
  const agentIds = new Set([
    ...members.filter((item: any) => !item.member_type || item.member_type === 'agent').map((item: any) => item.agent_id ?? item.member_id ?? item.id).filter(Boolean),
    ...(config.historicalSquadAgentIds ?? [])
  ]);
  const issues = issueRows.filter((issue: any) => issue.assignee_type === 'squad' && issue.assignee_id === targetSquad.id);
  const terminalIssues = issues.filter((issue: any) => issue.status === 'done' || issue.status === 'cancelled');
  const runResults = await mapWithConcurrency(terminalIssues, 6, async (issue: any) => {
    try {
      const value = await multicaJson(['issue', 'runs', issue.identifier ?? issue.id]);
      const rows = Array.isArray(value) ? value : value.items ?? value.runs ?? [];
      return rows.map((run: any) => ({ ...run, issue_id: run.issue_id ?? issue.id })).filter((run: any) => agentIds.has(run.agent_id));
    } catch {
      return [];
    }
  });
  const runs = runResults.flat();
  const linePerformance = productionLinePerformance(issues, runs, new Map(), {
    nowMs: Date.now(), nodeStallMs: config.lineNodeStallMs ?? 4 * 60 * 60 * 1000
  });
  const issueStatusCounts = Object.fromEntries(issues.reduce((groups: Map<string, number>, issue: any) => {
    groups.set(issue.status, (groups.get(issue.status) ?? 0) + 1);
    return groups;
  }, new Map()));
  const value = {
    generatedAt: new Date().toISOString(),
    scope: {
      kind: 'squad_direct_assignment', squadId: targetSquad.id, squadName: targetSquad.name,
      agentIds: [...agentIds], memberCount: agentIds.size, currentMemberCount: members.length,
      historicalRosterIncluded: true, issueAssignmentRule: `assignee_type=squad && assignee_id=${targetSquad.id}`
    },
    issues, runs, issueStatusCounts, linePerformance
  };
  liveProductionCache = { at: Date.now(), value };
  return value;
}

export async function GET(request: Request) {
  try {
    const page = new URL(request.url).searchParams.get('page') ?? 'overview';
    const current = await currentPages.findOne({ id: page });
    const snapshot = current?.snapshot
      ?? (current?.snapshotGzipBase64
        ? JSON.parse(gunzipSync(Buffer.from(current.snapshotGzipBase64, 'base64')).toString('utf8'))
        : null);
    if (!snapshot) return Response.json({ error: '云端尚无成功采集快照。' }, { status: 404 });
    let visibleSnapshot = snapshot;
    // The resumable collector can be delayed by a large historical evidence
    // set. For the production cards, use a bounded realtime terminal-line
    // read while the persisted projection is stale. This keeps the user-facing
    // run-through KPI truthful instead of showing an old partial snapshot.
    if ((page === 'overview' || page === 'production') && Date.now() - Date.parse(snapshot.generatedAt ?? '') > 6 * 60 * 60 * 1000) {
      const live = await collectLiveProduction();
      const scope = live.scope;
      visibleSnapshot = {
        ...snapshot,
        generatedAt: live.generatedAt,
        workspace: { ...snapshot.workspace, issueTotal: live.issues.length, scope },
        coverage: { ...snapshot.coverage, issuesCollected: live.issues.length, issuesReportedByMultica: live.issues.length, runsCollected: live.runs.length, runsWithMessages: 0, scope, collectorMode: '实时生产线校验（快照补采中）' },
        production: { ...snapshot.production, productionIssueCount: live.issues.length, issueStatusCounts: live.issueStatusCounts, activeIssues: live.issues.filter((issue: any) => !['done', 'cancelled'].includes(issue.status)).length, blockedIssues: live.issueStatusCounts.blocked ?? 0, linePerformance: live.linePerformance }
      };
    }
    return Response.json({ snapshot: visibleSnapshot, localTime: new Date().toISOString(), refreshIntervalMs: 60_000 }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error: any) {
    // Keep a failed projection observable: otherwise the FN runner only emits
    // a generic runtime_unavailable error and masks the actionable store fault.
    return Response.json({ error: '读取云端快照失败。', detail: error?.message ?? String(error) }, { status: 503 });
  }
}
