import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = Object.freeze({
  projectRoot,
  // The serving store intentionally contains the singleton current snapshot
  // and compact trend points only.  The legacy full-snapshot archive remains
  // untouched at data/health.db for offline retention.
  dataPath: process.env.HEALTH_DATA_PATH ?? path.join(projectRoot, 'data', 'health-live.db'),
  legacyDataPath: path.join(projectRoot, 'data', 'health.db'),
  skillEvalPath: path.join(projectRoot, 'config', 'skill-evals.json'),
  architectureReviewPath: process.env.SKILL_ARCHITECTURE_REVIEW_PATH ?? 'E:\\Multica\\skill-architecture-reviews-2026-08-12',
  publicPath: path.join(projectRoot, 'public'),
  port: integer('PORT', 8787),
  collectionIntervalMs: integer('COLLECTION_INTERVAL_SECONDS', 60) * 1000,
  activeIssueLimit: integer('ACTIVE_ISSUE_LIMIT', 40),
  runMessageLimit: integer('RUN_MESSAGE_LIMIT', 12),
  // Cloud collection is executed in FN's background request tail. Keep CLI
  // fan-out bounded so a complete scoped sweep remains reliable there.
  runFetchConcurrency: integer('RUN_FETCH_CONCURRENCY', 12),
  messageFetchConcurrency: integer('MESSAGE_FETCH_CONCURRENCY', 12),
  // All Runs are collected. Message evidence is bounded to the newest
  // production executions plus every blocked execution so a cloud refresh
  // completes inside the FN background window.
  cloudMessageCandidateLimit: integer('CLOUD_MESSAGE_CANDIDATE_LIMIT', 800),
  skillAuditConcurrency: integer('SKILL_AUDIT_CONCURRENCY', 6),
  // These are Multica object identifiers, not model credentials.  The UI only
  // creates a governed Issue; execution stays inside the assigned agents.
  darwinArchitectureReviewExecutorId: process.env.DARWIN_ARCHITECTURE_REVIEW_EXECUTOR_ID ?? '6ae9a301-4b94-41a9-acf3-60b85c6a0329',
  darwinArchitectureReviewSkillId: process.env.DARWIN_ARCHITECTURE_REVIEW_SKILL_ID ?? '448b1178-db59-479f-9a09-2448ac103142',
  productionPerformanceDays: integer('PRODUCTION_PERFORMANCE_DAYS', 7),
  granularProductionTitleMarker: process.env.GRANULAR_PRODUCTION_TITLE_MARKER ?? '【颗粒生产】',
  // This dashboard is deliberately scoped to a single production squad by
  // immutable Multica ID. The display name can legitimately change and must
  // never participate in selection.
  targetSquadId: process.env.TARGET_SQUAD_ID ?? '00c28d20-adae-4905-aede-d492c89a474d',
  // Multica's member endpoint reflects only the current roster. Keep the
  // previously observed roster so historical Runs from members who have
  // since rotated out remain attributable to this squad instead of making
  // completed-line metrics disappear after a roster change.
  historicalSquadAgentIds: Object.freeze([
    'fe75cb8a-58f6-4eb9-9cbd-b530e1b3d966', '78d4a2e5-fdd4-45fd-97d4-f210559eba69',
    '79c55f85-ac1c-4e0d-8f90-dc1de93c983e', '384b0500-7224-4bce-a0e4-52a4d6941a79',
    '34365e9b-1813-410a-9220-2c04b1a53f00', 'b04cf58f-b1e5-4598-88ca-3dc72832ef65',
    '9c99b29c-ef6f-408b-bd43-410f6dfff48d', '2d15cadc-4446-4d16-990b-858e82c5cb26',
    'e38ea54d-5792-41fa-8b73-0f4e31a0d654', '46513b29-4627-4068-bfff-83fc22edd405',
    '5fa5d100-c85f-4831-b6a6-9df385f1e5c7', 'b469d209-1d7d-4c97-9751-2391240aa596',
    '010a5fb5-ab29-444e-9699-bdf56079ef5b', '034e4856-6089-4058-8bbf-8df7e035edcc',
    '7a7b6766-5506-4ba4-8692-c5bdd257c311', '964f146a-55bd-4c37-a27e-bfb6815fa08b'
  ]),
  // Workspace-wide defaults are deliberately conservative until each production stage has an approved SLA.
  stallWarningMs: integer('STALL_WARNING_HOURS', 24) * 60 * 60 * 1000,
  stallCriticalMs: integer('STALL_CRITICAL_HOURS', 72) * 60 * 60 * 1000,
  runTimeoutMs: integer('RUN_TIMEOUT_HOURS', 2) * 60 * 60 * 1000,
  // A production line is not one-pass if a node remains in a running state
  // without a new heartbeat for this long, even when the Issue later closes.
  lineNodeStallMs: integer('LINE_NODE_STALL_HOURS', 4) * 60 * 60 * 1000,
  incidentLookbackMs: integer('INCIDENT_LOOKBACK_HOURS', 24) * 60 * 60 * 1000,
  workspaceSlug: process.env.MULTICA_WORKSPACE_SLUG ?? 'rpg2'
});

export const ACTIVE_ISSUE_STATUSES = new Set([
  'backlog', 'todo', 'in_progress', 'in_review', 'blocked'
]);
