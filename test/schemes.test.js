import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMES, normaliseScheme, schemeName, schemeNameEn, extractIssueSchemes, aggregateSchemeUsage, mergeSchemeUsage, buildSchemeUsage } from '../src/schemes.js';

test('catalog has exactly 28 schemes with Chinese and English names', () => {
  assert.equal(SCHEMES.length, 28);
  assert.ok(SCHEMES.every((s) => typeof s.id === 'string' && s.id.length > 0));
  assert.ok(SCHEMES.every((s) => typeof s.name === 'string' && s.name.length > 0));
  assert.ok(SCHEMES.every((s) => typeof s.nameEn === 'string' && s.nameEn.length > 0));
  assert.ok(SCHEMES.every((s) => ['core', 'carrier', 'closing'].includes(s.kind)));
  assert.equal(new Set(SCHEMES.map((s) => s.id)).size, 28);
});

test('normaliseScheme maps aliases to canonical ids', () => {
  assert.equal(normaliseScheme('judge'), 'judge-button');
  assert.equal(normaliseScheme('matching'), 'match-line');
  assert.equal(normaliseScheme('single-choice'), 'choice-text.text-single');
  assert.equal(normaliseScheme('single_choice'), 'choice-text.text-single');
  assert.equal(normaliseScheme('classification'), 'classify-drag');
  assert.equal(normaliseScheme('aigc-video'), 'aigc_video');
  assert.equal(normaliseScheme('choice-audio'), 'choice-audio.text-single');
  assert.equal(normaliseScheme('judge-button'), 'judge-button');
  assert.equal(normaliseScheme('unknown-scheme'), null);
});

test('extractIssueSchemes keeps both distinct schemes and repeated-use counts', () => {
  const { used, useCounts } = extractIssueSchemes([
    { id: 'r1', trigger_summary: '使用 judge 与 classify-drag', result: { output: '交付 settlement 和 judge-button' } },
    { id: 'r2', trigger_summary: '再次使用 judge-button', result: {} }
  ], new Map());
  assert.deepEqual([...used].sort(), ['classify-drag', 'judge-button', 'settlement']);
  assert.equal(useCounts.get('judge-button'), 3);
  assert.equal(useCounts.get('classify-drag'), 1);
});

test('extractIssueSchemes skips message fulltext noise (>=12 schemes)', () => {
  const allSchemes = SCHEMES.map((s) => s.id).join(' ');
  const { used } = extractIssueSchemes([{ id: 'r1', trigger_summary: '', result: {} }],
    new Map([['r1', { items: [{ content: allSchemes }] }]]));
  assert.deepEqual([...used], []);
});

test('extractIssueSchemes counts small message evidence', () => {
  const { used } = extractIssueSchemes([{ id: 'r1', trigger_summary: '', result: {} }],
    new Map([['r1', { items: [{ content: '此处选用 judge-button' }] }]]));
  assert.deepEqual([...used], ['judge-button']);
});

test('aggregateSchemeUsage separates use count from distinct Issue coverage', () => {
  const usage = aggregateSchemeUsage([
    { identifier: 'RPG-2', title: 'B', runs: [{ id: 'r1', trigger_summary: 'judge', result: {} }], messagesByRun: new Map() },
    { identifier: 'RPG-1', title: 'A', runs: [{ id: 'r1', trigger_summary: 'judge judge classify-drag', result: {} }], messagesByRun: new Map() }
  ], new Date('2026-01-01T00:00:00Z'));
  assert.equal(usage.schemeCount, 2);
  assert.equal(usage.issuesAnalysed, 2);
  assert.equal(usage.totalUseCount, 4);
  assert.equal(usage.totalIssueCoverage, 3);
  const judge = usage.schemes.find((s) => s.id === 'judge-button');
  assert.equal(judge.issueCount, 2);
  assert.equal(judge.useCount, 3);
  assert.deepEqual(judge.issues, ['RPG-1', 'RPG-2']);
  assert.deepEqual(usage.schemes.map((s) => s.id), ['judge-button', 'classify-drag']);
});

test('mergeSchemeUsage refreshes collected Issue conclusions and keeps uncollected history', () => {
  const existing = buildSchemeUsage([
    { identifier: 'RPG-1', title: 'A', schemes: ['judge-button'] }
  ], new Date('2026-01-01'));
  const incoming = buildSchemeUsage([
    { identifier: 'RPG-1', title: 'A', schemes: ['classify-drag'] },
    { identifier: 'RPG-2', title: 'B', schemes: ['fill-keyboard'] }
  ], new Date('2026-02-01'));
  const merged = mergeSchemeUsage(existing, incoming);
  assert.equal(merged.issuesAnalysed, 2);
  const rpg1 = merged.analysed.find((i) => i.identifier === 'RPG-1');
  assert.deepEqual(rpg1.schemes, ['classify-drag']);
  const rpg2 = merged.analysed.find((i) => i.identifier === 'RPG-2');
  assert.deepEqual(rpg2.schemes, ['fill-keyboard']);
  assert.equal(merged.schemes.find((s) => s.id === 'classify-drag').useCount, 1);
  assert.equal(merged.schemes.find((s) => s.id === 'fill-keyboard').useCount, 1);
});

test('mergeSchemeUsage refreshes a collected Issue so legacy dedup data gains occurrence counts', () => {
  const existing = buildSchemeUsage([
    { identifier: 'RPG-1', title: 'A', schemes: ['judge-button'] }
  ], new Date('2026-01-01'));
  const incoming = buildSchemeUsage([
    { identifier: 'RPG-1', title: 'A', schemes: ['judge-button'], schemeCounts: { 'judge-button': 4 } }
  ], new Date('2026-02-01'));
  const merged = mergeSchemeUsage(existing, incoming);
  const judge = merged.schemes.find((s) => s.id === 'judge-button');
  assert.equal(judge.issueCount, 1);
  assert.equal(judge.useCount, 4);
});

test('schemeName / schemeNameEn resolve catalog entries', () => {
  assert.equal(schemeName('judge-button'), '按钮判断');
  assert.equal(schemeNameEn('judge-button'), 'True/False Button');
  assert.equal(schemeName('missing'), 'missing');
});
