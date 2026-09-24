import fs from 'node:fs';
import path from 'node:path';

const REVIEW_FILE = /^\d{2}-.+\.md$/i;

function valueAfterLabel(content, label) {
  const match = content.match(new RegExp(`${label}[：:]\\s*\u0060?([^\u0060\\n]+)\u0060?`, 'i'));
  return match?.[1]?.trim() ?? null;
}

function markdownRows(content) {
  return [...content.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)]
    .map((match) => match.slice(1).map((value) => value.trim()))
    .filter((row) => !row.every((value) => /^:?-{3,}:?$/.test(value)));
}

/**
 * Reads only a deliberately authored Darwin architecture review.  It never
 * infers architecture quality from a filename or from a Skill's live usage.
 */
export function parseArchitectureReview(content, { filePath, updatedAt } = {}) {
  const text = String(content ?? '');
  const skillId = valueAfterLabel(text, 'Skill ID');
  const title = text.match(/^#\s*Darwin\s*架构评审[：:]\s*(.+)$/mi)?.[1]?.trim() ?? null;
  const architecture = text.match(/^\|\s*整体架构\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*([^|]+)\|\s*$/mi);
  if (!skillId || !architecture) return null;

  const score = Number(architecture[1]);
  if (!Number.isFinite(score) || score < 0 || score > 10) return null;
  const baseline = text.match(/基线\s*\*\*(\d+(?:\.\d+)?)\s*\/\s*100\*\*/i)?.[1] ?? null;
  const findings = markdownRows(text)
    .filter((row) => /^P[0-2]-\d+$/i.test(row[0]) && /^P[0-2]$/i.test(row[1]))
    .map(([id, priority, problem, action, acceptance]) => ({ id, priority, problem, action, acceptance }));

  return {
    skillId,
    skillName: title,
    architectureScore: score,
    architectureDetail: architecture[2].trim(),
    baselineScore: baseline == null ? null : Number(baseline),
    findings,
    source: {
      kind: 'independent_architecture_review',
      fileName: filePath ? path.basename(filePath) : null,
      filePath: filePath ?? null,
      updatedAt: updatedAt ?? null
    }
  };
}

export function loadArchitectureReviews(directory) {
  if (!directory || !fs.existsSync(directory)) return new Map();
  const reviews = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !REVIEW_FILE.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const review = parseArchitectureReview(fs.readFileSync(filePath, 'utf8'), {
      filePath,
      updatedAt: fs.statSync(filePath).mtime.toISOString()
    });
    if (review) reviews.set(review.skillId, review);
  }
  return reviews;
}
