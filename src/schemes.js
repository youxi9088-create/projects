// 互动方案目录与程序化使用分析。
// 方案目录以 interactive-game-schemes skill（v1.16.27）的 references/scheme_registry.json
// 为准：28 种方案，中文名取自 registry，英文名为方案 ID 的可读形式。
// 提取逻辑遵循与人工复核一致的证据口径：
//   - 优先取 run.trigger_summary（委托）与 run.result.output（回传）中的精确方案 ID；
//   - 运行消息仅作补充，且单条消息若同时命中大量不同方案（≥12）视为 skill 词表
//     噪声（Agent 加载 skill 全文时带出全部方案），不计入使用。

const SCHEME_CATALOG = [
  { id: 'ai_generated', name: 'AI 自生成互动', nameEn: 'AI-Generated Web', kind: 'carrier' },
  { id: 'avg_dialogue', name: 'AVG 立绘对话', nameEn: 'AVG Dialogue', kind: 'core' },
  { id: 'aigc_video', name: 'AIGC 视频', nameEn: 'AIGC Video', kind: 'carrier' },
  { id: 'aigc_video_button', name: 'AIGC 视频按钮决策', nameEn: 'AIGC Video Button', kind: 'core' },
  { id: 'video_item_select', name: '视频物件选择', nameEn: 'Video Item Select', kind: 'core' },
  { id: 'item_pickup_3d', name: '3D 证物拾取', nameEn: '3D Item Pickup', kind: 'core' },
  { id: 'scene_object_placement', name: '场景物品摆放', nameEn: 'Scene Object Placement', kind: 'core' },
  { id: 'settlement', name: '结算评价', nameEn: 'Settlement', kind: 'closing' },
  { id: 'classify-drag', name: '拖拽分类', nameEn: 'Drag-to-Classify', kind: 'core' },
  { id: 'classify-group-name', name: '分类归纳', nameEn: 'Classify by Group Name', kind: 'core' },
  { id: 'structured_record_table', name: '结构化记录表', nameEn: 'Structured Record Table', kind: 'core' },
  { id: 'variable_adjustment_record', name: '变量调节与规律记录', nameEn: 'Variable Adjustment Record', kind: 'core' },
  { id: 'data-chart-button', name: '实验数据分析', nameEn: 'Data Chart', kind: 'core' },
  { id: 'experiment_logic_builder', name: '实验逻辑构建', nameEn: 'Experiment Logic Builder', kind: 'core' },
  { id: 'sort-chain-drag', name: '逻辑链拖拽排序', nameEn: 'Chain Drag Sort', kind: 'core' },
  { id: 'judge-button', name: '按钮判断', nameEn: 'True/False Button', kind: 'core' },
  { id: 'judge-swipe', name: '滑动判断', nameEn: 'True/False Swipe', kind: 'core' },
  { id: 'match-line', name: '连线配对', nameEn: 'Match Lines', kind: 'core' },
  { id: 'sort-sentence', name: '句序排序', nameEn: 'Sentence Sort', kind: 'core' },
  { id: 'fill-keyboard', name: '键盘填空', nameEn: 'Keyboard Fill', kind: 'core' },
  { id: 'fill-drag', name: '拖拽填空', nameEn: 'Drag Fill', kind: 'core' },
  { id: 'fill-audio-voice', name: '语音互动', nameEn: 'Voice Answer', kind: 'core' },
  { id: 'choice-text.text-single', name: '文本单选（文本选项）', nameEn: 'Text Single Choice', kind: 'core' },
  { id: 'choice-audio.text-single', name: '听音单选', nameEn: 'Audio Single Choice', kind: 'core' },
  { id: 'choice-image.text-single', name: '看图单选', nameEn: 'Image Single Choice', kind: 'core' },
  { id: 'choice-text.image-single', name: '文本单选（图片选项）', nameEn: 'Text Single Choice (Image Options)', kind: 'core' },
  { id: 'choice-text.image-multi', name: '文本多选（图片选项）', nameEn: 'Text Multi Choice (Image Options)', kind: 'core' },
  { id: 'choice-text.text-multi', name: '文本多选（文本选项）', nameEn: 'Text Multi Choice', kind: 'core' }
];

// 归一化：把历史 run 里出现的别名/变体映射到目录 ID。
const SCHEME_ALIASES = {
  judge: 'judge-button',
  matching: 'match-line',
  'aigc-video': 'aigc_video',
  'choice-audio': 'choice-audio.text-single',
  single_choice: 'choice-text.text-single',
  'single-choice': 'choice-text.text-single',
  choice_text_text_single: 'choice-text.text-single',
  classification: 'classify-drag',
  avg_dialogue_video: 'avg_dialogue',
  'text-single': 'choice-text.text-single',
  'audio-single': 'choice-audio.text-single'
};

// 匹配目录 ID 与历史 run 里出现的别名/变体，匹配后再经 normaliseScheme 归一化。
// 按长度降序排列，确保 judge-button / judge-swipe 等长 ID 优先于裸 judge 命中。
const SCHEME_TOKENS = [...SCHEME_CATALOG.map((s) => s.id), ...Object.keys(SCHEME_ALIASES)]
  .sort((a, b) => b.length - a.length);
