import { mongodb } from '@fn/mongodb';
import { gunzipSync } from 'node:zlib';
import { config } from '../src/config.js';
import { buildDarwinReviewPlan, confirmDarwinReviewPlan } from '../src/darwin-review-plan.js';
import { createIssue, getIssue, getSkillDetail, listIssueComments, downloadAttachmentText } from '../src/multica.js';
import { loadArchitectureReviews, loadDarwinReviewPlans, loadMulticaReviewJobs, saveDarwinReviewPlan, saveMulticaReviewJob } from './_store';

// Single flat route file: the FN platform maps api/<name>.ts to /api/<name>
// and dispatches on the exported method. Sub-resources ride on query params,
// the same proven pattern as api/issue.ts and api/rework-issue.ts.

// A page projection is the lightest cloud source for the current Skill list.
// The skills page snapshot already carries the squad-scoped assessments that
// the local workbench mirrors (only Skills with observed explicit calls).
const currentPages = mongodb.collection<any>('health_current_pages_v3');

async function currentSkillAssessments() {
  const current = await currentPages.findOne({ id: 'skills' });
  if (!current?.snapshotGzipBase64) return [];
  const snapshot = JSON.parse(gunzipSync(Buffer.from(current.snapshotGzipBase64, 'base64')).toString('utf8'));
  return (snapshot?.skills?.assessments ?? []).filter((skill: any) => Number(skill.observedCalls ?? 0) > 0);
}

function issueUrl(issue: any) {
  const id = issue.id ?? issue.identifier;
  return id ? `https://agent.new.ndhy.com/rpg2/issues/${encodeURIComponent(id)}` : null;
}

function commentsFromResponse(response: any) {
  if (Array.isArray(response)) return response;
  return response?.comments ?? response?.items ?? response?.threads ?? [];
}

function parseReviewDelivery(comments: any[]) {
  const content = comments.map((comment) => String(comment.content ?? comment.body ?? '')).join('\n');
  const attachments = comments.flatMap((comment) => comment.attachments ?? comment.files ?? []);
  const markdownAttachments = attachments.filter((attachment: any) => /\.md(?:$|\?)/i.test(String(attachment.filename ?? attachment.name ?? attachment.file_name ?? attachment.markdown_url ?? attachment.url ?? '')));
  return {
    delivered: markdownAttachments.length > 0,
    markdownAttachments: markdownAttachments.map((attachment: any) => ({
      id: attachment.id ?? null,
      name: attachment.filename ?? attachment.name ?? attachment.file_name ?? '评审文档',
      url: attachment.markdown_url ?? attachment.download_url ?? attachment.downloadUrl ?? attachment.url ?? null
    })),
    summary: content.match(/结论[：:]\s*([^\n]+)/)?.[1]?.trim()
      ?? content.match(/运行时\s*Blocker[\s\S]{0,600}/i)?.[0]?.replace(/\s+/g, ' ').trim()
      ?? null
  };
}

