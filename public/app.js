const $ = (selector) => document.querySelector(selector);
// FN hosts this app below /a/<app-name>/. Resolve every internal URL against
// that mount point so the dashboard also works when it is not served at '/'.
const appBaseUrl = new URL('./', window.location.href);
const appUrl = (path = '') => new URL(String(path).replace(/^\/+/, ''), appBaseUrl);
// The public FN URL is CDN-backed. Give read requests a lightweight nonce so
// a just-completed cloud collection cannot be shadowed by an older API cache.
const apiUrl = (path = '') => {
  const url = appUrl(`api/${String(path).replace(/^\/+/, '')}`);
  url.searchParams.set('_refresh', String(Date.now()));
  return url;
};
// Bump this whenever a snapshot field changes meaning.  A cached browser
// snapshot must never be rendered with a newer metric formula.
const HEALTH_SESSION_CACHE_KEY = 'rpg2-health-monitor.snapshot.v7';
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const state = {
  snapshot: null,
  incidentFilter: 'critical',
  incidentLimit: 8,
  agentFilter: 'attention',
  agentLimit: 8,
  skillFilter: 'recent-production',
  skillLimit: 8,
  trend: null,
  trendRange: 24,
  trendMetric: 'score',
  refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS
};

const filterValues = {
  incident: new Set(['critical', 'warning', 'execution', 'progress', 'all']),
  agent: new Set(['attention', 'critical', 'all']),
  skill: new Set(['recent-production', 'runtime-risk', 'unpublished', 'attention', 'all']),
  trendRange: new Set([24, 168]),
  trendMetric: new Set(['score', 'blockedIssues', 'warningCount'])
};

let lastDialogTrigger = null;
let trendRequestVersion = 0;
let scheduledRefreshTimer = null;
let collectionPollTimer = null;
let architectureReviewItems = [];
let architecturePromptPlans = [];

function announce(message) {
  const region = $('#announcement');
  if (!region) return;
  region.textContent = '';
  window.setTimeout(() => { region.textContent = message; }, 20);
}

function ensureRulesNavigation() {
  const nav = document.querySelector('.quick-nav');
  if (!nav) return;
  // Each page ships the navigation statically for no-JS operation. Repair it
  // against one canonical list at runtime too: cached/older Agent HTML used
  // to omit the final link, and checking only a literal relative href failed
  // after FN resolved a link to its mounted absolute URL.
  const items = [
    ['overview', '概览', ''], ['risks', '风险队列', 'risks.html'],
    ['production', '生产线', 'production.html'], ['agents', 'Agent', 'agents.html'],
    ['skills', 'Skill', 'skills.html'], ['rules', '度量规则', 'rules.html'],
    ['schemes', '互动方案', 'schemes.html']
  ];
  for (const [page, label, path] of items) {
    const expected = appUrl(path).pathname;
    let link = [...nav.querySelectorAll('a')].find((item) => {
      try { return new URL(item.href, window.location.href).pathname === expected; } catch { return false; }
    });
    if (!link) {
      link = document.createElement('a');
      link.href = appUrl(path).href;
      nav.append(link);
    }
    link.textContent = label;
    if (currentPage() === page) link.setAttribute('aria-current', 'page');
  }
}

function safeRefreshInterval(value) {
  return Number.isFinite(value) && value >= 15_000 ? value : DEFAULT_REFRESH_INTERVAL_MS;
}

function currentPage() {
  return document.body?.dataset.page || 'overview';
}

function healthSessionCacheKey() {
  // Each endpoint intentionally returns only the data needed by its page.
  // Caching an overview payload under a shared key would make Agent and Skill
  // pages render without their own lists after client-side navigation.
  return `${HEALTH_SESSION_CACHE_KEY}.${currentPage()}`;
}

function readCachedHealthState() {
  try {
    const cached = JSON.parse(window.sessionStorage.getItem(healthSessionCacheKey()) ?? 'null');
    if (!cached?.snapshot) return null;
    if (currentPage() === 'overview') {
      const line = cached.snapshot.production?.linePerformance;
      // The line-performance cards are a reconcilable metric set.  Discard
      // pre-v2 snapshots rather than showing an old numerator under new labels.
      return Number.isFinite(line?.blockedLineCount) && Number.isFinite(line?.terminalBlockOccurrences)
        ? cached
        : null;
    }
    return cached;
  } catch {
    return null;
  }
}

function cacheHealthState() {
  try {
    const previous = readCachedHealthState();
    const hasFreshTrend = Boolean(state.trend);
    window.sessionStorage.setItem(healthSessionCacheKey(), JSON.stringify({
      snapshot: state.snapshot,
      refreshIntervalMs: state.refreshIntervalMs,
      trend: hasFreshTrend ? state.trend : previous?.trend ?? null,
      trendRange: hasFreshTrend ? state.trendRange : previous?.trendRange ?? null
    }));
  } catch {
    // Session storage can be unavailable in restricted browser contexts. The
    // fixed timer still provides the same refresh cadence in that case.
  }
}

function scheduleFixedRefresh() {
  window.clearTimeout(scheduledRefreshTimer);
  const interval = safeRefreshInterval(state.refreshIntervalMs);
  const delay = interval - (Date.now() % interval) || interval;
  scheduledRefreshTimer = window.setTimeout(async () => {
    await refresh({ refreshTrendData: true });
    scheduleFixedRefresh();
  }, delay);
}

function restoreFiltersFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const incident = params.get('risk');
  const agent = params.get('agent');
  const skill = params.get('skill');
  const trendRange = Number(params.get('trend_range'));
  const trendMetric = params.get('trend_metric');
  if (filterValues.incident.has(incident)) state.incidentFilter = incident;
  if (filterValues.agent.has(agent)) state.agentFilter = agent;
  if (filterValues.skill.has(skill)) state.skillFilter = skill;
  if (filterValues.trendRange.has(trendRange)) state.trendRange = trendRange;
  if (filterValues.trendMetric.has(trendMetric)) state.trendMetric = trendMetric;
}

function syncFiltersToUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('risk', state.incidentFilter);
  url.searchParams.set('agent', state.agentFilter);
  url.searchParams.set('skill', state.skillFilter);
  url.searchParams.set('trend_range', state.trendRange);
  url.searchParams.set('trend_metric', state.trendMetric);
  window.history.replaceState({}, '', url);
}

function navigateTo(path, params = {}, hash = '') {
  const url = appUrl(path);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  url.hash = hash;
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&gt;', '>': '&lt;', "'": '&#039;', '"': '&quot;' })[character]);
}

function number(value) { return new Intl.NumberFormat('zh-CN').format(value ?? 0); }

function percent(value) { return Number.isFinite(value) ? `${value}%` : '样本不足'; }

function decimal(value) { return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : '样本不足'; }

function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString('zh-CN', { hour12: false });
}

function statusLabel(status) {
  return ({ healthy: '健康', warning: '需关注', critical: '异常', unhealthy: '不可用', unknown: '证据不足' })[status] ?? status;
}

function statusClass(status) {
  return ['healthy', 'warning', 'critical', 'unknown'].includes(status) ? status : 'unknown';
}

function severityLabel(severity) { return severity === 'critical' ? '关键' : '关注'; }

function scoreCell(score, confidence) {
  if (score == null) return '<span class="score-muted">证据不足</span>';
  return `<strong class="score-value">${score}</strong><span class="score-meta">置信度 ${confidence ?? 0}%</span>`;
}

function incidentCategoryCounts(snapshot) {
  if (snapshot?.riskSummary) {
    return { critical: 0, progress: 0, execution: 0, warning: 0, ...snapshot.riskSummary };
  }
  return (snapshot?.incidents ?? []).reduce((counts, incident) => {
    const category = incidentCategory(incident);
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  }, { critical: 0, progress: 0, execution: 0, warning: 0 });
}

function healthScoreBreakdown(snapshot) {
  const categories = incidentCategoryCounts(snapshot);
  // API severity is the scoring source of truth. Category counts are its
  // mutually-exclusive display breakdown, so labels and calculation reconcile.
  const criticalCount = Number(snapshot?.overview?.criticalCount ?? categories.critical) || 0;
  const warningCount = Number(snapshot?.overview?.warningCount ?? (categories.progress + categories.execution + categories.warning)) || 0;
  const criticalPenalty = Math.min(70, criticalCount * 8);
  const warningPenalty = Math.min(20, warningCount * 2);
  return { categories, criticalCount, warningCount, criticalPenalty, warningPenalty };
}

function darwinModeLabel(mode) {
  return mode === 'static_plus_recent_production' ? '静态 + 近期颗粒生产实测' : '静态证据';
}

function runtimeGateLabel(runtimeGate) {
  if (!runtimeGate) return '未采集';
  if (runtimeGate.status === 'pass') return 'Runtime 适配：未见红灯';
  if (runtimeGate.status === 'review') return 'Runtime 适配：需人工复核';
  return 'Runtime 适配：未观测';
}

function darwinScoreCell(skill) {
  if (!skill.darwin || skill.score == null) return '<span class="score-muted">全文待采集</span><span class="score-meta">尚未读取 SKILL.md 正文</span>';
  return `<strong class="score-value">${skill.score}<small>/100</small></strong><span class="score-meta">${darwinModeLabel(skill.darwin.mode)} · 证据覆盖 ${skill.darwin.coverage}%</span>`;
}

function darwinGap(skill) {
  if (!skill.darwin) return '待采集完整正文与文件';
  const pending = skill.darwin.dimensions.filter((item) => item.score == null).sort((left, right) => right.weight - left.weight);
  if (pending.length) return `待补：${pending.map((item) => item.label).join('、')}`;
  const weakest = skill.darwin.dimensions.filter((item) => item.score != null).sort((left, right) => left.score - right.score)[0];
  return weakest && weakest.score < 70 ? `${weakest.label} ${weakest.score}/100` : '当前已覆盖维度无明显短板';
}

function productionPerformanceSummary(performance) {
  const scopeLabel = performance?.timeRange === 'all_retained_history' ? '全部小队直接指派 Issue' : '近 7 天颗粒生产';
  if (!performance || !performance.observedRuns) return `${scopeLabel}：未识别到该 Skill 的调用证据`;
  const marker = performance.titleMarker || '【颗粒生产】';
  if (!performance.sampleSufficient) return performance.timeRange === 'all_retained_history'
    ? `${scopeLabel}：${performance.terminalCalls}/3 个终态样本，暂不评分`
    : `近 7 天 ${marker}：${performance.terminalCalls}/3 个终态样本，暂不评分`;
  const timing = performance.medianDurationLabel ? ` · 中位 ${performance.medianDurationLabel}` : '';
  return performance.timeRange === 'all_retained_history'
    ? `${scopeLabel}：${performance.successCalls}/${performance.terminalCalls} 成功${timing}`
    : `近 7 天 ${marker}：${performance.successCalls}/${performance.terminalCalls} 成功${timing}`;
}

function filterButton(group, value, label, selected) {
  return `<button class="filter-button ${selected === value ? 'selected' : ''}" type="button" data-action="set-${group}-filter" data-value="${value}" aria-pressed="${selected === value}">${label}</button>`;
}

function showMoreButton(target, visible, total) {
  if (total <= visible) return '';
  return `<button class="show-more" type="button" data-action="expand-${target}">显示其余 ${total - visible} 条</button>`;
}

function renderHero(snapshot) {
  const { overview, workspace } = snapshot;
  const score = healthScoreBreakdown(snapshot);
  $('#hero').classList.remove('skeleton');
  $('#hero').innerHTML = `
    <div class="hero-copy">
      <p class="eyebrow">${escapeHtml(workspace.name)} · ${escapeHtml(workspace.slug)}</p>
      <h1>教育互动游戏生产线健康度检测台</h1>
      <p class="hero-decision">健康指数按风险事件计分：生产阻塞每条 −8 分（最多 −70）；全部非阻塞风险每条 −2 分（合计最多 −20）。</p>
      <p>非阻塞风险包含长期无推进、执行异常、Skill／服务／治理风险；审核中是独立状态，不属于风险分类，也不计入健康指数。</p>
    </div>
    <div class="hero-score ${statusClass(overview.status)}"><span>健康指数</span><strong>${overview.score}</strong><em>${statusLabel(overview.status)}</em><small>本轮扣分：阻塞 −${number(score.criticalPenalty)}；非阻塞 −${number(score.warningPenalty)}</small></div>`;
}

function renderActions(snapshot) {
  const score = healthScoreBreakdown(snapshot);
  const { categories } = score;
  const { skills } = snapshot;
  // The overview endpoint excludes the full incident list to keep first paint
  // fast.  Its action strip still renders from the aggregate score safely.
  const unpublishedSignalCount = (snapshot.incidents ?? []).filter((item) => item.kind === 'skill_unpublished').length;
  $('#action-strip').classList.remove('skeleton');
  $('#action-strip').innerHTML = `
    <button class="action-card critical" type="button" data-action="set-incident-filter" data-value="critical">
      <span class="action-kicker">生产阻塞（重要风险）</span><strong>${number(categories.critical)}</strong><span>Issue = blocked</span><small>健康指数每条 −8 分；本类本轮扣 −${number(score.criticalPenalty)}（最多 −70）</small>
    </button>
    <button class="action-card warning" type="button" data-action="set-incident-filter" data-value="execution">
      <span class="action-kicker">执行异常（非阻塞风险）</span><strong>${number(categories.execution)}</strong><span>失败、超时或反复重试</span><small>每条计入非阻塞风险 −2 分；需通过执行链证据确认业务影响</small>
    </button>
    <button class="action-card warning" type="button" data-action="set-incident-filter" data-value="progress">
      <span class="action-kicker">长期无推进（推进风险）</span><strong>${number(categories.progress)}</strong><span>非 blocked 生产 Issue 超过推进阈值</span><small>每条计入非阻塞风险 −2 分；审核中不纳入此类</small>
    </button>
    <button class="action-card neutral" type="button" data-action="set-incident-filter" data-value="warning">
      <span class="action-kicker">Skill／服务／治理风险</span><strong>${number(categories.warning)}</strong><span>非阻塞风险事件</span><small>${unpublishedSignalCount ? `${number(skills.unpublished)} 个未发布 Skill 合并为 ${number(unpublishedSignalCount)} 条风险事件计分` : '每条计入非阻塞风险 −2 分'}</small>
    </button>`;
}

