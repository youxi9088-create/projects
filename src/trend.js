const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const TREND_WINDOWS = new Set([24, 168]);

export function normaliseTrendWindow(value) {
  const hours = Number(value);
  return TREND_WINDOWS.has(hours) ? hours : 24;
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function targetPointCount(windowHours) {
  if (windowHours <= 6) return 12;
  if (windowHours <= 24) return 24;
  return 28;
}

function bucketMinutes(rows, windowHours) {
  if (rows.length < 2) return 30;
  const first = Date.parse(rows[0].collectedAt);
  const last = Date.parse(rows.at(-1).collectedAt);
  const observedMinutes = Math.max(30, (last - first) / MINUTE_MS);
  const proposed = observedMinutes / targetPointCount(windowHours);
  return Math.max(30, Math.ceil(proposed / 30) * 30);
}

function snapshotMetrics(snapshot) {
  const overview = snapshot?.overview ?? {};
  const production = snapshot?.production ?? {};
  return {
    score: numeric(overview.score),
    blockedIssues: numeric(production.blockedIssues ?? overview.criticalCount),
    warningCount: numeric(overview.warningCount),
    criticalCount: numeric(overview.criticalCount),
    activeIssues: numeric(overview.activeIssues)
  };
}

export function summarizeHealthTrend(rows, { windowHours = 24 } = {}) {
  const hours = normaliseTrendWindow(windowHours);
  const validRows = rows
    .map((row) => ({
      collectedAt: row.collectedAt,
      collectedMs: Date.parse(row.collectedAt),
      snapshot: row.snapshot
    }))
    .filter((row) => Number.isFinite(row.collectedMs) && row.snapshot)
    .sort((left, right) => left.collectedMs - right.collectedMs);
  const minutes = bucketMinutes(validRows, hours);
  const bucketMs = minutes * MINUTE_MS;
  const buckets = new Map();

  for (const row of validRows) {
    const key = Math.floor(row.collectedMs / bucketMs) * bucketMs;
    const existing = buckets.get(key);
    buckets.set(key, {
      collectedAt: row.collectedAt,
      collectedMs: row.collectedMs,
      sampleCount: (existing?.sampleCount ?? 0) + 1,
      ...snapshotMetrics(row.snapshot)
    });
  }

  const points = [...buckets.values()]
    .sort((left, right) => left.collectedMs - right.collectedMs)
    .map(({ collectedMs, ...point }) => point);
  const first = validRows[0];
  const last = validRows.at(-1);
  return {
    windowHours: hours,
    bucketMinutes: minutes,
    sourceSnapshots: validRows.length,
    coverage: first && last ? {
      startsAt: first.collectedAt,
      endsAt: last.collectedAt,
      observedHours: Math.max(0, Math.round((last.collectedMs - first.collectedMs) / HOUR_MS * 10) / 10)
    } : null,
    points
  };
}
