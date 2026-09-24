import { config } from './config.js';
import { beginCollection, dailyHealthSummary, finishCollection, loadSkillAudits, saveServiceCheck, saveSkillAudits, saveSnapshot, saveSource } from './db.js';
import { buildHealthSnapshot } from './health.js';
import { loadSkillEvaluations } from './evals.js';
import { auditSkillContent } from './skill-audit.js';
import { loadArchitectureReviews } from './architecture-reviews.js';
import { collectWorkspaceSource, getSkillDetail } from './multica.js';

let collecting = false;

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      results.push(await mapper(item));
    }
  });
  await Promise.all(workers);
  return results;
}

async function enrichSkillsWithDarwinAudits(source) {
  const cachedAudits = loadSkillAudits();
  const pending = source.skills.filter((skill) => {
    const cached = cachedAudits.get(skill.id);
    return !cached || cached.sourceUpdatedAt !== (skill.updated_at ?? null);
  });
  const freshAudits = await mapWithConcurrency(pending, config.skillAuditConcurrency, async (skill) => {
    try {
      const detail = await getSkillDetail(skill.id);
      const audit = auditSkillContent({ ...detail, updated_at: detail.updated_at ?? skill.updated_at });
      cachedAudits.set(skill.id, audit);
      return { skillId: skill.id, audit };
    } catch (error) {
      // A single unreadable Skill must not make the operational dashboard stale.
      console.warn(`[Skill full-content audit failed] ${skill.name ?? skill.id}: ${error.message}`);
      return null;
    }
  });
  saveSkillAudits(freshAudits.filter(Boolean));
  const architectureReviews = loadArchitectureReviews(config.architectureReviewPath);
  source.skills = source.skills.map((skill) => ({
    ...skill,
    darwinAudit: cachedAudits.get(skill.id) ?? null,
    architectureReview: architectureReviews.get(skill.id) ?? null
  }));
  return { audited: freshAudits.filter(Boolean).length, pending: pending.length };
}

export async function collectOnce() {
  if (collecting) return { skipped: true, reason: '采集已在进行中' };
  collecting = true;
  const startedAt = new Date().toISOString();
  const collectionId = beginCollection(startedAt);
  const probeStarted = performance.now();
  try {
    const source = await collectWorkspaceSource(config);
    await enrichSkillsWithDarwinAudits(source);
    const checkedAt = new Date().toISOString();
    const serviceChecks = [{
      serviceName: 'Multica CLI / 工作区读取',
      status: 'healthy',
      latencyMs: Math.round(performance.now() - probeStarted),
      detail: `已只读获取工作区 ${source.workspace.name}、${source.issues.length} 条 Issue 和 ${[...source.runsByIssue.values()].reduce((count, value) => count + (Array.isArray(value) ? value.length : value.items?.length ?? 0), 0)} 条 Run。`,
      checkedAt
    }];
    saveSource(source, checkedAt);
    for (const check of serviceChecks) saveServiceCheck(check);
    const skillEvaluations = loadSkillEvaluations();
    const snapshot = buildHealthSnapshot(source, { ...config, serviceChecks, skillEvaluations, now: checkedAt });
    snapshot.daily = dailyHealthSummary(snapshot, checkedAt);
    saveSnapshot(snapshot, checkedAt);
    finishCollection(collectionId, { finishedAt: new Date().toISOString(), status: 'completed', summary: snapshot.overview });
    return { skipped: false, snapshot };
  } catch (error) {
    const checkedAt = new Date().toISOString();
    const serviceCheck = {
      serviceName: 'Multica CLI / 工作区读取',
      status: 'unhealthy',
      latencyMs: Math.round(performance.now() - probeStarted),
      detail: error.message,
      checkedAt
    };
    saveServiceCheck(serviceCheck);
    finishCollection(collectionId, { finishedAt: checkedAt, status: 'failed', error: error.message });
    throw error;
  } finally {
    collecting = false;
  }
}

if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) {
  collectOnce().then(({ snapshot, skipped }) => {
    if (skipped) console.log('采集跳过：已有任务运行中。');
    else console.log(JSON.stringify(snapshot.overview, null, 2));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