function renderOverview(snapshot) {
  const { production, skills, coverage } = snapshot;
  $('#overview-cards').classList.remove('skeleton');
  const cards = [
    { tone: 'critical', value: production.blockedIssues, label: '生产阻塞', hint: '直接处于 blocked 状态的 Issue', action: 'set-incident-filter', actionValue: 'critical', actionLabel: '查看重要风险' },
    { tone: 'warning', value: skills.unpublished, label: '未发布 Skill', hint: '有草稿但没有生产可用版本', action: 'set-skill-filter', actionValue: 'unpublished', actionLabel: '查看未发布 Skill' },
    { tone: 'info', value: production.reviewCount, label: '审核中队列', hint: '独立运营状态，不计入重要风险', action: 'jump-review-queue', actionLabel: '查看审核中队列' },
    { tone: 'healthy', value: coverage.issuesCollected, label: 'Issue 覆盖', hint: `Multica 报告总量 ${number(coverage.issuesReportedByMultica)}` }
  ];
  $('#overview-cards').innerHTML = cards.map((card) => card.action
    ? `<button class="metric metric-link ${card.tone}" type="button" data-action="${card.action}"${card.actionValue ? ` data-value="${card.actionValue}"` : ''} aria-label="${card.actionLabel}"><p>${card.label}</p><strong>${number(card.value)}</strong><span>${card.hint}</span><small>${card.actionLabel} →</small></button>`
    : `<article class="metric metric-static ${card.tone}"><p>${card.label}</p><strong>${number(card.value)}</strong><span>${card.hint}</span></article>`
  ).join('');
}

function dailyItemsMarkup(items, renderItem, empty, limit = 3) {
  if (!items.length) return `<p class="daily-empty">${escapeHtml(empty)}</p>`;
  const visible = items.slice(0, limit);
  const extra = items.length - visible.length;
  return `${visible.map(renderItem).join('')}${extra ? `<p class="daily-more">其余 ${number(extra)} 项请到归属页面查看。</p>` : ''}`;
}

function dailyScoreMarkup(item) {
  if (item.score == null) return '<span class="daily-score muted">评分待补充</span>';
  return `<span class="daily-score"><b>${number(item.score)}</b><small>${escapeHtml(item.scoreLabel)}</small></span>`;
}

function capabilityMarkup(item) {
  return `<article class="daily-capability"><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.purpose)}</p></div>${dailyScoreMarkup(item)}</article>`;
}

function renderDailySummary(snapshot) {
  const container = $('#daily-health-content');
  const caption = $('#daily-health-caption');
  if (!container || !caption) return;
  const daily = snapshot.daily;
  container.classList.remove('skeleton');
  if (!daily) {
    caption.textContent = '等待下一次采集生成当日汇总';
    container.innerHTML = '<div class="empty">当前快照早于每日汇总功能。点击“立即采集”后即可生成今日分析。</div>';
    return;
  }
  const started = daily.issueFlow?.started ?? { count: 0, items: [] };
  const completed = daily.issueFlow?.completed ?? { count: 0, items: [], exactCount: 0, proxyCount: 0 };
  const blockers = daily.blockers ?? { count: 0, items: [] };
  const capabilities = daily.capabilities ?? {};
  const createdSkills = capabilities.createdSkills ?? { count: 0, items: [] };
  const publishedSkills = capabilities.publishedSkills ?? { count: 0, items: [] };
  const createdAgents = capabilities.createdAgents ?? { count: 0, items: [] };
  const rework = daily.reworkIssues ?? { count: 0, items: [], threshold: 3 };
  caption.textContent = `${daily.date?.label ?? '今日'} · 上海时区 · 截至 ${time(daily.generatedAt)}`;
  container.innerHTML = `
    <div class="daily-kpi-grid">
      <article class="daily-stat"><span>今日启动 Issue</span><strong>${number(started.count)}</strong><small>按 Issue 创建时间统计</small></article>
      <article class="daily-stat"><span>今日完成 Issue</span><strong>${number(completed.count)}</strong><small>${completed.exactCount ? `已观测转移 ${number(completed.exactCount)} 项` : '按完成态更新时间推定'}${completed.proxyCount ? ` · 推定 ${number(completed.proxyCount)} 项` : ''}</small></article>
      <article class="daily-stat critical"><span>当前阻塞 Issue</span><strong>${number(blockers.count)}</strong><small>仅统计 status=blocked，不含审核中</small></article>
      <article class="daily-stat warning"><span>多次返工 Issue</span><strong>${number(rework.count)}</strong><small>工作区近 ${number(rework.windowDays ?? 7)} 天终态颗粒生产 Issue；单节点至少被激活或执行 3 次</small></article>
    </div>
    <div class="daily-analysis-grid">
      <article class="daily-section daily-blocker-section">
        <div class="daily-section-heading"><div><p class="eyebrow">阻塞归因</p><h3>当前卡点与原因</h3></div><a href="${appUrl('risks.html?risk=critical').href}">查看风险队列</a></div>
        <div class="daily-item-list">${dailyItemsMarkup(blockers.items, (item) => { const confidence = item.confidence === 'high' ? 'high' : item.confidence === 'medium' ? 'medium' : 'low'; const label = confidence === 'high' ? '高置信' : confidence === 'medium' ? '待复核' : '证据不足'; return `<article class="daily-blocker"><p><span>${escapeHtml(item.identifier)}</span><em class="daily-confidence ${confidence}">${label}</em></p><strong>${escapeHtml(item.node)}</strong><small>${escapeHtml(item.cause)}</small></article>`; }, '当前没有处于 blocked 状态的 Issue。')}</div>
      </article>
      <article class="daily-section">
        <div class="daily-section-heading"><div><p class="eyebrow">返工风险</p><h3>存在多次返工的 Issue</h3></div><a href="${appUrl('production.html#production-rework-analysis').href}">查看生产线</a></div>
        <div class="daily-item-list">${dailyItemsMarkup(rework.items, (item) => `<article class="daily-recurring"><div><strong>${escapeHtml(item.identifier)}${item.title ? ` · ${escapeHtml(item.title)}` : ''}</strong><p>识别到 ${number(item.reworkNodeCount)} 个返工节点；最多重复的节点「${escapeHtml(item.node)}」共 ${number(item.taskCount)} 次</p></div><small>Run 状态：${escapeHtml(item.statusSummary)}</small></article>`, escapeHtml(rework.analysisEvidence?.detail ?? '当前采集范围内未发现满足返工识别口径的 Issue。'))}</div>
      </article>
      <article class="daily-section">
        <div class="daily-section-heading"><div><p class="eyebrow">能力变更</p><h3>今日新增与发布</h3></div><a href="${appUrl('skills.html?skill=all').href}">查看 Skill</a></div>
        <div class="daily-capability-group"><h4>新增 Skill ${number(createdSkills.count)} · 新增 Agent ${number(createdAgents.count)}</h4>${dailyItemsMarkup(createdSkills.items, capabilityMarkup, '今日没有新增 Skill。', 2)}${dailyItemsMarkup(createdAgents.items, capabilityMarkup, '今日没有新增 Agent。', 2)}</div>
        <div class="daily-capability-group"><h4>今日发布 Skill ${number(publishedSkills.count)}</h4>${dailyItemsMarkup(publishedSkills.items, capabilityMarkup, '今日没有发布既有 Skill。', 2)}</div>
      </article>
    </div>
    <p class="daily-method-note">完成口径：${escapeHtml(completed.note ?? '等待状态迁移记录。')} 返工口径：${escapeHtml(rework.note ?? '等待 Run 节点记录。')}</p>`;
}

const trendMetrics = {
  score: { label: '健康指数', unit: '分（0–100）', value: (point) => point.score ?? 0 },
  blockedIssues: { label: '阻塞生产线', unit: '个（Issue=blocked）', value: (point) => point.blockedIssues ?? 0 },
  warningCount: { label: '非阻塞风险事件', unit: '条（推进＋执行＋Skill／服务／治理）', value: (point) => point.warningCount ?? 0 }
};

const trendRangeLabels = { 6: '近 6 小时', 24: '近 24 小时', 168: '近 7 天' };

function trendTime(value, compact = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(compact ? { hourCycle: 'h23' } : {})
  });
}

function trendValue(value, metric) {
  return metric === 'score' ? `${number(value)} 分` : `${number(value)} 个`;
}

function trendYMaximum(metric, values) {
  if (metric === 'score') return 100;
  const max = Math.max(1, ...values);
  return Math.max(5, Math.ceil(max / 5) * 5);
}

