import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fork } from 'node:child_process';
import { config } from './config.js';
import { darwinReviewPlan, db, healthTrend, issueDetail, issueRunMessage, latestSnapshot, multicaArchitectureReviewJobs, recentCollections, reworkIssueDetail, saveDarwinReviewPlan, saveMulticaArchitectureReviewIssue } from './db.js';
import { buildDarwinReviewPlan, confirmDarwinReviewPlan } from './darwin-review-plan.js';
import { createIssue, downloadAttachmentText, getIssue, getSkillDetail, listIssueComments } from './multica.js';
import { measurementRulesPayload } from './measurement-rules.js';
import { snapshotView } from './snapshot-view.js';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

let collectorProcess = null;
let collectorRunning = false;
function architectureReviewSummary(snapshot = latestSnapshot()) {
  // Mirror the Skill page's default operational scope: only Skills with
  // explicit calls in the recent granular-production window are reviewable
  // from this workbench. The 98-item association directory remains separate.
  const assessments = (snapshot?.skills?.assessments ?? []).filter((skill) => Number(skill.observedCalls ?? 0) > 0);
  const latestJobBySkill = new Map();
  for (const job of multicaArchitectureReviewJobs()) {
    if (!latestJobBySkill.has(job.skillId)) latestJobBySkill.set(job.skillId, job);
  }
  return assessments.map((skill) => {
    const independent = skill.darwin?.architectureReview ?? null;
    const plan = darwinReviewPlan(skill.id);
    const reviewedAt = independent?.source?.updatedAt ?? null;
    return {
      id: skill.id,
      name: skill.name,
      observedCalls: skill.observedCalls ?? 0,
      independentReview: independent ? {
        reviewedAt: independent.source?.updatedAt ?? null,
        source: independent.source?.fileName ?? '独立评审文档',
        score: independent.architectureScore ?? null
      } : null,
      reviewPlan: plan ? { status: plan.status, updatedAt: plan.confirmedAt ?? plan.generatedAt, promptCount: plan.prompts?.length ?? 0 } : null,
      multicaReview: latestJobBySkill.get(skill.id) ?? null,
      reviewedAt
    };
  }).sort((left, right) => Number(right.observedCalls) - Number(left.observedCalls) || left.name.localeCompare(right.name, 'zh-CN'));
}

function issueUrl(issue) {
  const id = issue.id ?? issue.identifier;
  return id ? `https://agent.new.ndhy.com/rpg2/issues/${encodeURIComponent(id)}` : null;
}

function reviewIssueDescription({ batchId, skills }) {
  const sections = skills.map((skill, index) => `## ${index + 1}. ${skill.name}

- Skill ID：\`${skill.id}\`
- Skill 更新时间：${skill.sourceUpdatedAt ?? '未提供'}
- 已确认测试 Prompt：${skill.plan.prompts.length} 条
${skill.plan.prompts.map((prompt, promptIndex) => `  ${promptIndex + 1}. **${prompt.label}**\n     - Prompt：${prompt.prompt}\n     - 预期：${prompt.expected}`).join('\n')}`).join('\n\n');
  return `# 完成skill架构评审

评审批次：\`${batchId}\`

## 执行合约

- 必须加载已发布的 \`darwin-skill-architecture-review@1.0.0\`。
- 对每个列出的 Skill 创建一个子 Issue，指派给 \`Darwin 独立 Judge\`；执行官不得替 Judge 给分。
- 每个 Skill 单独生成一份 Markdown 评审文档，并在本主 Issue 单独评论、作为附件上传；附件可下载。
- 文档必须包含：结论、范围与运行态、9 维分数及依据、运行时 Gate、实测或 dry_run 说明、P0–P3 发现/动作/验收、证据链接与限制。
- 不能完成实测时必须写 \`dry_run\`，不得伪称 \`full_test\`。缺失 Judge、证据或附件时 fail-closed 并报告 blocker。
- 只读评审：不得修改被评审 Skill、Agent、绑定、发布状态或生产配置；不得创建生产任务。

## 评审清单

${sections}

## 主 Issue 收尾格式

逐 Skill 评论附件完成后，汇总成功、失败、评审模式、Judge 子 Issue、附件与后续 owner；部分失败不得标记批次成功。`;
}

function commentsFromResponse(response) {
  if (Array.isArray(response)) return response;
  return response?.comments ?? response?.items ?? response?.threads ?? [];
}

function parseReviewDelivery(comments) {
  const content = comments.map((comment) => String(comment.content ?? comment.body ?? '')).join('\n');
  const attachments = comments.flatMap((comment) => comment.attachments ?? comment.files ?? []);
  const markdownAttachments = attachments.filter((attachment) => /\.md(?:$|\?)/i.test(String(attachment.filename ?? attachment.name ?? attachment.file_name ?? attachment.markdown_url ?? attachment.url ?? '')));
  return {
    delivered: markdownAttachments.length > 0,
    markdownAttachments: markdownAttachments.map((attachment) => ({
      id: attachment.id ?? null,
      name: attachment.filename ?? attachment.name ?? attachment.file_name ?? '评审文档',
      url: attachment.markdown_url ?? attachment.download_url ?? attachment.downloadUrl ?? attachment.url ?? null
    })),
    summary: content.match(/结论[：:]\s*([^\n]+)/)?.[1]?.trim()
      ?? content.match(/运行时\s*Blocker[\s\S]{0,600}/i)?.[0]?.replace(/\s+/g, ' ').trim()
      ?? null
  };
}

