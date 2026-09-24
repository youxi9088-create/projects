import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseTrendWindow, summarizeHealthTrend } from '../src/trend.js';

function snapshot({ score, blocked, warning, critical = blocked, active = 20 }) {
  return {
    overview: { score, criticalCount: critical, warningCount: warning, activeIssues: active },
    production: { blockedIssues: blocked }
  };
}

test('健康趋势按时间桶保留最后一次趋势指标，并保留指标口径', () => {
  const trend = summarizeHealthTrend([
    { collectedAt: '2026-08-11T00:01:00Z', snapshot: snapshot({ score: 18, blocked: 5, warning: 9 }) },
    { collectedAt: '2026-08-11T00:20:00Z', snapshot: snapshot({ score: 20, blocked: 4, warning: 8 }) },
    { collectedAt: '2026-08-11T00:35:00Z', snapshot: snapshot({ score: 24, blocked: 3, warning: 7 }) },
    { collectedAt: '2026-08-11T00:55:00Z', snapshot: snapshot({ score: 28, blocked: 2, warning: 6 }) }
  ], { windowHours: 24 });

  assert.equal(trend.bucketMinutes, 30);
  assert.equal(trend.sourceSnapshots, 4);
  assert.equal(trend.points.length, 2);
  assert.deepEqual(trend.points.map((point) => [point.score, point.blockedIssues, point.warningCount, point.sampleCount]), [[20, 4, 8, 2], [28, 2, 6, 2]]);
  assert.equal(trend.coverage.observedHours, 0.9);
});

test('趋势只提供 24 小时与 7 天窗口，并兼容旧快照缺少 blockedIssues', () => {
  assert.equal(normaliseTrendWindow('6'), 24);
  assert.equal(normaliseTrendWindow('48'), 24);
  const trend = summarizeHealthTrend([
    { collectedAt: '2026-08-11T00:00:00Z', snapshot: { overview: { score: 10, criticalCount: 7, warningCount: 2, activeIssues: 3 } } }
  ], { windowHours: 24 });
  assert.equal(trend.points[0].blockedIssues, 7);
});