function trendChartMarkup(points, metric) {
  const definition = trendMetrics[metric];
  const values = points.map((point) => definition.value(point));
  const width = 760;
  const height = 248;
  const left = 46;
  const right = 18;
  const top = 18;
  const bottom = 34;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const yMax = trendYMaximum(metric, values);
  const start = Date.parse(points[0].collectedAt);
  const end = Date.parse(points.at(-1).collectedAt);
  const timeSpan = Math.max(1, end - start);
  const x = (point, index) => points.length === 1 ? left + chartWidth / 2 : left + (Date.parse(point.collectedAt) - start) / timeSpan * chartWidth;
  const y = (value) => top + chartHeight - value / yMax * chartHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => Math.round(yMax / 4 * index));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(point, index).toFixed(1)},${y(values[index]).toFixed(1)}`).join(' ');
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const latestIndex = points.length - 1;
  const latestX = x(points[latestIndex], latestIndex);
  const latestY = y(values[latestIndex]);
  const latestLabelOnLeft = latestX > width - 120;
  const latestLabelX = latestLabelOnLeft ? latestX - 8 : latestX + 10;
  return `<svg class="trend-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-svg-title trend-svg-description"><title id="trend-svg-title">${escapeHtml(definition.label)}趋势</title><desc id="trend-svg-description">${escapeHtml(`按 ${state.trend?.bucketMinutes ?? 0} 分钟时间桶展示 ${points.length} 个历史点；当前值 ${trendValue(values[latestIndex], metric)}。`)}</desc><g class="trend-grid">${ticks.map((tick) => `<line x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"></line><text x="${left - 9}" y="${y(tick) + 4}" text-anchor="end">${number(tick)}</text>`).join('')}</g><path class="trend-line" d="${line}"></path>${points.map((point, index) => `<circle class="trend-point ${index === latestIndex ? 'latest' : ''}" cx="${x(point, index)}" cy="${y(values[index])}" r="${index === latestIndex ? 4.5 : 2.5}"><title>${escapeHtml(`${trendTime(point.collectedAt)}：${trendValue(values[index], metric)}`)}</title></circle>`).join('')}<text class="trend-latest-value" x="${latestLabelX}" y="${Math.max(14, latestY - 10)}" text-anchor="${latestLabelOnLeft ? 'end' : 'start'}">${escapeHtml(trendValue(values[latestIndex], metric))}</text><g class="trend-axis">${labelIndexes.map((index) => `<text x="${x(points[index], index)}" y="${height - 10}" text-anchor="${index === 0 ? 'start' : index === latestIndex ? 'end' : 'middle'}">${escapeHtml(trendTime(points[index].collectedAt, true))}</text>`).join('')}</g></svg>`;
}

function trendControlsMarkup() {
  return `<div class="trend-control-group"><span>时间窗</span>${[[24, '近 24 小时'], [168, '近 7 天']].map(([value, label]) => `<button class="filter-button ${state.trendRange === value ? 'selected' : ''}" type="button" data-action="set-trend-range" data-value="${value}" aria-pressed="${state.trendRange === value}">${label}</button>`).join('')}</div><div class="trend-control-group"><span>指标</span>${Object.entries(trendMetrics).map(([value, definition]) => `<button class="filter-button ${state.trendMetric === value ? 'selected' : ''}" type="button" data-action="set-trend-metric" data-value="${value}" aria-pressed="${state.trendMetric === value}">${definition.label}</button>`).join('')}</div>`;
}

function renderTrend() {
  const container = $('#trend-chart');
  if (!container) return;
  $('#trend-controls').innerHTML = trendControlsMarkup();
  if (!state.trend) {
    $('#trend-caption').textContent = '正在读取独立趋势指标…';
    return;
  }
  const { points = [], coverage, sourceSnapshots = 0, bucketMinutes = 0 } = state.trend;
  const definition = trendMetrics[state.trendMetric];
  const label = trendRangeLabels[state.trendRange];
  $('#trend-caption').textContent = coverage
    ? `${label}内已覆盖 ${coverage.observedHours} 小时 · ${number(sourceSnapshots)} 条轻量趋势指标按 ${bucketMinutes} 分钟聚合`
    : `${label}内尚未有可用轻量趋势指标`;
  container.classList.remove('skeleton');
  if (!points.length) {
    container.innerHTML = '<div class="empty">尚无可用趋势指标；请点击“立即采集”。</div>';
    return;
  }
  if (points.length < 2) {
    const latest = points[0];
    container.innerHTML = `<div class="trend-chart-heading"><div><h3>${escapeHtml(definition.label)}</h3><p>已读取当前云端采集点；下一时间桶采集后将绘制曲线。</p></div><strong>${trendValue(definition.value(latest), state.trendMetric)}</strong></div><div class="trend-summary"><span>健康指数：<strong>${trendValue(latest.score, 'score')}</strong></span><span>生产阻塞：<strong>${trendValue(latest.blockedIssues, 'blockedIssues')}</strong></span><span>非阻塞风险：<strong>${trendValue(latest.warningCount, 'warningCount')}</strong></span></div><p class="note">当前 ${number(sourceSnapshots)} 次采集被聚合为 1 个 ${bucketMinutes} 分钟时间桶；保留真实当前值，不以 0 补位。</p>`;
    return;
  }
  const values = points.map((point) => definition.value(point));
  const first = values[0];
  const latest = values.at(-1);
  const change = latest - first;
  const changePrefix = change > 0 ? '+' : '';
  container.innerHTML = `<div class="trend-chart-heading"><div><h3>${escapeHtml(definition.label)}</h3><p>${escapeHtml(`${definition.unit} · 每个时间桶取最后一次成功采集快照`)}</p></div><strong>${trendValue(latest, state.trendMetric)}</strong></div>${trendChartMarkup(points, state.trendMetric)}<div class="trend-summary"><span>窗口起点：<strong>${trendValue(first, state.trendMetric)}</strong></span><span>窗口变化：<strong>${changePrefix}${trendValue(change, state.trendMetric)}</strong></span><span>图中数据点：<strong>${number(points.length)}</strong></span></div><details class="trend-table"><summary>查看 ${number(points.length)} 个聚合数据点</summary><div class="table-wrap"><table><thead><tr><th>时间</th><th>健康指数</th><th>生产阻塞</th><th>非阻塞风险</th><th>桶内采集</th></tr></thead><tbody>${points.map((point) => `<tr><td>${escapeHtml(trendTime(point.collectedAt))}</td><td>${number(point.score)}</td><td>${number(point.blockedIssues)}</td><td>${number(point.warningCount)}</td><td>${number(point.sampleCount)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

function issueStatusMarkup(snapshot) {
  const entries = Object.entries(snapshot.production.issueStatusCounts).sort((left, right) => right[1] - left[1]);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return `<div class="bar-list">${entries.map(([status, count]) => `<div class="bar-row"><span>${escapeHtml(status || 'unknown')}</span><div class="bar-track"><div class="bar-fill ${status === 'blocked' ? 'critical' : status === 'in_review' ? 'warning' : ''}" style="width:${Math.max(4, count / max * 100)}%"></div></div><strong>${number(count)}</strong></div>`).join('')}</div>`;
}

function onePassIssuesMarkup(snapshot) {
  const line = snapshot.production.linePerformance ?? {};
  const issues = line.onePassIssues ?? [];
  if (!issues.length) return '<div class="empty">当前采集范围内没有符合一次性跑通口径的生产 Issue。</div>';
  return `<div class="table-wrap"><table class="health-table one-pass-table"><thead><tr><th>Issue</th><th>生产单标题</th><th>完成时间</th><th>生产时长</th><th>判定</th></tr></thead><tbody>${issues.map((issue) => `<tr><td><a class="issue-link" target="_blank" rel="noreferrer" href="https://agent.new.ndhy.com/rpg2/issues/${encodeURIComponent(issue.id)}">${escapeHtml(issue.identifier)} ↗</a></td><td>${escapeHtml(issue.title)}</td><td>${issue.completedAt ? time(issue.completedAt) : '完成时间未采集'}</td><td>${escapeHtml(issue.durationLabel ?? '时长未采集')}</td><td><span class="one-pass-status">有成功 Run、无阻断完成</span></td></tr>`).join('')}</tbody></table></div>`;
}

function productionStatusMarkup(snapshot) {
  const stages = snapshot.production.stages.slice(0, 6);
  const line = snapshot.production.linePerformance ?? {};
  const scope = snapshot.workspace.scope;
  const scopeLabel = scope?.squadName ? `统计范围：仅直接指派给「${scope.squadName}」的生产 Issue。` : '统计范围：当前采集范围内的生产 Issue。';
  const onePassAvailable = line.metricStatus?.onePass === 'computed';
  const blockAverageAvailable = line.metricStatus?.blockAverage === 'computed';
  const durationAvailable = line.metricStatus?.duration === 'computed';
  const onePassValue = onePassAvailable ? percent(line.onePassRate) : '无法计算';
  const averageBlocksValue = blockAverageAvailable ? `${decimal(line.averageBlockOccurrences)} 次` : '无法计算';
  const durationValue = durationAvailable ? (line.averageDurationLabel ?? '样本不足') : '无法计算';
  const calculationNote = `${line.calculationEvidence ?? ''} ${line.historyEvidence?.detail ?? ''}`.trim();
  return `
    <div class="subsection line-performance"><p class="subheading">生产线跑通表现 <span>终态生产线口径</span></p><div class="line-kpi-grid"><div class="line-kpi healthy"><span>一次性跑通概率</span><strong>${onePassValue}</strong><small>done Issue 中有 completed Run，且全程无阻断、无超过 ${number(line.nodeStallHours ?? 4)} 小时无推进 · ${number(line.onePassCount)}/${number(line.onePassDenominator)} 条</small></div><div class="line-kpi warning"><span>平均生产线阻断次数</span><strong>${averageBlocksValue}</strong><small>全部终态 Issue · ${number(line.terminalBlockOccurrences)}/${number(line.blockDenominator)} 条</small></div><div class="line-kpi"><span>成功生产平均时长</span><strong>${escapeHtml(durationValue)}</strong><small>全部完成 Issue · ${number(line.durationSampleCount)}/${number(line.durationDenominator)} 条有完整 Run 时长</small></div></div><p class="line-kpi-note">${escapeHtml(scopeLabel)} ${escapeHtml(calculationNote)} ${!onePassAvailable || !blockAverageAvailable || !durationAvailable ? '每项指标按自身证据覆盖独立显示；未补齐的指标不会遮蔽已计算的指标。' : `口径：终态生产线 = done ${number(line.completedIssueCount)} + cancelled ${number(line.cancelledIssueCount)} = ${number(line.terminalIssueCount)}；一次性跑通率仅以 done ${number(line.onePassDenominator)} 为分母（其中 ${number(line.completedRunBackedIssueCount)} 条有成功完成 Run）；平均阻断次数以全部终态 ${number(line.blockDenominator)} 为分母；成功平均时长以全部 done ${number(line.durationDenominator)} 为样本。`}</p></div>
    <div class="subsection"><p class="subheading">Run 心跳阶段</p><div class="stage-list">${stages.length ? stages.map((stage) => `<div class="stage-row"><span>${escapeHtml(stage.stage)}</span><strong>${number(stage.total)} <em>${number(stage.failed)} 失败</em></strong></div>`).join('') : '<div class="empty">当前采集范围没有标注 Run 阶段。</div>'}</div></div>`;
}

function reviewQueueMarkup(snapshot) {
  return `<div id="review-queue" class="review-queue"><p class="subheading">审核中队列 <span>非风险</span></p><p class="queue-note">${number(snapshot.production.reviewCount ?? 0)} 个 Issue 正在审核；它们会独立展示，不触发“无推进”或“生产阻塞”告警。点击任一条可查看执行汇总与 Multica Issue。</p><div class="stage-list">${(snapshot.production.reviewIssues ?? []).length ? snapshot.production.reviewIssues.slice(0, 5).map((issue) => `<button class="stage-row review-issue-link" type="button" data-action="open-issue" data-issue-id="${escapeHtml(issue.id)}" aria-label="查看 ${escapeHtml(issue.identifier ?? issue.id)} 的审核详情"><span title="${escapeHtml(issue.title)}">${escapeHtml(issue.identifier ?? issue.id)} · ${escapeHtml(issue.title)}</span><strong>${time(issue.updatedAt)} <em>查看详情 →</em></strong></button>`).join('') : '<div class="empty">当前没有审核中 Issue。</div>'}</div></div>`;
}

function renderProduction(snapshot) {
  $('#production').classList.remove('skeleton');
  $('#production').innerHTML = `${productionStatusMarkup(snapshot)}<div class="subsection"><p class="subheading">Issue 状态分布</p>${issueStatusMarkup(snapshot)}</div><div class="subsection">${reviewQueueMarkup(snapshot)}</div>`;
}

function renderProductionOverview(snapshot) {
  $('#overview-production').classList.remove('skeleton');
  $('#overview-production').innerHTML = productionStatusMarkup(snapshot);
}

function renderIssueStatusPanel(snapshot) {
  const counts = snapshot.production.issueStatusCounts ?? {};
  const total = Number(snapshot.production.productionIssueCount ?? Object.values(counts).reduce((sum, value) => sum + Number(value ?? 0), 0));
  const blocked = number(counts.blocked);
  $('#production-issue-status').classList.remove('skeleton');
  $('#production-issue-status').innerHTML = `${issueStatusMarkup(snapshot)}<p class="issue-status-reconcile">仅统计直接指派给「${escapeHtml(snapshot.workspace.scope?.squadName ?? 'RPG互动教育游戏颗粒生产小队')}」的 <strong>${number(total)}</strong> 条生产 Issue；其中 <strong>${blocked}</strong> 条为 blocked，与概览页“生产阻塞”一致。</p>`;
}

function renderOnePassIssues(snapshot) {
  const line = snapshot.production.linePerformance ?? {};
  const issues = line.onePassIssues ?? [];
  $('#production-one-pass-caption').textContent = `${number(issues.length)} 条；与“一次性跑通概率”的分子完全一致，明细默认收起。`;
  $('#production-one-pass-issues').classList.remove('skeleton');
  $('#production-one-pass-issues').innerHTML = `<details class="one-pass-details"><summary><span>查看一次性跑通 Issue 明细</span><small>${number(issues.length)} 条</small></summary>${onePassIssuesMarkup(snapshot)}</details>`;
}

function reworkAgentLabel(node) {
  return Array.isArray(node.agentNames) && node.agentNames.length ? node.agentNames.join('、') : '未采集 Agent 名称';
}

function reworkIssueAnalysisMarkup(snapshot) {
  const rework = snapshot.daily?.reworkIssues ?? { items: [] };
  if (!rework.items.length) return `<div class="empty">${escapeHtml(rework.analysisEvidence?.detail ?? '当前采集范围内没有同一 Issue 的同一具体生产节点被重复激活或执行至少 3 次的情况。')}</div>`;
  return `<div class="rework-analysis-list">${rework.items.map((issue) => `<article class="rework-analysis-card"><header><div><p class="rework-issue-id">${escapeHtml(issue.identifier ?? issue.issueId ?? '未识别 Issue')}</p><h3>${escapeHtml(issue.title ?? '未采集标题')}</h3></div></header><p class="rework-issue-summary">该 Issue 识别到 <strong>${number(issue.reworkNodeCount ?? issue.reworkNodes?.length ?? 0)}</strong> 个重复执行节点；每个节点的返工次数和原因如下。</p><div class="rework-node-list">${(issue.reworkNodes ?? []).map((node) => `<section class="rework-node-card"><div class="rework-node-heading"><div><span>返工节点</span><strong>${escapeHtml(node.node)}</strong></div><b>${number(node.taskCount)} 次</b></div><dl><div><dt>执行 Agent</dt><dd>${escapeHtml(reworkAgentLabel(node))}</dd></div><div><dt>Run 状态</dt><dd>${escapeHtml(node.statusSummary)}</dd></div></dl><div class="rework-reason"><span>返工原因 · ${escapeHtml(node.reasonSource ?? '原因未采集')}</span><p>${escapeHtml(node.reason)}</p></div></section>`).join('')}</div></article>`).join('')}</div>`;
}

function reworkCauseLabel(node) {
  return `${node.reasonType ?? '返工触发原因未采集'} · ${node.reasonConfidence ?? '证据不足'}`;
}

function reworkIssueCardsMarkup(snapshot) {
  const rework = snapshot.daily?.reworkIssues ?? { items: [] };
  if (!rework.items.length) return `<div class="empty">${escapeHtml(rework.analysisEvidence?.detail ?? '当前采集范围内没有满足返工识别口径的 Issue。')}</div>`;
  return `<div class="rework-issue-grid">${rework.items.map((issue) => {
    const primary = issue.reworkNodes?.[0];
    return `<article class="rework-issue-box"><p class="rework-issue-id">${escapeHtml(issue.identifier ?? issue.issueId ?? '未识别 Issue')}</p><h3>${escapeHtml(issue.title ?? '未采集标题')}</h3><p class="rework-box-count"><strong>${number(issue.reworkNodeCount ?? issue.reworkNodes?.length ?? 0)}</strong> 个返工节点</p>${primary ? `<p class="rework-box-signal"><span>${escapeHtml(primary.node)}</span><b>${escapeHtml(primary.reasonType ?? '返工触发原因未采集')}</b></p>` : ''}<button class="button secondary rework-detail-button" type="button" data-action="open-rework-issue" data-issue-id="${escapeHtml(issue.issueId ?? '')}">查看节点返工分析</button></article>`;
  }).join('')}</div>`;
}

function reworkNodeDetailMarkup(node) {
  const fullEvidence = node.reasonEvidence
    ? `<details class="rework-evidence"><summary>查看完整归因依据 · ${escapeHtml(node.reasonSource ?? '未采集来源')}</summary><pre>${escapeHtml(node.reasonEvidence)}</pre></details>`
    : '<p class="rework-evidence-gap">未采集到可引用的原始原因文本；仅确认该节点发生了重复执行。</p>';
  return `<article class="rework-node-card"><div class="rework-node-heading"><div><span>返工节点</span><strong>${escapeHtml(node.node)}</strong></div><b>${number(node.taskCount)} 次</b></div><dl><div><dt>执行 Agent</dt><dd>${escapeHtml(reworkAgentLabel(node))}</dd></div><div><dt>Run 状态</dt><dd>${escapeHtml(node.statusSummary)}</dd></div><div><dt>归因类型</dt><dd>${escapeHtml(reworkCauseLabel(node))}</dd></div></dl><div class="rework-reason"><span>返工原因</span><p>${escapeHtml(node.reason)}</p></div><div class="rework-evidence-excerpt"><span>依据摘要 · ${escapeHtml(node.reasonSource ?? '未采集来源')}</span><p>${escapeHtml(node.reasonEvidenceExcerpt || '未采集到原始归因依据。')}</p></div>${fullEvidence}</article>`;
}

function reworkIssueDetailMarkup(issue) {
  const nodes = issue.reworkNodes ?? [];
  return `<p class="eyebrow">返工分析</p><h2>${escapeHtml(issue.identifier ?? issue.issueId)} · ${escapeHtml(issue.title ?? '未采集标题')}</h2><p class="detail-lead">按 <strong>Issue → 具体产出节点</strong> 汇总，识别节点被重复激活或执行的位置；不同小队 Agent 的执行会合并。项目经理路由、协调、验收、等待与纯下游消费不进入返工统计。</p><div class="detail-kpis"><span>返工节点<strong>${number(issue.reworkNodeCount ?? nodes.length)}</strong></span><span>纳入 Run<strong>${number(nodes.reduce((sum, node) => sum + Number(node.taskCount ?? 0), 0))}</strong></span><span>分析依据<strong>Issue、Run 与运行消息</strong></span></div><section class="rework-detail-node-list">${nodes.map(reworkNodeDetailMarkup).join('')}</section><p class="note">检测台仅保留返工结论与归因依据；完整执行日志请在 Multica Issue 中查看。</p>`;
}

async function openReworkIssue(issueId) {
  if (!issueId) return;
  openDialog('<p class="note">正在按需读取该 Issue 的完整返工证据…</p>');
  try {
    const response = await fetch(apiUrl(`rework-issue?id=${encodeURIComponent(issueId)}`));
    const data = await response.json();
    if (!response.ok || !data.item) throw new Error(apiErrorMessage(data) || '读取返工分析失败');
    openDialog(reworkIssueDetailMarkup(data.item));
  } catch (error) {
    openDialog(`<p class="eyebrow">返工分析</p><h2>读取失败</h2><p class="detail-lead">${escapeHtml(error.message)}</p>`);
  }
}

function renderProductionReworkIssues(snapshot) {
  const rework = snapshot.daily?.reworkIssues ?? { count: 0, items: [], threshold: 3 };
  $('#production-rework-caption').textContent = `${number(rework.count)} 个多次返工 Issue；${rework.analysisEvidence?.detail ?? '仅统计带具体产出标识的生产执行 Run，路由、验收与等待不纳入。'}`;
  $('#production-rework-issues').classList.remove('skeleton');
  $('#production-rework-issues').innerHTML = reworkIssueCardsMarkup(snapshot);
}

function renderMeasurementRules(rules) {
  const target = $('#measurement-rules');
  if (!target) return;
  $('#rules-caption').textContent = `规则库版本 ${rules.version} · ${rules.source}`;
  target.classList.remove('skeleton');
  target.innerHTML = `<div class="rules-sections">${rules.sections.map((section) => `<section class="rules-section"><h3>${escapeHtml(section.title)}</h3><div class="rules-table-wrap"><table class="rules-table"><thead><tr><th>规则</th><th>定义/计算</th><th>证据来源</th><th>限制与说明</th></tr></thead><tbody>${section.rules.map((rule) => `<tr><th>${escapeHtml(rule.name)}</th><td>${escapeHtml(rule.definition)}</td><td>${escapeHtml(rule.source)}</td><td>${escapeHtml(rule.caveat)}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}</div>`;
}

async function loadMeasurementRules() {
  if (!$('#measurement-rules')) return;
  try {
    const response = await fetch(apiUrl('measurement-rules'));
    const data = await response.json();
    if (!response.ok || !data.rules) throw new Error(apiErrorMessage(data) || '规则库读取失败');
    renderMeasurementRules(data.rules);
  } catch (error) {
    $('#measurement-rules').classList.remove('skeleton');
    $('#measurement-rules').innerHTML = `<div class="empty">无法读取度量规则：${escapeHtml(error.message)}</div>`;
  }
}

const schemeKindMeta = {
  core: { label: '核心互动', className: 'core' },
  carrier: { label: '承载型', className: 'carrier' },
  closing: { label: '收尾', className: 'closing' }
};

function schemeUsageMap(usage) {
  const byId = new Map();
  for (const scheme of usage?.schemes ?? []) byId.set(scheme.id, scheme);
  return byId;
}

function renderSchemes(data) {
  const target = $('#schemes-content');
  if (!target) return;
  target.classList.remove('skeleton');
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  const usage = data.usage;
  const byId = schemeUsageMap(usage);
  const totalUseCount = usage?.totalUseCount ?? (usage?.schemes ?? []).reduce((total, scheme) => total + (scheme.useCount ?? 0), 0);
  const totalIssueCoverage = usage?.totalIssueCoverage ?? (usage?.schemes ?? []).reduce((total, scheme) => total + (scheme.issueCount ?? scheme.issues?.length ?? 0), 0);
  const usedCount = catalog.filter((scheme) => (byId.get(scheme.id)?.issueCount ?? byId.get(scheme.id)?.issues?.length ?? 0) > 0).length;
  $('#schemes-caption').textContent = usage
    ? `最近汇总 ${time(usage.generatedAt)} · 分析 ${number(usage.issuesAnalysed)} 条完成 Issue · 使用次数不去重，覆盖颗粒数按 Issue 去重 · ${usedCount}/${catalog.length} 种方案被使用`
    : '尚未生成互动方案使用汇总；点击“立即采集”完成一次云端同步后自动分析。';
  const kindGroups = (kind) => catalog.filter((scheme) => scheme.kind === kind);
  const kindSection = (kind) => {
    const rows = kindGroups(kind);
    if (!rows.length) return '';
    const title = schemeKindMeta[kind]?.label ?? kind;
    const body = rows.map((scheme) => {
      const used = byId.get(scheme.id);
      const useCount = used?.useCount ?? 0;
      const issueCount = used?.issueCount ?? used?.issues?.length ?? 0;
      const issues = used?.issues ?? [];
      const issueTags = issueCount
        ? `<span class="scheme-issues">${issues.map((identifier) => `<span class="issue-tag">${escapeHtml(identifier)}</span>`).join('')}</span>`
        : '<span class="scheme-unused">未使用</span>';
      return `<tr class="scheme-row ${issueCount ? '' : 'scheme-row-muted'}">
        <td class="scheme-id-cell"><code>${escapeHtml(scheme.id)}</code></td>
        <td>${escapeHtml(scheme.name)}</td>
        <td>${escapeHtml(scheme.nameEn)}</td>
        <td class="scheme-count-cell"><strong>${number(useCount)}</strong></td>
        <td class="scheme-count-cell"><strong>${number(issueCount)}</strong></td>
        <td class="scheme-issues-cell">${issueTags}</td>
      </tr>`;
    }).join('');
    return `<section class="scheme-kind-section"><h3 class="scheme-kind-title">${escapeHtml(title)}（${rows.length}）</h3><div class="scheme-table-wrap"><table class="scheme-table"><thead><tr><th>方案 ID</th><th>中文名</th><th>英文名</th><th>使用次数（不去重）</th><th>覆盖颗粒数（去重）</th><th>涉及 Issue</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  };
  target.innerHTML = `<div class="scheme-summary">
    <div class="scheme-summary-item"><strong>${number(catalog.length)}</strong><span>方案总数</span></div>
    <div class="scheme-summary-item"><strong>${number(usedCount)}</strong><span>已使用方案</span></div>
    <div class="scheme-summary-item"><strong>${number(usage?.issuesAnalysed ?? 0)}</strong><span>已分析 Issue</span></div>
    <div class="scheme-summary-item"><strong>${number((usage?.schemes ?? []).length)}</strong><span>使用记录方案</span></div>
    <div class="scheme-summary-item"><strong>${number(totalUseCount)}</strong><span>方案使用次数（不去重）</span></div>
    <div class="scheme-summary-item"><strong>${number(totalIssueCoverage)}</strong><span>方案覆盖颗粒累计（去重）</span></div>
  </div>${['core', 'carrier', 'closing'].map(kindSection).join('')}`;
}

async function loadSchemes() {
  if (!$('#schemes-content')) return;
  try {
    const response = await fetch(apiUrl('schemes'));
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data) || '互动方案汇总读取失败');
    renderSchemes(data);
  } catch (error) {
    $('#schemes-content').classList.remove('skeleton');
    $('#schemes-content').innerHTML = `<div class="empty">无法读取互动方案汇总：${escapeHtml(error.message)}</div>`;
  }
}

