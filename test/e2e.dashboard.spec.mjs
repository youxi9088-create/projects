// 前端看板端到端冒烟测试（Playwright + axe-core 无障碍抽检）。
// 注意：本文件不被 `node --test` 自动发现（命名 *.spec.mjs），需用 Playwright 运行。
// 前置编排（本仓库约定）：
//   1) npm i -D playwright @axe-core/playwright
//   2) npx playwright install chromium
//   3) node test/seed-e2e.mjs          （写入受控快照到临时库，输出 E2E_SEED_DB=...）
//   4) PORT=8799 HEALTH_DATA_PATH=$E2E_SEED_DB TARGET_SQUAD_NAME=__nonexistent_test_squad__ \
//        COLLECTION_INTERVAL_SECONDS=999999 node src/server.js &   （启动隔离实例）
//   5) BASE_URL=http://127.0.0.1:8799 npx playwright test test/e2e.dashboard.spec.mjs
// BASE_URL 默认 http://127.0.0.1:8787，可用环境变量覆盖。
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8787';

test('首页加载并包含无障碍跳过链接与主导航', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveTitle(/教育互动游戏生产线健康度检测台/);
  // a11y：跳到主要内容链接必须存在且可聚焦
  await expect(page.locator('a.skip-link')).toBeVisible();
  // 主导航五个入口齐全
  for (const label of ['概览', '风险队列', '生产线', 'Agent', 'Skill']) {
    await expect(page.locator('.quick-nav').getByText(label, { exact: true })).toBeVisible();
  }
  // 关键数据区域在加载后不再处于 skeleton 占位状态（说明 /api/health 已回填）
  await expect(page.locator('#hero')).not.toHaveClass(/skeleton/, { timeout: 10000 });

  expect(errors, `页面运行期错误：${errors.join(' | ')}`).toEqual([]);
});

test('“立即采集”按钮可点击且不会引发未捕获错误', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#collect-button').click();
  // 触发后台采集后等待接口状态回执，确认无崩溃
  await page.waitForResponse((resp) => resp.url().endsWith('/api/collect'), { timeout: 5000 });

  expect(errors, `点击采集后报错：${errors.join(' | ')}`).toEqual([]);
});

test('各二级页面均可访问并含有主内容区', async ({ page }) => {
  for (const path of ['/risks.html', '/production.html', '/agents.html', '/skills.html', '/rules.html']) {
    const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `${path} 应返回 200`).toBeLessThan(400);
    await expect(page.locator('main')).toBeVisible();
  }
});

test('首页满足 WCAG 2.1 AA 关键规则（无 critical/serious 违规）', async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#hero')).not.toHaveClass(/skeleton/, { timeout: 10000 });
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const severe = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  if (results.violations.length) {
    console.log(`[a11y] 共 ${results.violations.length} 项违规（严重 ${severe.length} 项）: ${results.violations.map((v) => `${v.id}(${v.impact})`).join(', ')}`);
  }
  expect(severe, `严重无障碍违规: ${severe.map((v) => v.id).join(', ')}`).toEqual([]);
});
