const DIMENSIONS = [
  { key: 'frontmatter', label: 'Frontmatter 质量', weight: 7 },
  { key: 'workflow', label: '工作流清晰度', weight: 12 },
  { key: 'failureModes', label: '失败模式编码', weight: 12 },
  { key: 'checkpoints', label: '检查点设计', weight: 6 },
  { key: 'specificity', label: '可执行具体性', weight: 18 },
  { key: 'resources', label: '资源整合度', weight: 4 },
  { key: 'architecture', label: '整体架构', weight: 12, requiresIndependentReview: true },
  { key: 'performance', label: '实测表现', weight: 23, requiresExecutionTest: true },
  { key: 'blacklist', label: '反例与黑名单', weight: 6 }
];

const score = (value) => Math.max(0, Math.min(10, Math.round(value * 10) / 10));

function count(text, expression) {
  return (text.match(expression) ?? []).length;
}

function frontmatter(content) {
  const matched = content.match(/^---\s*\n([\s\S]*?)\n---/);
  return matched ? matched[1] : '';
}

function dimension(key, value, detail, evidence = 'static') {
  const meta = DIMENSIONS.find((item) => item.key === key);
  return { ...meta, score: value == null ? null : score(value), detail, evidence };
}

/**
 * Darwin-aligned structural audit. It intentionally does not fabricate the
 * two dimensions that require independent judging or real test prompts.
 */
export function auditSkillContent(skill) {
  const content = String(skill.content ?? '');
  const files = Array.isArray(skill.files) ? skill.files : [];
  const header = frontmatter(content);
  const filePaths = new Set(files.map((file) => String(file.path ?? '')).filter(Boolean));
  const numberedSteps = count(content, /(^|\n)\s*(?:\d+\.|Step\s+\d+|步骤\s*\d+)/gim);
  const codeBlocks = count(content, /```/g) / 2;
  const failureSignals = count(content, /(?:如果|若|if)[\s\S]{0,80}(?:失败|错误|异常|fail(?:ed|ure)?|error|timeout|不可用|缺失)/gi);
  const fallbacks = count(content, /fallback|兜底|重试|恢复|替代方案|fail closed/gi);
  const checkpoints = count(content, /CHECKPOINT|\bSTOP\b|人工确认|用户确认|等待.*确认|审批|批准/gi);
  const fuzzyPhrases = count(content, /建议|可以考虑|根据情况|灵活把握|视情况而定/gi);
  const prohibited = count(content, /不要|禁止|不得|\bnever\b|\bdo not\b|avoid /gi);
  const riskMentions = count(content, /rm\s+-rf|git reset --hard|force push|删除|覆盖|破坏性/gi);
  const resourceRefs = [...content.matchAll(/(?:scripts|references|assets)\/[^\s)`]+/g)].map((match) => match[0]);
  const missingRefs = resourceRefs.filter((reference) => !filePaths.has(reference));

  const hasName = /^name:\s*\S+/mi.test(header);
  const hasDescription = /^description:\s*.+/mi.test(header);
  const hasTrigger = /(?:use when|适用于|当用户|触发|trigger)/i.test(header);
  const dimensions = [
    dimension('frontmatter', hasName && hasDescription ? (hasTrigger ? 10 : 8) : hasName || hasDescription ? 4 : 0,
      hasName && hasDescription ? (hasTrigger ? '包含名称、用途描述和触发语义。' : '包含名称和用途描述，但触发语义不明确。') : '缺少可验证的 name 或 description。'),
    dimension('workflow', numberedSteps >= 3 ? 9 : numberedSteps >= 1 ? 6 : content ? 3 : 0,
      numberedSteps >= 3 ? `识别到 ${numberedSteps} 个可编号执行步骤。` : '未识别到足够的编号工作流步骤。'),
    dimension('failureModes', failureSignals + fallbacks >= 3 ? 9 : failureSignals + fallbacks >= 1 ? 6 : 2,
      failureSignals + fallbacks ? `识别到 ${failureSignals} 条失败分支和 ${fallbacks} 个恢复/兜底信号。` : '未识别到明确的失败条件与恢复分支。'),
    dimension('checkpoints', checkpoints >= 2 ? 9 : checkpoints ? 6 : 2,
      checkpoints ? `识别到 ${checkpoints} 个显式确认或停止检查点。` : '未识别到显式 CHECKPOINT、STOP 或人工确认点。'),
    dimension('specificity', score(Math.min(10, 4 + numberedSteps * .6 + codeBlocks * .8 - fuzzyPhrases * .5)),
      `编号步骤 ${numberedSteps} 个、命令/示例块 ${codeBlocks} 个、模糊措辞 ${fuzzyPhrases} 处。`),
    dimension('resources', missingRefs.length ? 3 : resourceRefs.length ? 9 : files.length ? 7 : 5,
      missingRefs.length ? `${missingRefs.length} 个引用路径未在已采集文件中找到。` : resourceRefs.length ? `已验证 ${resourceRefs.length} 个资源引用。` : files.length ? `已采集 ${files.length} 个附属文件，但正文未声明路径引用。` : '没有附属资源引用。'),
    dimension('architecture', null, '需要独立评审者检查完整性、冗余和跨 Skill 边界；当前未接入独立评审。', 'pending_independent_review'),
    dimension('performance', null, '需要近期 7 天【颗粒生产】Issue 中、可归因到该 Skill 的终态 Run；至少 3 个终态样本后才评分。', 'pending_recent_production_sample'),
    dimension('blacklist', prohibited >= 3 ? (riskMentions && prohibited ? 10 : 8) : prohibited ? 6 : 2,
      prohibited ? `识别到 ${prohibited} 条禁止/避免动作${riskMentions ? `，其中 ${riskMentions} 条涉及高风险操作` : ''}。` : '未识别到明确的反例或高风险行动黑名单。')
  ];

  const runtimeWarnings = [...content.matchAll(/(?:在 Claude Code|Claude Code skill|Cursor only|Codex 中|~\/\.claude\/skills\/|\/plugin install\b)/gi)].map((match) => match[0]);
  return {
    schema: 'darwin-aligned-skill-audit/v1',
    auditedAt: new Date().toISOString(),
    sourceUpdatedAt: skill.updated_at ?? null,
    content: { available: Boolean(content), characters: content.length, files: files.length },
    runtimeGate: {
      status: !content ? 'not_observed' : runtimeWarnings.length ? 'review' : 'pass',
      detail: !content ? '未采集到完整 SKILL.md 正文。' : runtimeWarnings.length ? `发现 ${runtimeWarnings.length} 处可能绑定单一 runtime 的表述，需人工确认是否属于允许例外。` : '未发现 Darwin runtime 适配性红灯表达。',
      warnings: runtimeWarnings.slice(0, 5)
    },
    dimensions
  };
}