function renderReviewQueue(snapshot) {
  $('#production-review').classList.remove('skeleton');
  $('#production-review').innerHTML = reviewQueueMarkup(snapshot);
}

function renderServices(snapshot) {
  $('#services').classList.remove('skeleton');
  $('#services').innerHTML = snapshot.services.map((service) => `<div class="service-row"><div><i class="status-dot ${statusClass(service.status)}"></i><strong>${escapeHtml(service.serviceName)}</strong><p>${escapeHtml(service.detail || '未提供探针说明')}</p></div><span>${statusLabel(service.status)}${service.latencyMs != null ? ` · ${service.latencyMs}ms` : ''}</span></div>`).join('') || '<div class="empty">尚未登记服务探针。</div>';
}

const executionIncidentKinds = new Set(['task_failure', 'retry_loop', 'task_timeout']);
const riskCategoryMeta = {
  critical: {
    label: '生产阻塞（重要风险）',
    rule: 'Issue status = blocked',
    object: '检测对象：生产 Issue',
    detail: '已明确阻塞生产；需要基于执行链证据确认恢复条件。',
    scoreEffect: '健康指数：每条 −8 分，合计最多 −70'
  },
  progress: {
    label: '长期无推进（推进风险）',
    rule: '非 blocked 的生产 Issue 长期无推进',
    object: '检测对象：生产 Issue',
    detail: '提示推进偏慢，不等同于生产已阻塞；审核中不进入该分类。',
    scoreEffect: '健康指数：每条 −2 分，计入非阻塞风险合计上限 −20'
  },
  execution: {
    label: '执行异常（非阻塞风险）',
    rule: '近 24h：failed/error、运行中 Run 心跳超过 2 小时，或同 Issue/Agent/错误指纹失败 ≥3 次',
    object: '检测对象：Task / Agent',
    detail: '是运行信号，需关联 Issue 与日志后才可判断业务影响。',
    scoreEffect: '健康指数：每条 −2 分，计入非阻塞风险合计上限 −20'
  },
  warning: {
    label: 'Skill／服务／治理风险（非阻塞）',
    rule: '有显式调用证据的 Skill 仅草稿未发布，或服务探针非 healthy；Darwin 对标仅展示，不直接入队',
    object: '检测对象：Skill / 基础服务 / 治理状态',
    detail: '需要治理或排查，但不自动判定为生产阻塞。',
    scoreEffect: '健康指数：每条 −2 分，计入非阻塞风险合计上限 −20'
  }
};

function incidentCategory(incident) {
  if (incident.kind === 'production_blocked') return 'critical';
  if (incident.kind === 'no_progress') return 'progress';
  if (executionIncidentKinds.has(incident.kind)) return 'execution';
  return 'warning';
}

function incidentMatches(incident, filter) {
  return filter === 'all' || incidentCategory(incident) === filter;
}

function repairPreviewMarkup(analysis) {
  if (analysis?.schema !== 'rpg-blocker-evidence/v1') return '';
  const plan = analysis.recoveryPlan ?? [];
  const diagnosis = analysis.diagnosis;
  const step = plan[0];
  if (!step && !diagnosis) return '';
  return `<span class="incident-repair">${diagnosis ? `<b>卡点：${escapeHtml(diagnosis.node)}</b><span>${escapeHtml(diagnosis.cause)}</span>` : ''}${step ? `<small>建议动作：${escapeHtml(step.action)}</small>` : ''}</span>`;
}

function renderRiskDefinitions(snapshot) {
  const score = healthScoreBreakdown(snapshot);
  $('#risk-definitions').innerHTML = `<p class="risk-definition-note">计分单位是“风险事件”而非 Issue 或 Skill 数量：同一事件只会进入一个主队列；“全部”仅用于汇总查看。审核中属于独立运营状态，不进入风险队列，也不计入健康指数。本轮：${number(score.criticalCount)} 条生产阻塞扣 −${number(score.criticalPenalty)}；${number(score.warningCount)} 条非阻塞风险扣 −${number(score.warningPenalty)}。</p><div class="risk-definition-grid">${Object.entries(riskCategoryMeta).map(([key, meta]) => `<article class="risk-definition ${key}"><div><strong>${meta.label}</strong><span>${meta.object} · 当前 ${number(score.categories[key])} 条</span></div><p>${meta.detail}</p><small>判定：${meta.rule}</small><small>${meta.scoreEffect}</small></article>`).join('')}</div>`;
}