async function refreshMulticaReviewIssue(job: any) {
  try {
    const issue = await getIssue(job.issue.id);
    const comments = commentsFromResponse(await listIssueComments(job.issue.id));
    const delivery = parseReviewDelivery(comments);
    const latestDocument = delivery.markdownAttachments.at(-1);
    if (latestDocument?.id) {
      try {
        delivery.document = { name: latestDocument.name, content: await downloadAttachmentText(latestDocument.id) };
      } catch (error: any) {
        delivery.documentError = error.message;
      }
    }
    const updated = {
      ...job,
      issue: {
        ...job.issue,
        id: issue.id ?? job.issue.id,
        identifier: issue.identifier ?? job.issue.identifier,
        status: issue.status ?? job.issue.status,
        url: issueUrl(issue) ?? job.issue.url
      },
      plan: { ...job.plan, delivery }
    };
    await saveMulticaReviewJob({ issue: updated.issue, skills: (updated.skills ?? []).map((skill: any) => ({ ...skill, plan: updated.plan ?? skill.plan })) });
    return updated;
  } catch (error: any) {
    return { ...job, refreshError: error.message };
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const view = params.get('view');
  const skillId = params.get('skillId') ?? params.get('id');

  // GET ?view=work-items → refresh Multica review jobs (valid empty state when
  // the cloud has no jobs yet, never a failure).
  if (view === 'work-items') {
    const jobs = await loadMulticaReviewJobs();
    const refreshed = await Promise.all(jobs.map(refreshMulticaReviewIssue));
    return Response.json({ items: refreshed });
  }

  // GET ?skillId=<id> → single-Skill detail, decorated exactly like the list
  // rows so the detail dialog can render independent-review, prompt-plan and
  // Multica-job state without a second list fetch.
  if (skillId) {
    const [assessments, reviews, plans, jobs] = await Promise.all([
      currentSkillAssessments(), loadArchitectureReviews(), loadDarwinReviewPlans(), loadMulticaReviewJobs()
    ]);
    const skill = assessments.find((candidate: any) => candidate.id === skillId);
    if (!skill) return Response.json({ error: '当前 Skill 列表中未找到该对象。' }, { status: 404 });
    const independent = reviews.get(skillId) ?? skill.darwin?.architectureReview ?? null;
    const job = jobs.find((candidate: any) => candidate.skillId === skillId);
    const item = {
      ...skill,
      independentReview: independent ? {
        reviewedAt: independent.source?.updatedAt ?? independent.importedAt ?? null,
        source: independent.source?.fileName ?? '独立评审文档',
        score: independent.architectureScore ?? null
      } : null,
      multicaReview: job?.issue ? { issue: job.issue, plan: { delivery: null } } : null,
      reviewedAt: independent?.source?.updatedAt ?? independent?.importedAt ?? null
    };
    return Response.json({ item, reviewPlan: plans.get(skillId) ?? null });
  }

  // GET → reviewable list, decorated with independent-review, prompt-plan and
  // Multica-job state (mirrors the local workbench's read path).
  const [assessments, reviews, plans, jobs] = await Promise.all([
    currentSkillAssessments(), loadArchitectureReviews(), loadDarwinReviewPlans(), loadMulticaReviewJobs()
  ]);
  const reviewBySkill = new Map(reviews.entries());
  const latestJobBySkill = new Map(jobs.map((job: any) => [job.skillId, job]));
  const items = assessments.map((skill: any) => {
    const independent = reviewBySkill.get(skill.id) ?? skill.darwin?.architectureReview ?? null;
    const plan = plans.get(skill.id);
    const job = latestJobBySkill.get(skill.id);
    return {
      id: skill.id,
      name: skill.name,
      observedCalls: skill.observedCalls ?? 0,
      independentReview: independent ? {
        reviewedAt: independent.source?.updatedAt ?? independent.importedAt ?? null,
        source: independent.source?.fileName ?? '独立评审文档',
        score: independent.architectureScore ?? null
      } : null,
      reviewPlan: plan ? { status: plan.status, updatedAt: plan.confirmedAt ?? plan.generatedAt, promptCount: plan.prompts?.length ?? 0 } : null,
      multicaReview: job?.issue ? { issue: job.issue, plan: { delivery: null } } : null,
      reviewedAt: independent?.source?.updatedAt ?? independent?.importedAt ?? null
    };
  }).sort((left: any, right: any) => Number(right.observedCalls) - Number(left.observedCalls) || left.name.localeCompare(right.name, 'zh-CN'));
  return Response.json({ items });
}

function reviewIssueDescription({ batchId, skills }: any) {
  const sections = skills.map((skill: any, index: number) => `## ${index + 1}. ${skill.name}

- Skill ID：\`${skill.id}\`
- Skill 更新时间：${skill.sourceUpdatedAt ?? '未提供'}
- 已确认测试 Prompt：${skill.plan.prompts.length} 条
${skill.plan.prompts.map((prompt: any, promptIndex: number) => `  ${promptIndex + 1}. **${prompt.label}**\n     - Prompt：${prompt.prompt}\n     - 预期：${prompt.expected}`).join('\n')}`).join('\n\n');
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

export async function POST(request: Request) {
  const url = new URL(request.url);
  let body: any = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const requestedIds = Array.isArray(body.skillIds) ? body.skillIds : [];

  // POST ?action=issues → create the governed Multica review Issue.
  if (url.searchParams.get('action') === 'issues') {
    const [assessments, plans] = await Promise.all([currentSkillAssessments(), loadDarwinReviewPlans()]);
    const available = new Map(assessments.map((skill: any) => [skill.id, skill]));
    const skillIds = [...new Set(requestedIds.filter((id: string) => available.has(id)))];
    if (!skillIds.length) return Response.json({ error: '请至少选择一个当前列表中的 Skill。' }, { status: 400 });
    const skills = [];
    for (const skillId of skillIds) {
      const item = available.get(skillId);
      const plan = plans.get(skillId);
      if (plan?.status !== 'confirmed' || (plan.prompts?.length ?? 0) < 2) {
        return Response.json({ error: `${item.name} 的测试 Prompt 尚未确认；不能创建评审 Issue。` }, { status: 400 });
      }
      const detail = await getSkillDetail(skillId);
      skills.push({ id: skillId, name: item.name, sourceUpdatedAt: detail.updated_at ?? plan.sourceUpdatedAt ?? null, plan });
    }
    const batchId = `darwin-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
    const description = reviewIssueDescription({ batchId, skills });
    const created = await createIssue({ title: '完成skill架构评审', description, assigneeId: config.darwinArchitectureReviewExecutorId });
    const issue = created.issue ?? created;
    if (!issue?.id) throw new Error('Multica 未返回已创建 Issue 的 ID。');
    const record = { ...issue, batchId, url: issueUrl(issue), raw: issue };
    await saveMulticaReviewJob({ issue: record, skills });
    return Response.json({ issue: { id: issue.id, identifier: issue.identifier ?? null, status: issue.status ?? 'todo', url: record.url }, batchId, skillCount: skills.length }, { status: 201 });
  }

  // Default POST → design test-prompt drafts for the selected Skills.
  const [assessments, plans] = await Promise.all([currentSkillAssessments(), loadDarwinReviewPlans()]);
  const available = new Map(assessments.map((skill: any) => [skill.id, skill]));
  const skillIds = [...new Set(requestedIds.filter((id: string) => available.has(id)))];
  if (!skillIds.length) return Response.json({ error: '请至少选择一个当前列表中的 Skill。' }, { status: 400 });
  const drafts = [];
  for (const skillId of skillIds) {
    const item = available.get(skillId);
    const detail = await getSkillDetail(skillId);
    const plan = buildDarwinReviewPlan({ ...detail, id: skillId, name: item.name });
    await saveDarwinReviewPlan({ skillId, plan });
    drafts.push({ ...plan, status: plans.get(skillId)?.status === 'confirmed' ? 'confirmed' : plan.status });
  }
  return Response.json({ plans: drafts });
}

export async function PUT(request: Request) {
  const url = new URL(request.url);
  const skillId = url.searchParams.get('skillId') ?? url.searchParams.get('id');
  if (!skillId) return Response.json({ error: '缺少 Skill ID。' }, { status: 400 });
  let body: any = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const [assessments, plans] = await Promise.all([currentSkillAssessments(), loadDarwinReviewPlans()]);
  const item = assessments.find((candidate: any) => candidate.id === skillId);
  if (!item) return Response.json({ error: '当前 Skill 列表中未找到该对象。' }, { status: 404 });
  try {
    const previous = plans.get(skillId) ?? { ...buildDarwinReviewPlan({ id: skillId, name: item.name }), skillId, skillName: item.name };
    const plan = confirmDarwinReviewPlan(previous, body.prompts);
    await saveDarwinReviewPlan({ skillId, plan });
    return Response.json({ plan });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
