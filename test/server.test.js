// HTTP / API 层冒烟与边界测试。
// 以独立端口 + 临时 SQLite 库启动隔离实例，植入受控快照，
// 不与用户正在使用的 8787 实例或真实数据互相干扰。
// 采集器被强制失败（不存在的目标小队），因此不会覆盖植入的快照。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodePath = process.execPath;
const PORT = Number(process.env.TEST_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET_MARKER = '"name": "rpg2-health-monitor"'; // package.json 内容，绝不能从静态目录泄露

// 在导入任何 src 模块前设置环境（config 在导入时冻结）。
const tempDir = mkdtempSync(path.join(tmpdir(), 'rpg2-test-'));
process.env.HEALTH_DATA_PATH = path.join(tempDir, 'health-live.db');
process.env.TARGET_SQUAD_NAME = '__nonexistent_test_squad__';
process.env.COLLECTION_INTERVAL_SECONDS = '999999';

let serverProcess = null;

// 植入受控快照，让 /api/health 返回真实结构而非 null。
const { db, saveSnapshot } = await import('../src/db.js');
const { buildHealthSnapshot } = await import('../src/health.js');
{
  db(); // 建立表结构
  const source = {
    workspace: { id: 'ws-test', name: '测试工作区', slug: 'test' },
    issueTotal: 2,
    issues: [
      { id: 'i-1', identifier: 'RPG-1', title: '【颗粒生产】生产单A', status: 'done', updated_at: '2026-08-10T00:10:00Z', metadata: {} },
      { id: 'i-2', identifier: 'RPG-2', title: '被阻塞的生产单', status: 'blocked', updated_at: '2026-08-10T00:00:00Z', metadata: { blocked_reason: '等待素材服务恢复' } }
    ],
    agents: [{ id: 'a-1', name: '视频生产专员', status: 'working', model: 'm', skills: [{ id: 's-1' }] }],
    skills: [
      { id: 's-1', name: 'video-skill', has_draft: false, published_at: '2026-08-09T00:00:00Z' },
      { id: 's-2', name: 'asset-contract', has_draft: false, published_at: '2026-08-09T00:00:00Z' }
    ],
    runsByIssue: new Map([
      ['i-1', [{ id: 'r-1', issue_id: 'i-1', agent_id: 'a-1', status: 'completed', started_at: '2026-08-10T00:00:00Z', completed_at: '2026-08-10T00:10:00Z', result: { output: 'video-skill 与 asset-contract 完成' } }]],
      ['i-2', [{ id: 'r-2', issue_id: 'i-2', agent_id: 'a-1', status: 'failed', error: 'provider timeout', created_at: '2026-08-10T00:00:00Z', last_heartbeat_at: '2026-08-10T00:00:00Z' }]]
    ]),
    messagesByRun: new Map([
      ['r-1', [{ type: 'tool_use', tool: 'Skill', input: { skill: 'video-skill' } }]],
      ['r-2', [{ content: '等待素材服务恢复后重试。' }]]
    ]),
    scope: { squadName: '测试小队', issueAssignmentRule: 'x' },
    performanceScope: { days: 7, titleMarker: '【颗粒生产】', issueIds: ['i-1'], issueCount: 1, windowStart: '2026-08-03T00:00:00Z' }
  };
  const options = {
    now: '2026-08-10T01:00:00Z',
    runTimeoutMs: 30 * 60_000,
    stallWarningMs: 2 * 3_600_000,
    stallCriticalMs: 4 * 3_600_000,
    lineNodeStallMs: 4 * 3_600_000,
    serviceChecks: [{ serviceName: 'Multica', status: 'healthy', checkedAt: '2026-08-10T01:00:00Z' }],
    skillEvaluations: []
  };
  saveSnapshot(buildHealthSnapshot(source, options), '2026-08-10T01:00:00Z');
}

function request(method, pathname, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, BASE), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonOf(res) {
  return res.contentType?.includes('application/json') ? JSON.parse(res.body) : null;
}

function startServer() {
  const child = spawn(nodePath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/api/status');
      if (res.status === 200) return true;
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('测试服务器在超时内未就绪');
}

test.before(async () => {
  serverProcess = startServer();
  await waitForServer();
});

test.after(async () => {
  if (serverProcess) {
    const pid = serverProcess.pid;
    try { serverProcess.kill('SIGTERM'); } catch { /* 忽略 */ }
    // Windows：杀掉整个进程树（含 fork 出的采集子进程），释放 SQLite WAL 句柄。
    if (process.platform === 'win32') {
      try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch { /* 忽略 */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  // 清理是尽力而为：若仍有句柄残留，记录警告而非让测试文件判定失败。
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[cleanup] 临时目录未完全删除：${err.message}`);
  }
});

test('GET /api/status 返回健康状态与数据库路径', async () => {
  const res = await request('GET', '/api/status');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/);
  const data = jsonOf(res);
  assert.equal(data.ok, true);
  assert.equal(data.database, process.env.HEALTH_DATA_PATH);
  assert.ok(typeof data.latestSnapshotAt === 'string');
});

test('GET /api/health 返回植入的快照对象', async () => {
  const res = await request('GET', '/api/health');
  assert.equal(res.status, 200);
  const data = jsonOf(res);
  assert.ok(data.snapshot, '应有快照对象');
  assert.ok(data.snapshot.overview);
  assert.equal(typeof data.refreshIntervalMs, 'number');
});

test('GET /api/health 按页面裁剪不同区段', async () => {
  const risks = await request('GET', '/api/health?page=risks');
  assert.equal(risks.status, 200);
  assert.ok(Array.isArray(jsonOf(risks).snapshot.incidents));

  const agents = await request('GET', '/api/health?page=agents');
  assert.ok(Array.isArray(jsonOf(agents).snapshot.agents));

  const skills = await request('GET', '/api/health?page=skills');
  assert.ok(Array.isArray(jsonOf(skills).snapshot.skills.assessments));

  const production = await request('GET', '/api/health?page=production');
  assert.ok(jsonOf(production).snapshot.production);
});

test('GET 只读集合类端点均可达', async () => {
  for (const endpoint of ['/api/collections', '/api/measurement-rules', '/api/health-trend?hours=24']) {
    const res = await request('GET', endpoint);
    assert.equal(res.status, 200, `${endpoint} 应返回 200`);
    assert.match(res.contentType, /application\/json/, `${endpoint} 应为 JSON`);
  }
});

test('静态首页与资源返回正确内容类型', async () => {
  const home = await request('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.contentType, /text\/html/);
  assert.match(home.body, /教育互动游戏生产线健康度检测台/);

  const css = await request('GET', '/style.css');
  assert.equal(css.status, 200);
  assert.match(css.contentType, /text\/css/);

  const js = await request('GET', '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.contentType, /text\/javascript/);
});

test('不存在的静态页面返回 404 JSON', async () => {
  const res = await request('GET', '/no-such-page.html');
  assert.equal(res.status, 404);
  assert.match(res.contentType, /application\/json/);
  assert.ok(jsonOf(res).error);
});

test('路径穿越被拦截，且不泄露仓库文件', async () => {
  const attempts = [
    '/%2e%2e/config.js',
    '/..%2f..%2fpackage.json',
    '/..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/%2e%2e%2f%2e%2e%2fpackage.json'
  ];
  for (const pathname of attempts) {
    const res = await request('GET', pathname);
    assert.ok(res.status === 403 || res.status === 404, `${pathname} 应被拦截，实际 ${res.status}`);
    assert.doesNotMatch(res.body, new RegExp(SECRET_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${pathname} 不应泄露 package.json`);
  }
});

test('POST /api/collect 立即确认（202）', async () => {
  const res = await request('POST', '/api/collect');
  assert.equal(res.status, 202);
  const data = jsonOf(res);
  assert.equal(data.accepted, true);
  assert.ok(['background', 'already_running'].includes(data.collection));
});

test('错误请求方法返回 405，非法 JSON 返回 400', async () => {
  const method = await request('POST', '/api/health');
  assert.equal(method.status, 405);
  assert.ok(jsonOf(method).error);

  const badJson = await request('POST', '/api/architecture-reviews', { body: 'not-json{' });
  assert.equal(badJson.status, 400);
  assert.match(jsonOf(badJson).error, /请求格式无效/);
});

test('空 skillIds 的架构评审请求返回 400 且不调用外部服务', async () => {
  const res = await request('POST', '/api/architecture-reviews', { body: JSON.stringify({ skillIds: [] }) });
  assert.equal(res.status, 400);
  assert.match(jsonOf(res).error, /请至少选择一个/);
});

test('不存在的 Issue / 返工 Issue 详情返回 404', async () => {
  const issue = await request('GET', '/api/issues/does-not-exist');
  assert.equal(issue.status, 404);

  const rework = await request('GET', '/api/rework-issues/does-not-exist');
  assert.equal(rework.status, 404);
});