function renderIncidents(snapshot) {
  renderRiskDefinitions(snapshot);
  const filtered = snapshot.incidents.filter((item) => incidentMatches(item, state.incidentFilter));
  const visible = filtered.slice(0, state.incidentLimit);
  const labels = { critical: '生产阻塞（重要风险）', warning: 'Skill／服务／治理风险', execution: '执行异常', progress: '长期无推进（推进风险）', all: '全部风险事件' };
  $('#incident-caption').textContent = `${labels[state.incidentFilter]} ${number(filtered.length)} 条；默认展示最优先的 ${Math.min(state.incidentLimit, filtered.length)} 条。`;
  $('#incident-filters').innerHTML = [
    ['critical', '生产阻塞（重要）'], ['progress', '长期无推进'], ['execution', '执行异常'], ['warning', 'Skill／服务／治理'], ['all', '全部事件']
  ].map(([value, label]) => filterButton('incident', value, label, state.incidentFilter)).join('');
  $('#incidents').classList.remove('skeleton');
  $('#incidents').innerHTML = visible.length ? `${visible.map((incident) => {
    const category = incidentCategory(incident);
    const repair = category === 'critical' ? repairPreviewMarkup(incident.analysis) : '';
    const openLabel = repair ? '查看完整诊断与修复方案 →' : '查看证据 →';
    return `<button class="incident ${category}" type="button" data-action="open-incident" data-incident-id="${escapeHtml(incident.id)}" data-issue-id="${escapeHtml(incident.issue?.id ?? '')}"><span class="incident-marker"></span><span class="incident-body"><span class="incident-title-row"><b>${escapeHtml(incident.title)}</b><em>${riskCategoryMeta[category].label}</em></span><p>${escapeHtml(incident.detail)}</p>${repair}<small>${escapeHtml(incident.issue?.identifier ?? incident.skill?.name ?? incident.kind)}${incident.agent?.name ? ` · ${escapeHtml(incident.agent.name)}` : ''}</small></span><span class="incident-open">${openLabel}</span></button>`;
  }).join('')}${showMoreButton('incidents', visible.length, filtered.length)}` : $('#empty-template').innerHTML;
}

function agentMatches(agent, filter) {
  if (filter === 'all') return true;
  if (filter === 'critical') return agent.status === 'critical';
  return agent.status !== 'healthy';
}

function renderAgents(snapshot) {
  const filtered = snapshot.agents.filter((agent) => agentMatches(agent, state.agentFilter));
  const visible = filtered.slice(0, state.agentLimit);
  $('#agent-count').textContent = `${number(filtered.length)} / ${number(snapshot.agents.length)} 个对象`;
  $('#agent-filters').innerHTML = [
    ['attention', '需关注'], ['critical', '仅异常'], ['all', '全部 Agent']
  ].map(([value, label]) => filterButton('agent', value, label, state.agentFilter)).join('');
  $('#agents').classList.remove('skeleton');
  $('#agents').innerHTML = visible.length ? `<table class="health-table"><thead><tr><th>Agent</th><th>健康度</th><th>异常说明</th><th>运行可靠性</th><th>推进风险</th></tr></thead><tbody>${visible.map((agent) => { const windowLabel = `近 ${number(agent.analysisWindowHours ?? 24)}h`; return `<tr><td><button class="entity-link" type="button" data-action="open-agent" data-agent-id="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</button><span class="cell-note">${escapeHtml(agent.model)} · ${number(agent.skillCount)} 个绑定 Skill</span></td><td><span class="status-line"><i class="status-dot ${statusClass(agent.status)}"></i>${statusLabel(agent.status)}</span><span class="score-stack">${scoreCell(agent.score, agent.confidence)}</span></td><td><p class="cell-reason">${escapeHtml(agent.anomalySummary ?? '暂无可解释异常。')}</p><button class="inline-detail" type="button" data-action="open-agent" data-agent-id="${escapeHtml(agent.id)}">查看详细分析 →</button></td><td>${agent.reliability == null ? `<span class="cell-note">无${escapeHtml(windowLabel)}终态 Run</span>` : `<strong>${agent.reliability}%</strong><span class="cell-note">${number(agent.recentRuns)} 个${escapeHtml(windowLabel)} Run</span>`}</td><td><strong class="${agent.progressRiskCount ? 'risk-number' : ''}">${number(agent.progressRiskCount)}</strong><span class="cell-note">${number(agent.directIssueCount)} 个直接负责 Issue</span></td></tr>`; }).join('')}</tbody></table>${showMoreButton('agents', visible.length, filtered.length)}` : $('#empty-template').innerHTML;
}

function skillMatches(skill, filter) {
  if (filter === 'all') return true;
  if (filter === 'recent-production') return skill.observedCalls > 0;
  if (filter === 'unpublished') return !skill.publishedAt;
  if (filter === 'unevaluated') return !skill.regression;
  if (filter === 'not-audited') return !skill.darwin;
  if (filter === 'needs-test') return !skill.darwin || skill.darwin.dimensions.some((item) => item.key === 'performance' && item.score == null);
  if (filter === 'runtime-risk') return skill.observedCalls > 0 && skill.runtimeSuccessRate !== null && skill.runtimeSuccessRate < 100;
  return skill.status !== 'healthy' || skill.darwin?.runtimeGate?.status === 'review' || skill.darwin?.dimensions.some((item) => item.score != null && item.score < 60);
}

function renderSkills(snapshot) {
  const { skills } = snapshot;
  const assessments = skills.assessments || [];
  const filtered = assessments.filter((skill) => skillMatches(skill, state.skillFilter));
  const visible = filtered
    .sort((left, right) => Number(right.observedCalls ?? 0) - Number(left.observedCalls ?? 0) || left.name.localeCompare(right.name, 'zh-CN'))
    .slice(0, state.skillLimit);
  const performanceScope = skills.performanceScope;
  const performanceEvaluation = skills.performanceEvaluation ?? {};
  const analysisEvidence = skills.analysisEvidence;
  const calledSkills = assessments.filter((skill) => skill.observedCalls > 0);
  const calledTerminalRuns = calledSkills.reduce((total, skill) => total + Number(skill.productionPerformance?.terminalCalls ?? 0), 0);
  const calledSuccessfulRuns = calledSkills.reduce((total, skill) => total + Number(skill.productionPerformance?.successCalls ?? 0), 0);
  const calledFailedRuns = calledSkills.reduce((total, skill) => total + Number(skill.productionPerformance?.failedCalls ?? 0), 0);
  const calledTimeoutRuns = calledSkills.reduce((total, skill) => total + Number(skill.productionPerformance?.timeoutCalls ?? 0), 0);
  const runtimeRiskSkills = calledSkills.filter((skill) => skill.runtimeSuccessRate != null && skill.runtimeSuccessRate < 100);
  const allSquadSkillScope = performanceScope?.timeRange === 'all_retained_history';
  const performanceScopeNote = performanceScope
    ? allSquadSkillScope
      ? `默认清单仅包含 ${number(calledSkills.length)} 个有显式调用证据的 Skill；小队 Agent 共绑定 ${number(skills.total ?? 0)} 个 Skill（点“全部关联 Skill”查看）。证据来源为该小队直接指派的全部 ${performanceScope.issueCount} 个 Issue，且仅计该小队成员的显性 Skill 工具调用；终态与非终态均计入调用覆盖，成功率仅以终态计算，非终态不按失败处理。`
      : `默认清单仅包含 ${number(calledSkills.length)} 个有显式调用证据的 Skill；小队 Agent 共绑定 ${number(skills.total ?? 0)} 个 Skill（点“全部关联 Skill”查看）。证据来源为小队直接指派、近 ${performanceScope.days} 天、标题包含 ${performanceScope.titleMarker} 的 ${performanceScope.issueCount} 个 Issue，且仅计该小队成员的 Run；终态与非终态均计入调用覆盖，成功率仅以终态计算，非终态不按失败处理。`
    : '实测表现采集范围尚未就绪。';
  $('#skills').classList.remove('skeleton');
  $('#skills').innerHTML = `
    <div class="skill-summary"><div class="skill-number"><strong>${number(calledSkills.length)}</strong><span>${allSquadSkillScope ? '小队已调用 Skill' : '近 7 天已调用 Skill'}</span><small>默认展示范围</small></div><div class="skill-number"><strong>${number(calledSkills.reduce((total, skill) => total + Number(skill.observedCalls ?? 0), 0))}</strong><span>显式调用次数</span><small>含终态与非终态 Run</small></div><div class="skill-number"><strong>${number(calledSuccessfulRuns)}/${number(calledTerminalRuns)}</strong><span>终态成功 / 终态总数</span><small>失败 ${number(calledFailedRuns)} · 超时 ${number(calledTimeoutRuns)}</small></div><div class="skill-number"><strong>${number(runtimeRiskSkills.length)}</strong><span>调用异常 Skill</span><small>成功率低于 100%</small></div></div>
    <div class="filter-bar skill-filter">${[['recent-production', allSquadSkillScope ? '小队已调用' : '近 7 天已调用'], ['runtime-risk', '调用异常'], ['unpublished', '未发布'], ['attention', '需关注'], ['all', `全部关联 Skill（${number(skills.total)}）`]].map(([value, label]) => filterButton('skill', value, label, state.skillFilter)).join('')}</div>
    <div class="table-wrap skill-table">${visible.length ? `<table class="health-table"><thead><tr><th>Skill</th><th>${allSquadSkillScope ? '小队显式调用' : '近 7 天显式调用'}</th><th>终态结果</th><th>Darwin 对齐评价</th><th>发布状态</th><th>独立评审</th></tr></thead><tbody>${visible.map((skill) => { const performance = skill.productionPerformance; const terminalCalls = Number(performance?.terminalCalls ?? 0); const successRate = terminalCalls ? Math.round(Number(performance?.successCalls ?? 0) / terminalCalls * 100) : null; const callEvidence = skill.observedCalls > 0 ? '<span class="skill-evidence explicit">已识别显式调用</span>' : '<span class="skill-evidence">已绑定，暂无显式调用</span>'; return `<tr><td><button class="entity-link" type="button" data-action="open-skill" data-skill-id="${escapeHtml(skill.id)}">${escapeHtml(skill.name)}</button><span class="cell-note">绑定 ${number(skill.boundAgentCount)} 个 Agent</span></td><td><strong>${number(skill.observedCalls)} 次</strong>${callEvidence}</td><td><strong>${escapeHtml(productionPerformanceSummary(performance))}</strong><span class="cell-note">${successRate == null ? '无终态成功率' : `${allSquadSkillScope ? '小队范围' : '近 7 天'}终态成功率 ${number(successRate)}%`}</span></td><td>${darwinScoreCell(skill)}<span class="cell-note">${escapeHtml(darwinGap(skill))}</span></td><td><span class="publish-state ${skill.publishedAt ? 'published' : 'unpublished'}">${skill.publishedAt ? '已发布' : '未发布'}</span><span class="cell-note">${escapeHtml(runtimeGateLabel(skill.darwin?.runtimeGate))}</span></td><td><button class="inline-detail" type="button" data-action="open-architecture-review" data-skill-id="${escapeHtml(skill.id)}">查看评审 →</button><span class="cell-note">已完成后显示 Judge 结论</span></td></tr>`; }).join('')}</tbody></table>${showMoreButton('skills', visible.length, filtered.length)}` : `<div class="empty">${escapeHtml(analysisEvidence?.detail ?? '当前筛选下没有小队显式 Skill 调用证据。')}</div>`}</div>
    <p class="note">${escapeHtml(performanceScopeNote)}</p>${analysisEvidence ? `<p class="note">本轮分析覆盖：${escapeHtml(analysisEvidence.detail)}</p>` : ''}<p class="note">${escapeHtml(skills.note)}</p>`;
}

function architectureReviewDate(item) {
  if (!item.reviewedAt) return '尚未评审';
  return time(item.reviewedAt);
}

function architectureReviewStatus(item) {
  if (item.multicaReview) return `Multica ${item.multicaReview.issue.identifier ?? '评审任务'} · ${item.multicaReview.issue.status}`;
  if (item.independentReview) return `独立评审 · ${item.independentReview.source}`;
  if (item.reviewPlan?.status === 'confirmed') return `测试 Prompt 已确认 · ${number(item.reviewPlan.promptCount)} 个`;
  if (item.reviewPlan) return '测试 Prompt 草稿待确认';
  return '尚未评审';
}

function selectedArchitectureSkills() {
  return [...document.querySelectorAll('input[name="architecture-skill"]:checked')].map((input) => input.value);
}

function renderArchitectureReviewList(items = architectureReviewItems) {
  const container = $('#architecture-review-content');
  if (!container) return;
  const selected = new Set(selectedArchitectureSkills());
  container.innerHTML = `<div class="architecture-review-toolbar"><div><strong>已选择 <span id="architecture-selected-count">${number(selected.size)}</span> 个</strong><span>先确认每个 Skill 的 2–3 条测试 Prompt，再在 RPG2 创建“完成skill架构评审”Issue。</span></div><div><button type="button" class="button secondary" data-action="select-all-architecture-reviews">全选</button><button type="button" class="button primary" data-action="design-darwin-prompts" ${selected.size ? '' : 'disabled'}>生成测试 Prompt</button></div></div><div class="architecture-review-table-wrap"><table class="architecture-review-table"><thead><tr><th><input id="architecture-select-all" type="checkbox" aria-label="选择全部 Skill" ${items.length && selected.size === items.length ? 'checked' : ''}></th><th>Skill 名称</th><th>最近一次独立评审</th><th>查看评审详情</th></tr></thead><tbody>${items.map((item) => `<tr><td><input type="checkbox" name="architecture-skill" value="${escapeHtml(item.id)}" ${selected.has(item.id) ? 'checked' : ''}></td><td><strong>${escapeHtml(item.name)}</strong><small>${number(item.observedCalls)} 次近 7 天显式调用 · ${escapeHtml(architectureReviewStatus(item))}</small></td><td>${escapeHtml(architectureReviewDate(item))}</td><td><button class="inline-detail" type="button" data-action="open-architecture-review" data-skill-id="${escapeHtml(item.id)}" ${item.reviewedAt || item.reviewPlan || item.multicaReview ? '' : 'disabled'}>${item.reviewedAt || item.reviewPlan || item.multicaReview ? '查看详情 →' : '暂无评审记录'}</button></td></tr>`).join('')}</tbody></table></div>`;
}