export function applyDarwinEvidence(audit, { productionPerformance, architectureReview } = {}) {
  if (!audit) return null;
  const dimensions = audit.dimensions.map((item) => ({ ...item }));
  const architecture = dimensions.find((item) => item.key === 'architecture');
  if (architecture && architectureReview) {
    architecture.score = score(architectureReview.architectureScore);
    architecture.detail = `${architectureReview.architectureDetail}（独立评审：${architectureReview.source?.fileName ?? '已接入评审文档'}）`;
    architecture.evidence = 'independent_architecture_review';
    architecture.review = architectureReview;
  }
  const performance = dimensions.find((item) => item.key === 'performance');
  if (performance && productionPerformance?.sampleSufficient) {
    performance.score = score(productionPerformance.successRate / 10);
    performance.detail = `近期 ${productionPerformance.days} 天 ${productionPerformance.titleMarker} Issue：共观察 ${productionPerformance.observedRuns} 个可归因 Run（终态 ${productionPerformance.terminalCalls}、非终态 ${productionPerformance.nonTerminalCalls}），终态中 ${productionPerformance.successCalls} 个成功、失败 ${productionPerformance.failedCalls}、超时 ${productionPerformance.timeoutCalls}，覆盖 ${productionPerformance.issueCount} 个 Issue。成功率仅以终态计算，非终态不按失败处理。${productionPerformance.medianDurationMs == null ? '无完整起止时间，未计算时长中位数。' : `中位时长 ${productionPerformance.medianDurationLabel}。`}`;
    performance.evidence = 'recent_granular_production';
  } else if (performance && productionPerformance) {
    performance.detail = `近期 ${productionPerformance.days} 天 ${productionPerformance.titleMarker} Issue：观察到 ${productionPerformance.observedRuns} 个可归因 Run（终态 ${productionPerformance.terminalCalls}、非终态 ${productionPerformance.nonTerminalCalls}）。至少需要 3 个终态 Run 才评分；成功率仅以终态计算。`;
    performance.evidence = 'insufficient_recent_production_sample';
  }
  const observed = dimensions.filter((item) => item.score != null);
  const observedWeight = observed.reduce((total, item) => total + item.weight, 0);
  const weighted = observed.reduce((total, item) => total + item.score * item.weight, 0);
  return {
    ...audit,
    dimensions,
    score: observedWeight ? Math.round(weighted / observedWeight * 10) / 10 : null,
    coverage: observedWeight,
    mode: performance?.evidence === 'recent_granular_production' ? 'static_plus_recent_production' : 'static_only',
    missingWeight: 100 - observedWeight
  };
}
