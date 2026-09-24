import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      results.push(await mapper(item));
    }
  });
  await Promise.all(workers);
  return results;
}

export function multicaCommand() {
  const configured = process.env.MULTICA_CLI_PATH;
  if (configured && fsSync.existsSync(configured)) return configured;
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'multica');
  if (process.platform !== 'win32' && fsSync.existsSync(bundled)) {
    try { fsSync.chmodSync(bundled, 0o755); } catch {}
    return bundled;
  }
  return configured || 'multica';
}

export async function multicaJson(args) {
  try {
    const { stdout, stderr } = await execFileAsync(multicaCommand(), [...args, '--output', 'json'], {
      windowsHide: true,
      maxBuffer: 24 * 1024 * 1024,
      // A single remote CLI request must not hold an FN background worker
      // forever. Callers retain partial-evidence semantics on a timeout.
      timeout: Number.parseInt(process.env.MULTICA_COMMAND_TIMEOUT_MS ?? '15000', 10)
    });
    if (stderr?.trim()) {
      // Multica sometimes writes harmless warnings to stderr; valid JSON remains authoritative.
    }
    return JSON.parse(stdout);
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message;
    throw new Error(`multica ${args.join(' ')} failed: ${detail}`);
  }
}

export async function getSkillDetail(skillId) {
  return multicaJson(['skill', 'get', skillId]);
}