async function openArchitectureReview() {
  const dialog = $('#architecture-review-dialog');
  if (!dialog) return;
  dialog.showModal();
  const container = $('#architecture-review-content');
  container.innerHTML = '<div class="empty">正在读取 Skill 评审目录…</div>';
  try {
    await fetch(apiUrl('architecture-reviews?view=work-items'));
    const response = await fetch(apiUrl('architecture-reviews'));
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data) || '读取评审目录失败');
    architectureReviewItems = data.items ?? [];
    renderArchitectureReviewList();
  } catch (error) {
    container.innerHTML = `<div class="empty">无法读取评审目录：${escapeHtml(error.message)}</div>`;
  }
}

function darwinPromptFields(plan) {
  return plan.prompts.map((prompt, index) => `<section class="darwin-prompt-card"><h4>Prompt ${index + 1} · ${escapeHtml(prompt.label)}</h4><label>测试 Prompt<textarea data-plan-skill-id="${escapeHtml(plan.skillId)}" data-prompt-index="${index}" data-prompt-field="prompt">${escapeHtml(prompt.prompt)}</textarea></label><label>预期结果<textarea data-plan-skill-id="${escapeHtml(plan.skillId)}" data-prompt-index="${index}" data-prompt-field="expected">${escapeHtml(prompt.expected)}</textarea></label></section>`).join('');
}

function renderReviewDocument(content) {
  if (!content) return '';
  const escaped = escapeHtml(content);
  const withTables = escaped.replace(/(^|\n)(\|[^\n]+\|\n\|[-:| ]+\|\n(?:\|[^\n]+\|\n?)*)/g, '$1<pre class="architecture-review-markdown-table">$2</pre>');
  return withTables
    .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function renderDarwinPromptDesign(plans) {
  const container = $('#architecture-review-content');
  if (!container) return;
  architecturePromptPlans = plans;
  const allConfirmed = plans.length > 0 && plans.every((plan) => plan.status === 'confirmed');
  container.innerHTML = `<div class="darwin-phase-banner"><p class="eyebrow">Darwin Phase 0.5 · 人工确认点</p><h3>确认测试 Prompt 后，创建 Multica 架构评审任务</h3><p>请按每个 Skill 的典型场景、信息不完整场景和协作交接场景校对或修改。全部确认后，创建一个“完成skill架构评审”Issue。</p></div><div class="darwin-prompt-list">${plans.map((plan) => `<article class="darwin-prompt-plan" data-skill-id="${escapeHtml(plan.skillId)}"><header><strong>${escapeHtml(plan.skillName)}</strong><span>${plan.status === 'confirmed' ? '测试 Prompt 已确认' : '测试 Prompt 草稿'}</span></header>${darwinPromptFields(plan)}${plan.status === 'confirmed' ? '<p class="darwin-confirmed">✓ 测试 Prompt 已确认，将作为 Multica Issue 的输入。</p>' : `<button type="button" class="button primary" data-action="confirm-darwin-prompts" data-skill-id="${escapeHtml(plan.skillId)}">确认这组 Prompt</button>`}</article>`).join('')}</div><div class="architecture-review-submit"><p>由 Darwin Skill 架构评审执行官创建 Judge 子任务，并将逐 Skill Markdown 文档作为主 Issue 评论附件交付。</p><button type="button" class="button primary" data-action="create-multica-architecture-review" ${allConfirmed ? '' : 'disabled'}>创建 Multica 架构评审任务</button></div><p class="note">检测台不读取本机密钥、不直连模型网关；只负责创建和跟踪 Multica Issue。</p>`;
}

async function designDarwinPrompts() {
  const skillIds = selectedArchitectureSkills();
  if (!skillIds.length) return;
  const container = $('#architecture-review-content');
  container.innerHTML = '<div class="empty">正在基于最新 Skill 正文设计 Darwin 测试 Prompt…</div>';
  try {
    const response = await fetch(apiUrl('architecture-reviews'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skillIds }) });
    const data = await response.json();
    if (!response.ok || !data.plans) throw new Error(apiErrorMessage(data) || '无法生成测试 Prompt');
    renderDarwinPromptDesign(data.plans);
  } catch (error) {
    announce(`测试 Prompt 生成失败：${error.message}`);
    if (container) container.innerHTML = `<div class="empty">无法生成测试 Prompt：${escapeHtml(error.message)}</div>`;
  }
}

async function confirmDarwinPrompts(skillId) {
  const container = $('#architecture-review-content');
  if (!container) return;
  const prompts = [...container.querySelectorAll(`[data-plan-skill-id="${CSS.escape(skillId)}"][data-prompt-field="prompt"]`)].map((field, index) => ({ id: `prompt-${index + 1}`, label: `测试场景 ${index + 1}`, prompt: field.value, expected: container.querySelector(`[data-plan-skill-id="${CSS.escape(skillId)}"][data-prompt-index="${index}"][data-prompt-field="expected"]`)?.value ?? '' }));
  try {
    const response = await fetch(apiUrl(`architecture-reviews?skillId=${encodeURIComponent(skillId)}&plan=confirm`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompts }) });
    const data = await response.json();
    if (!response.ok || !data.plan) throw new Error(apiErrorMessage(data) || '确认失败');
    architecturePromptPlans = architecturePromptPlans.map((item) => item.skillId === skillId ? data.plan : item);
    renderDarwinPromptDesign(architecturePromptPlans);
    announce('测试 Prompt 已确认。全部确认后即可创建 Multica 架构评审 Issue。');
  } catch (error) {
    announce(`测试 Prompt 确认失败：${error.message}`);
  }
}

async function createMulticaArchitectureReviewIssue() {
  const skillIds = architecturePromptPlans.filter((plan) => plan.status === 'confirmed').map((plan) => plan.skillId);
  if (!skillIds.length || skillIds.length !== architecturePromptPlans.length) return;
  const container = $('#architecture-review-content');
  if (!container) return;
  container.innerHTML = '<div class="empty">正在 RPG2 工作区创建“完成skill架构评审”Issue…</div>';
  try {
    const response = await fetch(apiUrl('architecture-reviews?action=issues'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skillIds }) });
    const data = await response.json();
    if (!response.ok || !data.issue) throw new Error(apiErrorMessage(data) || '无法创建 Multica 架构评审任务');
    const title = data.issue.identifier ?? data.issue.id;
    container.innerHTML = `<div class="darwin-phase-banner"><p class="eyebrow">Multica 评审任务已创建</p><h3>${escapeHtml(title)}</h3><p>已提交 ${number(data.skillCount)} 个 Skill。执行官会创建独立 Judge 子任务，并在此主 Issue 逐条评论上传可下载的 Markdown 评审文档。</p>${data.issue.url ? `<p><a class="inline-detail" href="${escapeHtml(data.issue.url)}" target="_blank" rel="noreferrer">在 Multica 查看任务 →</a></p>` : ''}</div><button type="button" class="button secondary" data-action="back-to-architecture-list">返回评审列表</button>`;
    architecturePromptPlans = [];
    announce(`已创建 ${title}，正在由 Multica 执行评审。`);
  } catch (error) {
    announce(`创建评审任务失败：${error.message}`);
    renderDarwinPromptDesign(architecturePromptPlans);
  }
}

async function openArchitectureReviewDetail(skillId) {
  if (!skillId) return;
  try {
    const response = await fetch(apiUrl(`architecture-reviews?skillId=${encodeURIComponent(skillId)}`));
    const data = await response.json();
    if (!response.ok || !data.item) throw new Error(apiErrorMessage(data) || '读取评审详情失败');
    const independent = data.item.independentReview;
    const multicaReview = data.item.multicaReview;
    const delivery = multicaReview?.plan?.delivery;
    const finalReview = delivery?.document?.content;
    const plan = data.reviewPlan;
    $('#architecture-review-dialog')?.close();
    openDialog(`<p class="eyebrow">Skill 架构评审</p><h2>${escapeHtml(data.item.name)}</h2>${multicaReview ? `<p class="detail-lead">Multica 任务：${escapeHtml(multicaReview.issue.identifier ?? multicaReview.issue.id)} · ${escapeHtml(multicaReview.issue.status)}${multicaReview.issue.url ? ` · <a href="${escapeHtml(multicaReview.issue.url)}" target="_blank" rel="noreferrer">打开任务 →</a>` : ''}</p>` : ''}${finalReview ? `<section class="architecture-review-detail final-review-document"><div class="final-review-heading"><h3>${escapeHtml(delivery.document.name)}</h3>${delivery?.markdownAttachments?.[0]?.url ? `<a class="inline-detail" href="${escapeHtml(delivery.markdownAttachments[0].url)}" target="_blank" rel="noreferrer">下载原文 ↓</a>` : ''}</div><div class="review-document-content">${renderReviewDocument(finalReview)}</div></section>` : `${delivery?.summary ? `<p class="analysis-summary">${escapeHtml(delivery.summary)}</p>` : ''}${delivery?.markdownAttachments?.length ? `<section class="architecture-review-detail"><h3>可下载评审文档</h3><ul class="reason-list">${delivery.markdownAttachments.map((file) => `<li class="reason">${file.url ? `<a href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.name)} ↓</a>` : escapeHtml(file.name)}</li>`).join('')}</ul></section>` : ''}`}${independent ? `<p class="detail-lead">既有独立评审文档 · ${escapeHtml(time(independent.reviewedAt))} · ${escapeHtml(independent.source)} · ${number(independent.score)}/10</p>` : ''}${!finalReview && plan ? `<section class="architecture-review-detail"><h3>Darwin 测试 Prompt <span>${plan.status === 'confirmed' ? '已确认' : '草稿'}</span></h3><p class="note">${plan.status === 'confirmed' ? `已于 ${escapeHtml(time(plan.confirmedAt))} 确认；将作为 Multica 中“完成skill架构评审”任务的输入。` : '尚未确认，不会创建评审任务。'}</p><ol class="reason-list">${plan.prompts.map((prompt) => `<li class="reason"><strong>${escapeHtml(prompt.label)}</strong><p>${escapeHtml(prompt.prompt)}</p><small>预期：${escapeHtml(prompt.expected)}</small></li>`).join('')}</ol></section>` : ''}`);
  } catch (error) {
    openDialog(`<p class="eyebrow">Skill 架构评审</p><h2>读取失败</h2><p class="detail-lead">${escapeHtml(error.message)}</p>`);
  }
}

function renderCoverage(snapshot) {
  const scope = snapshot.coverage.scope;
  const scopeText = scope?.squadName ? `范围：${scope.squadName}，按 ${scope.issueAssignmentRule}。` : '';
  $('#coverage').textContent = `模式：${snapshot.coverage.collectorMode}。${scopeText} 本轮读取 ${number(snapshot.coverage.issuesCollected)}/${number(snapshot.coverage.issuesReportedByMultica)} 个 Issue、${number(snapshot.coverage.runsCollected)} 条 Run，以及 ${number(snapshot.coverage.runsWithMessages)} 条 Run 的消息记录。Skill 调用量是可观测下界，未观测不等于未调用。`;
}

function render(snapshot) {
  state.snapshot = snapshot;
  if ($('#hero')) renderHero(snapshot);
  if ($('#action-strip')) renderActions(snapshot);
  if ($('#daily-health-content')) renderDailySummary(snapshot);
  if ($('#trend-chart')) renderTrend();
  if ($('#incidents')) renderIncidents(snapshot);
  if ($('#production')) renderProduction(snapshot);
  if ($('#overview-production')) renderProductionOverview(snapshot);
  if ($('#production-issue-status')) renderIssueStatusPanel(snapshot);
  if ($('#production-one-pass-issues')) renderOnePassIssues(snapshot);
  if ($('#production-rework-issues')) renderProductionReworkIssues(snapshot);
  if ($('#production-review')) renderReviewQueue(snapshot);
  if ($('#services')) renderServices(snapshot);
  if ($('#agents')) renderAgents(snapshot);
  if ($('#skills')) renderSkills(snapshot);
  if ($('#coverage')) renderCoverage(snapshot);
  if ($('#freshness')) $('#freshness').textContent = `快照 ${time(snapshot.generatedAt)}`;
}

function dimensionsMarkup(dimensions = []) {
  return dimensions.map((dimension) => `<div class="dimension-row"><span>${escapeHtml(dimension.label)}</span><strong>${dimension.score == null ? '未观测' : `${dimension.score} 分`}</strong><em>权重 ${dimension.weight}%</em></div>`).join('') || '<p class="note">暂无可解释评分维度。</p>';
}

function darwinDimensionsMarkup(dimensions = []) {
  return dimensions.map((dimension) => `<div class="dimension-row darwin-dimension"><span>${escapeHtml(dimension.label)}<small>${escapeHtml(dimension.evidence === 'recent_granular_production' ? '小队生产实测' : dimension.evidence === 'pending_recent_production_sample' ? '待生产样本' : dimension.evidence === 'insufficient_recent_production_sample' ? '生产样本不足' : dimension.evidence === 'independent_architecture_review' ? '外部独立架构评审' : dimension.evidence === 'pending_independent_review' ? '待独立评审' : '静态审计')}</small></span><strong>${dimension.score == null ? '待补证据' : `${dimension.score} 分`}</strong><em>权重 ${dimension.weight}% · ${escapeHtml(dimension.detail || '无补充说明')}</em></div>`).join('') || '<p class="note">尚未采集到完整 Skill 正文。</p>';
}

function reasonKindLabel(kind) {
  return ({ workflow_state: '状态锚点', execution_chain: '执行链', execution_failure: '失败信号', running_without_resolution: '运行状态', post_run_block: '下游待确认', dependency_or_wait: '依赖信号', runtime_identity_context: '运行上下文信号', runtime_excerpt: '日志摘录', message_gap: '采集缺口', missing_execution_trace: '采集缺口' })[kind] ?? '分析项';
}

