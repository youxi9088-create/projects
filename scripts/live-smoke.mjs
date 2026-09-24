// Live-browser smoke check against the deployed production dashboard.
// Verifies the rules page, the daily lists, the trend chart and the skills page
// render without uncaught errors and that /api/health-trend returns usable data.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://f.new.ndhy.com/a/rpg2-health-monitor';
const results = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  // 1. rules page
  await page.goto(`${BASE}/rules.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const rulesText = await page.locator('#measurement-rules').innerText().catch(() => '');
  const rulesCaption = await page.locator('#rules-caption').innerText().catch(() => '');
  results.push({ page: 'rules.html', pageErrors: [...pageErrors], consoleErrors: [...consoleErrors], hasRules: rulesText.length > 100, caption: rulesCaption.slice(0, 60) });
  pageErrors.length = 0; consoleErrors.length = 0;

  // 2. overview page (daily lists + trend)
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const dailyText = await page.locator('#daily-health-content').innerText().catch(() => '');
  const trendText = await page.locator('#trend-chart').innerText().catch(() => '');
  const dailyStats = await page.locator('.daily-stat strong').allInnerTexts().catch(() => []);
  results.push({ page: 'overview', pageErrors: [...pageErrors], consoleErrors: [...consoleErrors], daily: dailyText.slice(0, 400), trend: trendText.slice(0, 120), dailyStats });
  pageErrors.length = 0; consoleErrors.length = 0;

  // 3. skills page
  await page.goto(`${BASE}/skills.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const skillsText = await page.locator('main').innerText().catch(() => '');
  results.push({ page: 'skills.html', pageErrors: [...pageErrors], consoleErrors: [...consoleErrors], skillsSample: skillsText.slice(0, 300) });
  pageErrors.length = 0; consoleErrors.length = 0;

  // 4. trend API directly
  const trendResponse = await page.request.get(`${BASE}/api/health-trend?hours=168&_refresh=${Date.now()}`);
  let trendBody = null;
  try { trendBody = await trendResponse.json(); } catch { /* not json */ }
  results.push({ page: 'api/health-trend', status: trendResponse.status(), body: trendBody });
} catch (error) {
  results.push({ fatal: error.message });
} finally {
  await browser?.close();
}
console.log(JSON.stringify(results, null, 2));
