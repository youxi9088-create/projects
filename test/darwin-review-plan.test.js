import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDarwinReviewPlan, confirmDarwinReviewPlan } from '../src/darwin-review-plan.js';

test('Darwin review plan separates test-prompt confirmation from independent review', () => {
  const plan = buildDarwinReviewPlan({ id: 'skill-1', name: 'demo', description: '生成可验证的结果', updated_at: '2026-08-13T00:00:00Z' });
  assert.equal(plan.kind, 'test_prompt_design');
  assert.equal(plan.status, 'draft');
  assert.equal(plan.prompts.length, 3);
  const confirmed = confirmDarwinReviewPlan(plan, plan.prompts);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.confirmedAt);
});