function evidenceMarkup(evidence = []) {
  const rows = evidence.filter(Boolean);
  if (!rows.length) return '';
  return `<details class="raw-evidence"><summary>展开 ${rows.length} 条原始证据</summary><ul>${rows.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>`;
}

function certaintyLabel(reason) {
  if (reason.certainty) return ({ fact: '已确认事实', observed: '运行观察', gap: '证据缺口', candidate: '待验证分析' })[reason.certainty] ?? '分析项';
  if (['workflow_state', 'execution_chain', 'execution_failure', 'post_run_block'].includes(reason.kind)) return '已观测';
  if (['message_gap', 'missing_execution_trace'].includes(reason.kind)) return '证据缺口';
  return '运行观察';
}

function reasonsMarkup(reasons = [], emptyText = '当前没有可解释原因。') {
  if (!reasons.length) return `<p class="note">${emptyText}</p>`;
  return `<ol class="reason-list">${reasons.map((reason, index) => `<li class="reason ${escapeHtml(reason.severity ?? '')}"><div class="reason-heading"><span>${index + 1}</span><div><small>${reasonKindLabel(reason.kind)} · <b class="certainty-badge">${certaintyLabel(reason)}</b></small><strong>${escapeHtml(reason.title)}</strong></div></div><p>${escapeHtml(reason.detail)}</p>${evidenceMarkup(reason.evidence)}</li>`).join('')}</ol>`;
}

function confidenceLabel(value) {
  return ({ high: '充分', medium: '有限', low: '不足' })[value] ?? '未知';
}

function evidenceCoverageMarkup(coverage = [], rawEvidence = []) {
  if (!coverage.length) return '';
  return `<section class="analysis-section"><h4>证据覆盖</h4><div class="evidence-coverage">${coverage.map((item) => `<div class="coverage-card ${item.available ? 'available' : 'missing'}"><span>${item.available ? '已采集' : '缺失'}</span><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.detail)}</p></div>`).join('')}</div>${evidenceMarkup(rawEvidence)}</section>`;
}

function blockerTimelineMarkup(timeline = []) {
  if (!timeline.length) return '';
  return `<section class="analysis-section"><h4>已确认执行时间线</h4><ol class="analysis-timeline">${timeline.map((item) => `<li><time>${escapeHtml(item.at ? time(item.at) : '时间未采集')}</time><div><small>${escapeHtml(item.source)} · ${item.certainty === 'confirmed' ? '已确认' : '运行观察'}</small><p>${escapeHtml(item.statement)}</p></div></li>`).join('')}</ol></section>`;
}

function candidateMarkup(candidate) {
  if (!candidate) return '';
  const isGap = candidate.state === 'needs_evidence';
  return `<section class="candidate-finding ${isGap ? 'needs-evidence' : ''}"><div><p class="eyebrow">${isGap ? '归因证据缺口' : '候选归因（待验证）'}</p><h4>${escapeHtml(candidate.title)}</h4></div><span>${confidenceLabel(candidate.confidence)}可信</span><p>${escapeHtml(candidate.detail)}</p><dl><div><dt>建议核对人</dt><dd>${escapeHtml(candidate.owner)}</dd></div><div><dt>验证方式</dt><dd>${escapeHtml(candidate.verification)}</dd></div></dl></section>`;
}

function recoveryPlanMarkup(plan = []) {
  if (!plan.length) return '';
  return `<section class="analysis-section recovery-plan"><h4>建议修改动作</h4><ol>${plan.map((item) => `<li><strong>${escapeHtml(item.owner)}</strong><p>${escapeHtml(item.action)}</p><small>验收：${escapeHtml(item.acceptance)}</small></li>`).join('')}</ol></section>`;
}

function diagnosisMarkup(analysis) {
  const diagnosis = analysis.diagnosis ?? {
    node: analysis.executionContext?.nodeLabel ?? '执行节点未重新分析',
    cause: analysis.candidate?.detail ?? analysis.summary ?? '当前快照尚未提供结构化卡点分析。',
    confidence: analysis.confidenceDetail?.cause ?? analysis.confidence ?? 'low',
    source: analysis.candidate ? '已有执行链分析' : '当前快照'
  };
  return `<section class="diagnosis-card"><h4>卡点与原因</h4><dl class="diagnosis-grid"><div><dt>卡在哪</dt><dd>${escapeHtml(diagnosis.node)}</dd></div><div><dt>为什么卡住</dt><dd>${escapeHtml(diagnosis.cause)}</dd></div></dl><p class="diagnosis-source">判定：${confidenceLabel(diagnosis.confidence)}可信 · 来源：${escapeHtml(diagnosis.source)}</p></section>`;
}

function taskRecordMarkup(taskRecord, executionContext = null) {
  const runs = taskRecord?.runs ?? [];
  const messages = taskRecord?.messages ?? [];
  if (!taskRecord) return `<section class="analysis-section task-record"><h4>Task 汇总</h4><p class="note">打开详情后可读取本地采集的执行汇总。</p></section>`;
  const statusCounts = new Map();
  for (const run of runs) statusCounts.set(run.status ?? 'unknown', (statusCounts.get(run.status ?? 'unknown') ?? 0) + 1);
  const latest = [...runs].sort((left, right) => new Date(right.last_heartbeat_at ?? right.completed_at ?? right.created_at ?? 0) - new Date(left.last_heartbeat_at ?? left.completed_at ?? left.created_at ?? 0))[0];
  const statusSummary = [...statusCounts.entries()].map(([status, count]) => `${status} ${number(count)}`).join(' · ') || '无 Task';
  const latestSummary = latest
    ? latest.id === executionContext?.taskId
      ? `最近执行节点：${executionContext.nodeLabel} · ${executionContext.completion}${executionContext.gateLabel ? ` · 后续：${executionContext.gateLabel}` : ''}`
      : `最近执行节点状态：${latest.status ?? 'unknown'}${latest.heartbeat_stage ? ` · ${latest.heartbeat_stage}` : ''}`
    : '最近执行节点未采集';
  return `<section class="analysis-section task-record"><h4>Task 汇总</h4><div class="task-record-summary"><p><strong>${number(runs.length)}</strong> 条 Task · ${statusSummary}</p><small>${escapeHtml(latestSummary)} · ${number(messages.length)} 条运行消息已用于分析</small></div><p class="task-record-note">检测台不展示逐条 Run、Task ID 或运行消息原文；如需追查，请在 Multica Issue 的执行日志中查看。</p></section>`;
}

function blockingAnalysisMarkup(analysis, taskRecord = null, rawEvidence = []) {
  if (!analysis) return '';
  return `<section class="execution-analysis"><div class="execution-analysis-heading"><div><p class="eyebrow">阻塞分析</p><h3>只保留可执行信息</h3></div></div>${diagnosisMarkup(analysis)}${recoveryPlanMarkup(analysis.recoveryPlan)}${taskRecordMarkup(taskRecord, analysis.executionContext)}${evidenceCoverageMarkup(analysis.coverage, rawEvidence)}</section>`;
}

function openDialog(content) {
  const dialog = $('#detail-dialog');
  const contentElement = $('#detail-content');
  if (!dialog || !contentElement) return;
  contentElement.innerHTML = content;
  if (!dialog.open) dialog.showModal();
  window.requestAnimationFrame(() => dialog.querySelector('.dialog-close button')?.focus());
}

function openAgent(agentId) {
  const agent = state.snapshot.agents.find((item) => item.id === agentId);
  if (!agent) return;
  const incidents = state.snapshot.incidents.filter((item) => item.agent?.id === agent.id);
  const windowLabel = `近 ${number(agent.analysisWindowHours ?? 24)}h`;
  openDialog(`<p class="eyebrow">Agent 评分详情</p><h2>${escapeHtml(agent.name)}</h2><p class="detail-lead"><i class="status-dot ${statusClass(agent.status)}"></i>${statusLabel(agent.status)} · ${scoreCell(agent.score, agent.confidence)}</p><p class="analysis-summary">${escapeHtml(agent.anomalySummary ?? '暂无可解释异常。')}</p><div class="detail-kpis"><span>${escapeHtml(windowLabel)} Run<strong>${number(agent.recentRuns)}</strong></span><span>直接负责 Issue<strong>${number(agent.directIssueCount)}</strong></span><span>推进风险<strong>${number(agent.progressRiskCount)}</strong></span></div><h3>异常原因</h3>${reasonsMarkup(agent.anomalyReasons, '当前可观测窗口没有发现异常原因。')}<h3>评分维度</h3><div class="dimension-list">${dimensionsMarkup(agent.dimensions)}</div><h3>关联事件</h3>${incidents.length ? `<div class="detail-events">${incidents.slice(0, 8).map((item) => `<button type="button" class="detail-event" data-action="open-incident" data-incident-id="${escapeHtml(item.id)}" data-issue-id="${escapeHtml(item.issue?.id ?? '')}">${escapeHtml(item.title)}<span>${escapeHtml(item.issue?.identifier ?? item.kind)}</span></button>`).join('')}</div>` : '<p class="note">当前采集范围没有直接关联到该 Agent 的事件。</p>'}`);
}

function openSkill(skillId) {
  const skill = state.snapshot.skills.assessments.find((item) => item.id === skillId);
  if (!skill) return;
  const incidents = state.snapshot.incidents.filter((item) => item.skill?.id === skill.id);
  const regression = skill.regression ? `${number(skill.regression.passed)}/${number(skill.regression.total)} 通过 · ${escapeHtml(skill.regression.suite || '未命名回归集')}` : '尚未接入经过审阅的固定回归集';
  const darwin = skill.darwin;
  const summary = darwin
    ? `Darwin 对齐分 ${darwin.score ?? '待定'}/100，当前仅覆盖 ${darwin.coverage}% 可核验证据。${darwin.missingWeight ? `仍缺 ${darwin.missingWeight}%：独立架构评审与近期颗粒生产终态样本。` : ''}` : '尚未采集完整 SKILL.md 正文；当前不能给出 Darwin 对齐评价。';
  const runtimeGate = darwin?.runtimeGate;
  const architectureReview = darwin?.architectureReview;
  const operational = skill.operational;
  const production = skill.productionPerformance;
  const allSquadScope = production?.timeRange === 'all_retained_history';
  const scopeLabel = allSquadScope ? '小队全部直接指派 Issue' : '近 7 天【颗粒生产】Issue';
  const productionEvidence = !production?.observedRuns
    ? `${scopeLabel} 未识别到该 Skill 的调用证据。`
    : production.sampleSufficient
      ? `${scopeLabel}：覆盖 ${production.issueCount} 个 Issue，观察 ${production.observedRuns} 个调用（终态 ${production.terminalCalls}、非终态 ${production.nonTerminalCalls}）；终态中 ${production.successCalls} 个成功，失败 ${production.failedCalls}，超时 ${production.timeoutCalls}${production.medianDurationLabel ? `，中位时长 ${production.medianDurationLabel}` : ''}。`
      : `${scopeLabel}：已识别 ${production.observedRuns} 个调用（终态 ${production.terminalCalls}、非终态 ${production.nonTerminalCalls}）；至少需要 3 个终态样本后才给“实测表现”评分。`;
  const scopeNote = allSquadScope
    ? `实测表现读取小队直接指派的全部 ${number(production?.scopeIssueCount)} 个 Issue，仅计小队成员的显式 Skill 工具调用；终态与非终态均计入，成功率仅以终态计算。`
    : `实测表现读取近 7 天标题带【颗粒生产】的 ${number(production?.scopeIssueCount)} 个真实 Issue，计入显式调用的终态与非终态 Run。成功率仅以终态计算，非终态不按失败处理。`;
  openDialog(`<p class="eyebrow">Skill 评价详情</p><h2>${escapeHtml(skill.name)}</h2><p class="detail-lead"><i class="status-dot ${statusClass(skill.status)}"></i>运行健康：${statusLabel(skill.status)} · ${operational ? scoreCell(operational.score, operational.confidence) : '<span class="score-muted">证据不足</span>'}</p><p class="analysis-summary">${escapeHtml(summary)}</p><div class="detail-kpis"><span>Skill 正文<strong>${darwin?.content?.available ? `${number(darwin.content.characters)} 字符` : '待采集'}</strong></span><span>附属文件<strong>${darwin?.content?.files == null ? '—' : number(darwin.content.files)}</strong></span><span>Runtime Gate<strong class="gate-${escapeHtml(runtimeGate?.status ?? 'unknown')}">${escapeHtml(runtimeGateLabel(runtimeGate))}</strong></span></div><h3>Darwin 对齐九维</h3><p class="note">${escapeHtml(scopeNote)}</p><div class="dimension-list">${darwinDimensionsMarkup(darwin?.dimensions)}</div>${architectureReview ? `<h3>独立架构评审</h3><p class="note">基线 ${architectureReview.baselineScore == null ? '—' : `${architectureReview.baselineScore}/100`} · 来源 ${escapeHtml(architectureReview.source?.fileName ?? '评审文档')}。${escapeHtml(architectureReview.architectureDetail)}</p>${architectureReview.findings?.length ? `<div class="architecture-findings">${architectureReview.findings.map((item) => `<article><strong>${escapeHtml(item.id)} · ${escapeHtml(item.priority)}</strong><p>${escapeHtml(item.problem)}</p><p><b>修改动作：</b>${escapeHtml(item.action)}</p><p><b>验收：</b>${escapeHtml(item.acceptance)}</p></article>`).join('')}</div>` : ''}` : ''}${runtimeGate?.warnings?.length ? `<h3>Runtime Gate 复核项</h3><div class="warning-list">${runtimeGate.warnings.map((warning) => `<span>${escapeHtml(warning)}</span>`).join('')}</div>` : ''}<h3>${allSquadScope ? '小队范围实测' : '近期颗粒生产实测'}</h3><p class="note">${escapeHtml(productionEvidence)}</p><h3>运行健康（独立于 Darwin 评分）</h3><div class="dimension-list">${dimensionsMarkup(operational?.dimensions)}</div><h3>调用与固定回归参考</h3><p class="note">显式工具调用 ${number(skill.observedCalls)} 次${skill.runtimeSuccessRate == null ? '；尚无足够显式调用样本。' : `；调用成功率 ${skill.runtimeSuccessRate}%。`} ${skill.implicitEvidenceRuns ? `另识别到 ${number(skill.implicitEvidenceRuns)} 条隐性生产链路证据，仅用于目录覆盖，不计入调用次数或成功率。` : ''} ${regression}</p><h3>发布状态</h3><p class="note"><span class="publish-state ${skill.publishedAt ? 'published' : 'unpublished'}">${skill.publishedAt ? '已发布' : '未发布'}</span>${skill.hasDraft ? ' 当前还有草稿版本，发布快照与草稿需分别核验。' : ' 当前没有草稿版本。'}</p><h3>关联事件</h3>${incidents.length ? `<div class="detail-events">${incidents.map((item) => `<button type="button" class="detail-event" data-action="open-incident" data-incident-id="${escapeHtml(item.id)}" data-issue-id="${escapeHtml(item.issue?.id ?? '')}">${escapeHtml(item.title)}<span>${escapeHtml(item.kind)}</span></button>`).join('')}</div>` : '<p class="note">当前没有可直接归因到该 Skill 的事件；不代表运行完全无风险。</p>'}`);
}