export async function createIssue({ title, description, assigneeId, priority = 'medium' }) {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.rpg2-darwin-review-'));
  const descriptionPath = path.join(directory, 'issue-description.md');
  try {
    await fs.writeFile(descriptionPath, description, 'utf8');
    return await multicaJson([
      'issue', 'create', '--title', title, '--description-file', descriptionPath,
      '--assignee-id', assigneeId, '--priority', priority, '--status', 'todo'
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function getIssue(issueId) {
  return multicaJson(['issue', 'get', issueId]);
}

export async function listIssueComments(issueId) {
  return multicaJson(['issue', 'comment', 'list', issueId, '--full']);
}

export async function downloadAttachmentText(attachmentId) {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.rpg2-review-attachment-'));
  try {
    await execFileAsync(multicaCommand(), ['attachment', 'download', attachmentId, '--output-dir', directory], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    const files = await fs.readdir(directory, { withFileTypes: true });
    const file = files.find((entry) => entry.isFile());
    if (!file) throw new Error(`Attachment ${attachmentId} was downloaded without a file.`);
    return await fs.readFile(path.join(directory, file.name), 'utf8');
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message;
    throw new Error(`multica attachment download ${attachmentId} failed: ${detail}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function listAllIssues() {
  const issues = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const page = await multicaJson(['issue', 'list', '--limit', '100', '--offset', String(offset), '--sort', 'created_at', '--direction', 'desc']);
    const items = page.issues ?? [];
    issues.push(...items);
    total = page.total ?? issues.length;
    if (!page.has_more || !items.length) return { issues, total };
    offset += items.length;
  }
}

export async function collectWorkspaceSource({
  runMessageLimit,
  runFetchConcurrency = 6,
  messageFetchConcurrency = 6,
  messageCandidateLimit = Number.POSITIVE_INFINITY,
  productionPerformanceDays = 7,
  granularProductionTitleMarker = '【颗粒生产】',
  targetSquadId = '00c28d20-adae-4905-aede-d492c89a474d'
}) {
  const [workspace, agents, skills, squads, issuePage] = await Promise.all([
    multicaJson(['workspace', 'get']),
    multicaJson(['agent', 'list']),
    multicaJson(['skill', 'list']),
    multicaJson(['squad', 'list']),
    listAllIssues()
  ]);

  const allIssues = issuePage.issues ?? issuePage ?? [];
  const targetSquad = (Array.isArray(squads) ? squads : []).find((squad) => squad.id === targetSquadId);
  if (!targetSquad) {
    throw new Error(`未找到目标小队 ID=${targetSquadId}；为避免混入全工作区数据，已拒绝采集。`);
  }
  const squadMembers = await multicaJson(['squad', 'member', 'list', targetSquad.id]);
  const memberRecords = Array.isArray(squadMembers) ? squadMembers : squadMembers.members ?? squadMembers.items ?? [];
  const squadAgentIds = new Set([
    ...memberRecords
      .filter((member) => !member.member_type || member.member_type === 'agent')
      .map((member) => member.agent_id ?? member.member_id ?? member.id)
      .filter(Boolean),
    ...(process.env.HISTORICAL_SQUAD_AGENT_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  ]);
  const scopedAgents = (Array.isArray(agents) ? agents : []).filter((agent) => squadAgentIds.has(agent.id));
  const issues = allIssues.filter((issue) => issue.assignee_type === 'squad' && issue.assignee_id === targetSquad.id);
  const orderedIssues = [...issues]
    .sort((left, right) => {
      const leftActive = ['in_progress', 'in_review', 'blocked', 'todo'].includes(left.status) ? 1 : 0;
      const rightActive = ['in_progress', 'in_review', 'blocked', 'todo'].includes(right.status) ? 1 : 0;
      return rightActive - leftActive || String(right.updated_at).localeCompare(String(left.updated_at));
    });
  // Every directly-assigned Issue is collected.  Production throughput
  // metrics require the complete completed-line denominator, not just the
  // active risk queue.
  const blockedIssues = orderedIssues.filter((issue) => issue.status === 'blocked');
  const windowStart = new Date(Date.now() - productionPerformanceDays * 24 * 60 * 60 * 1000).toISOString();
  const granularProductionIssues = issues.filter((issue) => {
    const issueTime = issue.updated_at ?? issue.created_at;
    return String(issue.title ?? '').includes(granularProductionTitleMarker)
      && Date.parse(issueTime ?? '') >= Date.parse(windowStart);
  });
  const selectedIssues = issues;

  const runsByIssue = new Map();
  await mapWithConcurrency(selectedIssues, runFetchConcurrency, async (issue) => {
    try {
      runsByIssue.set(issue.id, await multicaJson(['issue', 'runs', issue.identifier ?? issue.id]));
    } catch (error) {
      runsByIssue.set(issue.id, { error: error.message, items: [] });
    }
  });

  const allRunCandidates = [...runsByIssue.entries()]
    .flatMap(([issueId, value]) => (Array.isArray(value) ? value : value.items ?? []).map((run) => ({ issueId, run })))
    .sort((left, right) => String(right.run.last_heartbeat_at ?? right.run.created_at).localeCompare(String(left.run.last_heartbeat_at ?? left.run.created_at)));
  const latestBlockedRuns = blockedIssues.map((issue) => allRunCandidates
    .filter((candidate) => candidate.issueId === issue.id)
    .sort((left, right) => String(right.run.last_heartbeat_at ?? right.run.created_at).localeCompare(String(left.run.last_heartbeat_at ?? left.run.created_at)))[0])
    .filter(Boolean);
  const granularProductionIssueIds = new Set(granularProductionIssues.map((issue) => issue.id));
  const granularProductionRuns = allRunCandidates.filter((candidate) => granularProductionIssueIds.has(candidate.issueId));
  const messageCandidates = new Map();
  const boundedProductionRuns = granularProductionRuns
    .sort((left, right) => String(right.run.last_heartbeat_at ?? right.run.created_at).localeCompare(String(left.run.last_heartbeat_at ?? left.run.created_at)))
    .slice(0, messageCandidateLimit);
  for (const candidate of [...latestBlockedRuns, ...boundedProductionRuns, ...allRunCandidates.slice(0, runMessageLimit)]) {
    messageCandidates.set(candidate.run.id, candidate);
  }
  const runCandidates = [...messageCandidates.values()];

  const messagesByRun = new Map();
  await mapWithConcurrency(runCandidates, messageFetchConcurrency, async ({ issueId, run }) => {
    try {
      messagesByRun.set(run.id, await multicaJson(['issue', 'run-messages', run.id, '--issue', issueId]));
    } catch (error) {
      messagesByRun.set(run.id, { error: error.message, items: [] });
    }
  });

  return {
    workspace,
    agents: scopedAgents,
    skills: Array.isArray(skills) ? skills : [],
    squads: [targetSquad],
    issues,
    issueTotal: issues.length,
    runsByIssue,
    messagesByRun,
    scope: {
      kind: 'squad_direct_assignment',
      squadId: targetSquad.id,
      squadName: targetSquad.name,
      agentIds: [...squadAgentIds],
      memberCount: scopedAgents.length,
      issueAssignmentRule: `assignee_type=squad && assignee_id=${targetSquad.id}`
    },
    performanceScope: {
      kind: 'recent_granular_production',
      squadId: targetSquad.id,
      squadName: targetSquad.name,
      days: productionPerformanceDays,
      windowStart,
      titleMarker: granularProductionTitleMarker,
      issueIds: granularProductionIssues.map((issue) => issue.id),
      issueCount: granularProductionIssues.length
    }
  };
}
