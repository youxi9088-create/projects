import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotView } from '../src/snapshot-view.js';

const snapshot = {
  generatedAt: '2026-08-13T00:00:00Z',
  workspace: { id: 'workspace' }, overview: { score: 80 }, coverage: { issuesCollected: 2 },
  production: { blockedIssues: 1 }, daily: { date: { label: 'today' } }, services: [{ serviceName: 'Multica' }],
  incidents: [{ id: 'blocked:1', issue: { id: 'issue-1' } }], agents: [{ id: 'agent-1' }],
  skills: { unpublished: 2, assessments: [{ id: 'skill-1', darwin: { dimensions: Array(50).fill({}) } }] }
};

test('page snapshot omits unrelated heavy sections while keeping each page renderable', () => {
  const risks = snapshotView(snapshot, 'risks');
  assert.deepEqual(risks.incidents, snapshot.incidents);
  assert.equal('skills' in risks, false);
  assert.equal('production' in risks, false);

  const overview = snapshotView(snapshot, 'overview');
  assert.equal(overview.skills.unpublished, 2);
  assert.equal('assessments' in overview.skills, false);
  assert.deepEqual(overview.production, snapshot.production);
  assert.deepEqual(overview.riskSummary, { critical: 0, progress: 0, execution: 0, warning: 1 });
});