async function openIssue(issueId) {
  if (!issueId) return;
  openDialog('<p class="note">正在读取云端采集的 Issue 详情…</p>');
  try {
    const response = await fetch(apiUrl(`issue?id=${encodeURIComponent(issueId)}`));
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data) || '读取失败');
    const issue = data.issue;
    openDialog(`<p class="eyebrow">生产单详情</p><h2>${escapeHtml(issue.identifier ?? issue.id)} · ${escapeHtml(issue.title)}</h2><p class="detail-lead"><i class="status-dot ${statusClass(issue.status === 'blocked' ? 'critical' : issue.status === 'in_review' ? 'warning' : 'healthy')}"></i>状态：${escapeHtml(issue.status ?? 'unknown')} · 最后更新：${time(issue.updated_at)}</p>${taskRecordMarkup({ runs: data.runs, messages: data.messages })}<p><a class="issue-link" target="_blank" rel="noreferrer" href="https://agent.new.ndhy.com/rpg2/issues/${encodeURIComponent(issue.id)}">在 Multica 打开 ${escapeHtml(issue.identifier ?? issue.id)} ↗</a></p>`);
  } catch (error) {
    openDialog(`<p class="eyebrow">Issue 详情</p><h2>读取失败</h2><p class="detail-lead">${escapeHtml(error.message)}</p>`);
  }
}

async function openIncident(incidentId, issueId) {
  const incident = state.snapshot.incidents.find((item) => item.id === incidentId);
  if (!incident) return;
  if (!issueId) {
    openDialog(`<p class="eyebrow">事件证据</p><h2>${escapeHtml(incident.title)}</h2>${blockingAnalysisMarkup(incident.analysis, null, incident.evidence)}`);
    return;
  }
  openDialog('<p class="note">正在读取云端采集的 Issue 详情…</p>');
  try {
    const response = await fetch(apiUrl(`issue?id=${encodeURIComponent(issueId)}`));
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data) || '读取失败');
    openDialog(`<p class="eyebrow">事件证据</p><h2>${escapeHtml(incident.title)}</h2>${blockingAnalysisMarkup(incident.analysis, { runs: data.runs, messages: data.messages }, incident.evidence)}<p><a class="issue-link" target="_blank" rel="noreferrer" href="https://agent.new.ndhy.com/rpg2/issues/${encodeURIComponent(data.issue.id)}">在 Multica 打开 ${escapeHtml(data.issue.identifier ?? data.issue.id)} ↗</a></p>`);
  } catch (error) {
    openDialog(`<h2>无法读取详情</h2><p class="note">${escapeHtml(error.message)}</p>`);
  }
}

function scrollTo(selector) { $(selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action]');
  if (!control || !state.snapshot) return;
  const { action, value } = control.dataset;
  if (action === 'jump-incidents') return $('#risk-queue') ? scrollTo('#risk-queue') : navigateTo('risks.html', { risk: 'critical' });
  if (action === 'jump-operations') return $('#operations') ? scrollTo('#operations') : navigateTo('production.html');
  if (action === 'jump-review-queue') {
    if (!$('#review-queue')) return navigateTo('production.html', {}, '#review-queue');
    scrollTo('#review-queue');
    announce('已定位到审核中队列。');
    return;
  }
  if (action === 'set-incident-filter') {
    if (!$('#incidents')) return navigateTo('risks.html', { risk: value });
    state.incidentFilter = value;
    state.incidentLimit = 8;
    syncFiltersToUrl();
    renderIncidents(state.snapshot);
    announce('已更新风险筛选。');
    scrollTo('#risk-queue');
    return;
  }
  if (action === 'set-agent-filter') {
    if (!$('#agents')) return navigateTo('agents.html', { agent: value });
    state.agentFilter = value;
    state.agentLimit = 8;
    syncFiltersToUrl();
    renderAgents(state.snapshot);
    announce('已更新 Agent 筛选。');
    return;
  }
  if (action === 'set-skill-filter') {
    if (!$('#skills')) return navigateTo('skills.html', { skill: value });
    state.skillFilter = value;
    state.skillLimit = 8;
    syncFiltersToUrl();
    renderSkills(state.snapshot);
    announce('已更新 Skill 筛选。');
    scrollTo('#skills-section');
    return;
  }
  if (action === 'set-trend-metric') { state.trendMetric = value; syncFiltersToUrl(); renderTrend(); announce(`已切换为${trendMetrics[value].label}趋势。`); return; }
  if (action === 'set-trend-range') { state.trendRange = Number(value); state.trend = null; syncFiltersToUrl(); renderTrend(); refreshTrend({ announceOnSuccess: true }); return; }
  if (action === 'expand-incidents') { state.incidentLimit = state.snapshot.incidents.filter((item) => incidentMatches(item, state.incidentFilter)).length; renderIncidents(state.snapshot); return; }
  if (action === 'expand-agents') { state.agentLimit = state.snapshot.agents.filter((agent) => agentMatches(agent, state.agentFilter)).length; renderAgents(state.snapshot); return; }
  if (action === 'expand-skills') { state.skillLimit = state.snapshot.skills.assessments.filter((skill) => skillMatches(skill, state.skillFilter)).length; renderSkills(state.snapshot); return; }
  if (action === 'open-incident') { lastDialogTrigger = control; return openIncident(control.dataset.incidentId, control.dataset.issueId); }
  if (action === 'open-rework-issue') { lastDialogTrigger = control; return openReworkIssue(control.dataset.issueId); }
  if (action === 'open-issue') { lastDialogTrigger = control; return openIssue(control.dataset.issueId); }
  if (action === 'open-agent') { lastDialogTrigger = control; return openAgent(control.dataset.agentId); }
  if (action === 'open-skill') { lastDialogTrigger = control; return openSkill(control.dataset.skillId); }
  if (action === 'select-all-architecture-reviews') {
    const inputs = [...document.querySelectorAll('input[name="architecture-skill"]')];
    const allSelected = inputs.length && inputs.every((input) => input.checked);
    inputs.forEach((input) => { input.checked = !allSelected; });
    return renderArchitectureReviewList();
  }
  if (action === 'design-darwin-prompts') return designDarwinPrompts();
  if (action === 'confirm-darwin-prompts') return confirmDarwinPrompts(control.dataset.skillId);
  if (action === 'create-multica-architecture-review') return createMulticaArchitectureReviewIssue();
  if (action === 'back-to-architecture-list') return openArchitectureReview();
  if (action === 'open-architecture-review') { lastDialogTrigger = control; return openArchitectureReviewDetail(control.dataset.skillId); }
});

$('#architecture-review-button')?.addEventListener('click', () => {
  lastDialogTrigger = $('#architecture-review-button');
  openArchitectureReview();
});

$('#architecture-review-close')?.addEventListener('click', () => {
  $('#architecture-review-dialog')?.close();
});

$('#architecture-review-dialog')?.addEventListener('close', () => {
  if (lastDialogTrigger?.isConnected) lastDialogTrigger.focus();
});

$('#architecture-review-content')?.addEventListener('change', (event) => {
  if (event.target.matches('#architecture-select-all')) {
    document.querySelectorAll('input[name="architecture-skill"]').forEach((input) => { input.checked = event.target.checked; });
  }
  if (event.target.matches('#architecture-select-all, input[name="architecture-skill"]')) renderArchitectureReviewList();
});

$('#detail-dialog')?.addEventListener('close', () => {
  if (lastDialogTrigger?.isConnected) lastDialogTrigger.focus();
});

window.addEventListener('popstate', () => {
  restoreFiltersFromUrl();
  if (state.snapshot) {
    render(state.snapshot);
  }
});

function apiErrorMessage(data) {
  if (!data) return '读取失败';
  if (typeof data === 'string') return data;
  if (typeof data.error === 'string') return data.error;
  return data.error?.message ?? data.detail ?? '读取失败';
}

async function refresh({ forceRender = false, refreshTrendData = false } = {}) {
  // The rules and schemes pages are served by their own endpoints with no
  // snapshot-dependent hero/cards, and the health API has no projection for
  // either. Skipping the snapshot fetch here prevents a 404 from wiping the
  // content each page already rendered.
  if (currentPage() === 'rules' || currentPage() === 'schemes') return;
  try {
    const page = currentPage();
    const response = await fetch(apiUrl(`health?page=${encodeURIComponent(page)}`));
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data) || '读取本地快照失败');
    if (!data.snapshot) throw new Error('尚无快照，请点击“立即采集”。');
    state.refreshIntervalMs = safeRefreshInterval(data.refreshIntervalMs);
    const snapshotChanged = data.snapshot.generatedAt !== state.snapshot?.generatedAt;
    if (snapshotChanged || forceRender || !state.snapshot) {
      render(data.snapshot);
      cacheHealthState();
    }
    if ((snapshotChanged || refreshTrendData || forceRender) && $('#trend-chart')) await refreshTrend();
  } catch (error) {
    const hero = $('#hero');
    if (hero) {
      hero.classList.remove('skeleton');
      hero.innerHTML = `<div class="hero-copy"><p class="eyebrow">数据不可用</p><h1>无法读取本地健康快照</h1><p>${escapeHtml(error.message)}</p></div>`;
    } else {
      const main = $('main');
      if (main) main.innerHTML = `<section class="panel"><div class="panel-content"><div class="empty">无法读取本地健康快照：${escapeHtml(error.message)}</div></div></section>`;
    }
  }
}

async function refreshTrend({ announceOnSuccess = false } = {}) {
  if (!$('#trend-chart')) return;
  const requestVersion = ++trendRequestVersion;
  const requestedRange = state.trendRange;
  try {
    const response = await fetch(apiUrl(`health-trend?hours=${encodeURIComponent(requestedRange)}`));
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data) || '读取趋势失败');
    if (requestVersion !== trendRequestVersion || requestedRange !== state.trendRange) return;
    state.trend = data.trend;
    renderTrend();
    cacheHealthState();
    if (announceOnSuccess) announce(`已更新${trendRangeLabels[requestedRange]}健康度趋势。`);
  } catch (error) {
    if (requestVersion !== trendRequestVersion) return;
    $('#trend-caption').textContent = '趋势指标读取失败';
    const container = $('#trend-chart');
    container.classList.remove('skeleton');
    container.innerHTML = `<div class="empty">无法读取健康度趋势：${escapeHtml(error.message)}</div>`;
  }
}

$('#collect-button')?.addEventListener('click', async () => {
  const button = $('#collect-button');
  button.disabled = true;
  button.textContent = '采集中…';
  try {
    const freshness = $('#freshness');
    let running = true;
    while (running) {
      const response = await fetch(apiUrl('collect'), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(data) || '采集失败');
      running = data.collection === 'running';
      const progress = data.progress;
      if (freshness && running) freshness.textContent = `云端增量同步中：Run ${number(progress?.runs?.completed)}/${number(progress?.runs?.total)}，消息 ${number(progress?.messages?.completed)}/${number(progress?.messages?.total)}`;
      if (running) await new Promise((resolve) => { collectionPollTimer = window.setTimeout(resolve, 180); });
    };
    await refresh({ forceRender: true, refreshTrendData: true });
    await loadSchemes();
  } catch (error) {
    announce(`采集失败：${error.message}`);
    const freshness = $('#freshness');
    if (freshness) freshness.textContent = '采集失败，请稍后重试';
  } finally {
    button.disabled = false;
    button.textContent = '立即采集';
  }
});

restoreFiltersFromUrl();
ensureRulesNavigation();
loadMeasurementRules();
loadSchemes();
const cachedHealthState = readCachedHealthState();
if (cachedHealthState) {
  state.snapshot = cachedHealthState.snapshot;
  state.refreshIntervalMs = safeRefreshInterval(cachedHealthState.refreshIntervalMs);
  if (cachedHealthState.trend && cachedHealthState.trendRange === state.trendRange) state.trend = cachedHealthState.trend;
  render(state.snapshot);
} else {
  refresh({ forceRender: true, refreshTrendData: true });
}
scheduleFixedRefresh();
