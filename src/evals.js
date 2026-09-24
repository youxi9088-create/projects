import fs from 'node:fs';
import { config } from './config.js';

/**
 * Optional, reviewed regression-evaluation input. It is intentionally separate
 * from runtime logs: a skill must prove task quality on a fixed suite, not only
 * avoid process errors in production.
 */
export function loadSkillEvaluations() {
  if (!fs.existsSync(config.skillEvalPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(config.skillEvalPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('config/skill-evals.json 必须是 JSON 数组。');
  return parsed.filter((item) => item && typeof item.skillId === 'string' && Number.isFinite(item.total) && item.total > 0 && Number.isFinite(item.passed));
}