async function refreshMulticaReviewIssue(job) {
  try {
    const issue = await getIssue(job.issue.id);
    const comments = commentsFromResponse(await listIssueComments(job.issue.id));
    const delivery = parseReviewDelivery(comments);
    const latestDocument = delivery.markdownAttachments.at(-1);
    if (latestDocument?.id) {
      try {
        delivery.document = {
          name: latestDocument.name,
          content: await downloadAttachmentText(latestDocument.id)
        };
      } catch (error) {
        delivery.documentError = error.message;
      }
    }
    saveMulticaArchitectureReviewIssue({
      ...issue,
      id: issue.id ?? job.issue.id,
      batchId: job.issue.batchId ?? job.issue.id,
      url: issueUrl(issue),
      raw: issue
    }, [{
      id: job.skillId,
      name: job.skillName,
      sourceUpdatedAt: job.sourceUpdatedAt,
      plan: { ...job.plan, delivery }
    }]);
    return { ...job, issue: { ...job.issue, status: issue.status ?? job.issue.status, url: issueUrl(issue), updatedAt: issue.updated_at ?? job.issue.updatedAt }, delivery };
  } catch (error) {
    return { ...job, refreshError: error.message };
  }
}

function startCollection() {
  if (collectorRunning) return false;
  collectorRunning = true;
  collectorProcess = fork(new URL('./collector.js', import.meta.url), [], { silent: true, windowsHide: true });
  collectorProcess.stderr?.on('data', (chunk) => console.error(`[collector] ${chunk}`));
  collectorProcess.on('error', (error) => console.error(`[collector] ${error.message}`));
  collectorProcess.on('exit', (code) => {
    if (code) console.error(`[collector] exited with code ${code}`);
    collectorProcess = null;
    collectorRunning = false;
  });
  return true;
}

async function staticFile(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(config.publicPath, `.${requested}`);
  if (!target.startsWith(config.publicPath)) {
    json(response, 403, { error: '不允许访问此路径。' });
    return;
  }
  try {
    const body = await fs.readFile(target);
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(body);
  } catch (error) {
    json(response, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? '页面不存在。' : error.message });
  }
}