const SCHEME_ID_PATTERN = new RegExp(
  `\\b(${SCHEME_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi'
);

export const SCHEMES = SCHEME_CATALOG;

const SCHEME_BY_ID = new Map(SCHEME_CATALOG.map((s) => [s.id, s]));

export function schemeName(id) {
  return SCHEME_BY_ID.get(id)?.name ?? id;
}

export function schemeNameEn(id) {
  return SCHEME_BY_ID.get(id)?.nameEn ?? id;
}

export function schemeKind(id) {
  return SCHEME_BY_ID.get(id)?.kind ?? 'core';
}

export function normaliseScheme(token) {
  const raw = String(token ?? '').trim().toLowerCase();
  if (SCHEME_BY_ID.has(raw)) return raw;
  return SCHEME_ALIASES[raw] ?? null;
}

function collectSchemes(text, seen, counts = null) {
  for (const match of text.matchAll(SCHEME_ID_PATTERN)) {
    const id = normaliseScheme(match[1]);
    if (!id) continue;
    seen.add(id);
    if (counts) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
}

/**
 * 从一条 Issue 的全部 Run（委托/回传）与运行消息中提取"明确使用的互动方案"。
 * 返回 { used: Set<id>, useCounts: Map<id, number>, evidence }。
 * `used` 是“覆盖颗粒数”的去重基础；`useCounts` 则保留同一 Issue 内
 * 同一方案每一次明确出现的记录，供“使用次数（不去重）”累加。
 * - trigger_summary / result.output：直接计入（委托与回传是权威证据）。
 * - 消息：仅当一条消息命中的方案数 < 12 才计入（≥12 判为 skill 词表噪声）。
 */
export function extractIssueSchemes(issueRuns = [], messagesByRun = new Map()) {
  const used = new Set();
  const useCounts = new Map();
  const evidence = { delegations: new Set(), outputs: new Set(), messages: new Set() };
  const addEvidence = (text, bucket) => {
    const seen = new Set();
    collectSchemes(text, seen, useCounts);
    for (const id of seen) {
      used.add(id);
      bucket.add(id);
    }
  };
  const runList = Array.isArray(issueRuns) ? issueRuns : (issueRuns?.items ?? []);
  for (const run of runList) {
    const trigger = String(run.trigger_summary ?? '');
    const output = String(run.result?.output ?? run.result?.user_visible_output ?? '');
    if (trigger) addEvidence(trigger, evidence.delegations);
    if (output) addEvidence(output, evidence.outputs);
    const messages = messagesByRun.get(run.id);
    const rows = Array.isArray(messages) ? messages : (messages?.items ?? messages?.messages ?? []);
    for (const row of rows) {
      const text = typeof row === 'string' ? row : String(row.content ?? row.text ?? '');
      const seen = new Set();
      collectSchemes(text, seen);
      if (seen.size > 0 && seen.size < 12) {
        addEvidence(text, evidence.messages);
      }
    }
  }
  return { used, useCounts, evidence };
}

/** 把逐 Issue 的方案使用记录组装为统一汇总结构。 */
export function buildSchemeUsage(analysed, now = new Date()) {
  const usageByScheme = new Map();
  for (const item of analysed) {
    const schemeCounts = item.schemeCounts ?? {};
    const schemeIds = new Set([...(item.schemes ?? []), ...Object.keys(schemeCounts)]);
    for (const id of schemeIds) {
      const rec = usageByScheme.get(id) ?? { issues: new Set(), useCount: 0 };
      rec.issues.add(item.identifier ?? item.id);
      // Imported legacy rows only contain `schemes`; one is the conservative
      // fallback in that case. New cloud collections always persist the exact
      // no-dedup count in `schemeCounts`.
      const count = Number(schemeCounts[id]);
      rec.useCount += Number.isFinite(count) && count > 0 ? count : 1;
      usageByScheme.set(id, rec);
    }
  }
  const schemes = [...usageByScheme.entries()]
    .map(([id, rec]) => ({
      id,
      name: schemeName(id),
      nameEn: schemeNameEn(id),
      kind: schemeKind(id),
      issueCount: rec.issues.size,
      useCount: rec.useCount,
      issues: [...rec.issues].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    }))
    .sort((a, b) => b.useCount - a.useCount || b.issueCount - a.issueCount || a.id.localeCompare(b.id));
  return {
    generatedAt: new Date(now).toISOString(),
    schemeCount: schemes.length,
    issuesAnalysed: analysed.length,
    totalUseCount: schemes.reduce((total, scheme) => total + scheme.useCount, 0),
    totalIssueCoverage: schemes.reduce((total, scheme) => total + scheme.issueCount, 0),
    schemes,
    analysed
  };
}

/**
 * 汇总一批 done Issue 的互动方案使用。
 * @param {Array<{identifier, title, runs, messagesByRun}>} issues
 */
export function aggregateSchemeUsage(issues, now = new Date()) {
  const analysed = [];
  for (const issue of issues) {
    const { used, useCounts } = extractIssueSchemes(issue.runs ?? [], issue.messagesByRun ?? new Map());
    analysed.push({
      identifier: issue.identifier ?? issue.id,
      title: issue.title ?? '',
      schemes: [...used].sort(),
      schemeCounts: Object.fromEntries([...useCounts.entries()].sort(([left], [right]) => left.localeCompare(right)))
    });
  }
  return buildSchemeUsage(analysed, now);
}

/**
 * 合并历史汇总与新汇总：本轮重新采集到的 Issue 以新证据覆盖旧结论，
 * 这样旧版只有去重集合的数据会被补成无去重次数；本轮未采集到的 Issue
 * 才保留历史结论。
 */
export function mergeSchemeUsage(existing, incoming) {
  const merged = new Map();
  for (const item of existing?.analysed ?? []) merged.set(item.identifier ?? item.id, item);
  for (const item of incoming?.analysed ?? []) {
    merged.set(item.identifier ?? item.id, item);
  }
  const analysed = [...merged.values()].sort((a, b) => String(a.identifier ?? a.id).localeCompare(String(b.identifier ?? b.id), 'zh-CN'));
  return buildSchemeUsage(analysed, incoming?.generatedAt ?? existing?.generatedAt ?? new Date());
}
