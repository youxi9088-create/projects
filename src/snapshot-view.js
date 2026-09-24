function pick(object, keys) {
  return Object.fromEntries(keys.flatMap((key) => Object.hasOwn(object ?? {}, key) ? [[key, object[key]]] : []));
}

function skillSummary(skills) {
  return pick(skills, ['total', 'called', 'unpublished', 'published', 'drafts', 'performanceEvaluation', 'performanceScope', 'note']);
}

function riskSummary(incidents = []) {
  return incidents.reduce((summary, incident) => {
    const category = incident.kind === 'production_blocked'
      ? 'critical'
      : incident.kind === 'no_progress'
        ? 'progress'
        : ['task_failure', 'retry_loop', 'task_timeout'].includes(incident.kind)
          ? 'execution'
          : 'warning';
    summary[category] += 1;
    return summary;
  }, { critical: 0, progress: 0, execution: 0, warning: 0 });
}

function compactDaily(daily = {}) {
  const rework = daily.reworkIssues;
  if (!rework) return daily;
  return {
    ...daily,
    reworkIssues: {
      ...rework,
      // Page cards need only the primary node's summary. Full node evidence
      // is loaded on demand from /api/rework-issue, keeping a page snapshot
      // below the cloud document and response limits.
      items: (rework.items ?? []).map((issue) => ({
        ...issue,
        reworkNodes: (issue.reworkNodes ?? []).slice(0, 1).map((node) => pick(node, [
          'node', 'agentNames', 'taskCount', 'statusSummary', 'reason',
          'reasonType', 'reasonConfidence', 'reasonSource', 'firstAt', 'lastAt'
        ]))
      }))
    }
  };
}

/**
 * The persisted snapshot is deliberately comprehensive for local drill-down.
 * Page reads must not transfer unrelated full-detail sections on every refresh.
 */
export function snapshotView(snapshot, page = 'overview') {
  if (!snapshot) return null;
  const base = pick(snapshot, ['generatedAt', 'workspace', 'overview', 'coverage']);
  if (page === 'risks') return { ...base, incidents: snapshot.incidents ?? [] };
  if (page === 'agents') return { ...base, agents: snapshot.agents ?? [], incidents: snapshot.incidents ?? [] };
  if (page === 'skills') return { ...base, skills: snapshot.skills ?? {}, incidents: snapshot.incidents ?? [] };
  if (page === 'production') return {
    ...base,
    production: snapshot.production ?? {},
    daily: compactDaily(snapshot.daily),
    services: snapshot.services ?? []
  };
  return {
    ...base,
    // Overview does not receive the incident evidence list, but its risk
    // cards need the same category totals as the risk queue and score.
    riskSummary: riskSummary(snapshot.incidents ?? []),
    production: snapshot.production ?? {},
    daily: compactDaily(snapshot.daily),
    skills: skillSummary(snapshot.skills ?? {})
  };
}