async function route(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const page = url.searchParams.get('page') ?? 'overview';
    return json(response, 200, {
      snapshot: snapshotView(latestSnapshot(), page),
      localTime: new Date().toISOString(),
      refreshIntervalMs: config.collectionIntervalMs
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/collections') {
    return json(response, 200, { collections: recentCollections() });
  }
  if (request.method === 'GET' && url.pathname === '/api/measurement-rules') {
    return json(response, 200, { rules: measurementRulesPayload() });
  }
  if (request.method === 'GET' && url.pathname === '/api/health-trend') {
    return json(response, 200, { trend: healthTrend(url.searchParams.get('hours')) });
  }
  if (request.method === 'GET' && url.pathname === '/api/architecture-reviews') {
    const skillId = url.searchParams.get('skillId') ?? url.searchParams.get('id');
    if (url.searchParams.get('view') === 'work-items') {
      const jobs = multicaArchitectureReviewJobs();
      const refreshed = await Promise.all(jobs.map(refreshMulticaReviewIssue));
      return json(response, 200, { items: refreshed });
    }
    if (skillId) {
      const item = architectureReviewSummary().find((candidate) => candidate.id === skillId);
      if (!item) return json(response, 404, { error: '当前 Skill 列表中未找到该对象。' });
      return json(response, 200, { item, reviewPlan: darwinReviewPlan(skillId) });
    }
    return json(response, 200, { items: architectureReviewSummary() });
  }
  if (request.method === 'POST' && url.pathname === '/api/architecture-reviews' && url.searchParams.get('action') !== 'issues') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let requestedIds;
    try {
      requestedIds = JSON.parse(body || '{}').skillIds;
    } catch {
      return json(response, 400, { error: '请求格式无效。' });
    }
    const available = new Set(architectureReviewSummary().map((item) => item.id));
    const skillIds = [...new Set(Array.isArray(requestedIds) ? requestedIds.filter((id) => available.has(id)) : [])];
    if (!skillIds.length) return json(response, 400, { error: '请至少选择一个当前列表中的 Skill。' });
    const plans = [];
    for (const skillId of skillIds) {
      const detail = await getSkillDetail(skillId);
      const plan = buildDarwinReviewPlan(detail);
      saveDarwinReviewPlan(skillId, plan);
      plans.push(plan);
    }
    return json(response, 200, { plans });
  }
  if (request.method === 'POST' && url.pathname === '/api/architecture-reviews' && url.searchParams.get('action') === 'issues') {
    let body = '';
    for await (const chunk of request) body += chunk;
    let requestedIds;
    try {
      requestedIds = JSON.parse(body || '{}').skillIds;
    } catch {
      return json(response, 400, { error: '请求格式无效。' });
    }
    const available = new Map(architectureReviewSummary().map((item) => [item.id, item]));
    const skillIds = [...new Set(Array.isArray(requestedIds) ? requestedIds.filter((id) => available.has(id)) : [])];
    if (!skillIds.length) return json(response, 400, { error: '请至少选择一个当前列表中的 Skill。' });
    const skills = [];
    for (const skillId of skillIds) {
      const item = available.get(skillId);
      const plan = darwinReviewPlan(skillId);
      if (plan?.status !== 'confirmed' || (plan.prompts?.length ?? 0) < 2) {
        return json(response, 400, { error: `${item.name} 的测试 Prompt 尚未确认；不能创建评审 Issue。` });
      }
      const detail = await getSkillDetail(skillId);
      skills.push({ id: skillId, name: item.name, sourceUpdatedAt: detail.updated_at ?? plan.sourceUpdatedAt ?? null, plan });
    }
    const batchId = `darwin-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
    const created = await createIssue({
      title: '完成skill架构评审',
      description: reviewIssueDescription({ batchId, skills }),
      assigneeId: config.darwinArchitectureReviewExecutorId
    });
    const issue = created.issue ?? created;
    if (!issue?.id) throw new Error('Multica 未返回已创建 Issue 的 ID。');
    const record = {
      ...issue,
      batchId,
      url: issueUrl(issue),
      raw: issue
    };
    saveMulticaArchitectureReviewIssue(record, skills);
    return json(response, 201, { issue: { id: issue.id, identifier: issue.identifier ?? null, status: issue.status ?? 'todo', url: record.url }, batchId, skillCount: skills.length });
  }
  if (request.method === 'PUT' && url.pathname === '/api/architecture-reviews') {
    const skillId = url.searchParams.get('skillId') ?? url.searchParams.get('id');
    if (!skillId) return json(response, 400, { error: '缺少 Skill ID。' });
    const item = architectureReviewSummary().find((candidate) => candidate.id === skillId);
    if (!item) return json(response, 404, { error: '当前 Skill 列表中未找到该对象。' });
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const payload = JSON.parse(body || '{}');
      const previous = darwinReviewPlan(skillId) ?? { ...buildDarwinReviewPlan({ id: skillId, name: item.name }), skillId, skillName: item.name };
      const plan = confirmDarwinReviewPlan(previous, payload.prompts);
      saveDarwinReviewPlan(skillId, plan);
      return json(response, 200, { plan });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/rework-issues/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/rework-issues/'.length));
    const detail = reworkIssueDetail(id);
    return detail ? json(response, 200, { item: detail }) : json(response, 404, { error: '当前快照未识别到该返工 Issue。' });
  }
  const runMessageMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/messages\/([^/]+)$/);
  if (request.method === 'GET' && runMessageMatch) {
    const issueId = decodeURIComponent(runMessageMatch[1]);
    const runId = decodeURIComponent(runMessageMatch[2]);
    const message = issueRunMessage(issueId, runId);
    return message ? json(response, 200, message) : json(response, 404, { error: '本地数据中未找到该 Run 消息。' });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/issues/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/issues/'.length));
    const detail = issueDetail(id);
    return detail ? json(response, 200, detail) : json(response, 404, { error: '本地数据库尚未采集到此 Issue。' });
  }
  if (request.method === 'POST' && url.pathname === '/api/collect') {
    // Collection involves a full read-only workspace scan.  Keep the UI
    // responsive: the browser can poll collection state while this continues
    // in the background, then refresh the local snapshot when it completes.
    // Defer to the next event-loop turn so SQLite setup and CLI process launch
    // cannot delay this acknowledgement.
    const started = startCollection();
    return json(response, 202, { accepted: true, collection: started ? 'background' : 'already_running' });
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    return json(response, 200, { ok: true, database: config.dataPath, latestSnapshotAt: latestSnapshot()?.generatedAt ?? null });
  }
  if (request.method === 'GET') return staticFile(response, url.pathname);
  return json(response, 405, { error: '不支持的请求方法。' });
}

async function main() {
  db();
  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      console.error(error);
      json(response, 500, { error: '服务器内部错误。', detail: error.message });
    });
  });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`教育互动游戏生产线健康度检测台已启动：http://127.0.0.1:${config.port}`);
    console.log(`采集间隔：${Math.round(config.collectionIntervalMs / 1000)} 秒（只读 Multica）。`);
  });
  // Serve the last successful local snapshot immediately.  A cold start still
  // collects in the background, rather than making the UI wait for a full
  // workspace scan before the HTTP listener exists.
  startCollection();
  setInterval(() => {
    startCollection();
  }, config.collectionIntervalMs).unref();
}

main();
