import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import OpenAI from 'openai'
import { generateLevel, interpretPrompt, LevelIntentSchema, type LevelIntent } from '@hog/level-engine'
import { z } from 'zod'

const GenerateRequestSchema = z.object({ prompt: z.string().trim().min(1).max(500), seed: z.string().trim().min(1).max(80).optional(), mode: z.enum(['mock', 'openai']).optional() })
const EventSchema = z.object({ name: z.enum(['level_start', 'item_found', 'wrong_click', 'hint_used', 'level_complete']), levelId: z.string(), ts: z.number(), props: z.record(z.string(), z.unknown()).default({}) })
const EventBatchSchema = z.object({ sessionId: z.string().min(1), events: z.array(EventSchema).max(100) })
const CommissionStageSchema = z.enum(['understanding', 'outline', 'gameplay', 'narrative', 'resources', 'code'])
const StoryTemplateProfileSchema = z.object({
  id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(80), playerRole: z.string().trim().min(1).max(200),
  narrativeEngine: z.string().trim().min(1).max(300), storyGoal: z.string().trim().min(1).max(200), objectSemantics: z.string().trim().min(1).max(300),
  gameplayHook: z.string().trim().min(1).max(300), hintTone: z.string().trim().min(1).max(240), endingPattern: z.string().trim().min(1).max(240),
})
const CommissionDraftSchema = z.object({
  templateId: z.string().trim().min(1).max(80).optional(), templateProfile: StoryTemplateProfileSchema.optional(), visualDirection: z.string().trim().min(1).max(500).optional(),
  theme: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(500), length: z.union([z.literal(1), z.literal(3), z.literal(5)]),
  objectCount: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]), difficulty: z.enum(['轻松', '标准', '隐蔽']), style: z.string().trim().min(1).max(80),
  uploads: z.array(z.object({ name: z.string().max(200), purpose: z.enum(['场景原图', '风格参考', '指定物件']) })).max(8).default([]),
})
const CommissionRequestSchema = z.object({ stage: CommissionStageSchema, draft: CommissionDraftSchema, priorOutputs: z.record(z.string(), z.string()).default({}) })
const AssetProductionRequestSchema = z.object({ prompt: z.string().trim().min(20).max(4000), label: z.string().trim().min(1).max(120) })
const AssetKindSchema = z.enum(['scene', 'cover', 'object-image', 'transition-video', 'ending-video'])
const AIHubAssetAliasSchema = z.enum(['jimeng', 'gpt-image2', 'seedance'])
const GatewayVideoModelSchema = z.enum(['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-5-260628'])
const AssetAliasSchema = z.union([AIHubAssetAliasSchema, GatewayVideoModelSchema])
const AssetProviderSchema = z.enum(['aihub', 'gateway'])
const LegacyAssetProductionBatchSchema = z.object({ commissionId: z.string().uuid(), tasks: z.array(AssetProductionRequestSchema.extend({ taskId: z.string().uuid(), chapterIndex: z.number().int().min(0).max(4), chapterTitle: z.string().trim().min(1).max(160) })).min(1).max(5) })
const AssetProductionTaskSchema = AssetProductionRequestSchema.extend({
  taskId: z.string().uuid(), assetKey: z.string().trim().min(1).max(180), assetKind: AssetKindSchema, alias: AssetAliasSchema,
  chapterIndex: z.number().int().min(-1).max(4), chapterTitle: z.string().trim().min(1).max(160), targetId: z.string().trim().min(1).max(160).optional(), targetName: z.string().trim().min(1).max(160).optional(),
})
const AssetProductionBatchSchema = z.object({ commissionId: z.string().uuid(), tasks: z.array(AssetProductionTaskSchema).min(1).max(80) })
const AssetTaskRecordSchema = z.object({
  taskId: z.string().uuid(), commissionId: z.string().uuid(), chapterIndex: z.number().int(), chapterTitle: z.string(), label: z.string(),
  assetKey: z.string().optional(), assetKind: AssetKindSchema.optional(), targetId: z.string().optional(), targetName: z.string().optional(), runId: z.string().optional(), alias: z.string().optional(), provider: AssetProviderSchema.optional(), model: z.string().optional(), status: z.string(),
  outputs: z.unknown().optional(), publicUrl: z.string().optional(), publicWidth: z.number().int().positive().optional(), publicHeight: z.number().int().positive().optional(),
  error: z.string().optional(), failurePhase: z.enum(['preflight', 'submission']).optional(), attempt: z.number().int().min(1).max(2).optional(), retryLocked: z.boolean().optional(), createdAt: z.string(), updatedAt: z.string(),
})
const SavedCommissionStateSchema = z.object({
  page: z.string().max(40),
  resumePage: z.string().max(40),
  draft: z.object({
    theme: z.string().max(80), prompt: z.string().max(500), length: z.union([z.literal(1), z.literal(3), z.literal(5)]),
    templateId: z.string().max(80).optional(),
    objectCount: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]), difficulty: z.enum(['轻松', '标准', '隐蔽']), style: z.string().max(80),
    uploads: z.array(z.object({ name: z.string().max(200), purpose: z.enum(['场景原图', '风格参考', '指定物件']), preview: z.string().max(1) })).max(8),
  }),
  chapters: z.array(z.unknown()).max(5), productionIndex: z.number().int().min(0).max(7), activeChapter: z.number().int().min(0).max(4), completedChapterIds: z.array(z.string().max(200)).max(5).optional(),
  stageOutputs: z.record(z.string(), z.unknown()), productionError: z.string().max(1000).nullable(), savedAt: z.string().datetime(),
})
const SavedCommissionRecordSchema = SavedCommissionStateSchema.extend({ id: z.string().uuid() })

export type CommissionStage = z.infer<typeof CommissionStageSchema>
export type CommissionDraft = z.infer<typeof CommissionDraftSchema>

type GenerationRecord = { id: string; prompt: string; seed: string; createdAt: string; level: ReturnType<typeof generateLevel>; provider: 'mock' | 'openai'; fallbackUsed: boolean; generationMs: number }
const dataDirectory = resolve(process.env.API_DATA_DIR ?? resolve(process.cwd(), 'data'))
const generatedAssetDirectory = resolve(process.env.GENERATED_ASSET_DIR ?? resolve(process.cwd(), '..', 'web', 'public', 'content', 'commissions'))
const generatedAssetPublicBase = (process.env.GENERATED_ASSET_PUBLIC_BASE ?? '/content/commissions').replace(/\/+$/, '') || '/content/commissions'
const recordsPath = resolve(dataDirectory, 'generated-levels.json')
const commissionDraftsPath = resolve(dataDirectory, 'commission-drafts.json')
const assetTasksPath = resolve(dataDirectory, 'aihub-asset-tasks.json')
let records: GenerationRecord[] = []
const events: Array<z.infer<typeof EventSchema> & { sessionId: string }> = []
const execFile = promisify(execFileCallback)

async function restoreRecords() {
  try { records = JSON.parse(await readFile(recordsPath, 'utf8')) as GenerationRecord[] } catch { records = [] }
}
async function saveRecords() { await mkdir(resolve(recordsPath, '..'), { recursive: true }); await writeFile(recordsPath, JSON.stringify(records.slice(0, 100), null, 2), 'utf8') }
async function readSavedCommissions() {
  try {
    const value = JSON.parse(await readFile(commissionDraftsPath, 'utf8'))
    return z.array(SavedCommissionRecordSchema).parse(value).sort((left, right) => right.savedAt.localeCompare(left.savedAt))
  } catch { return [] }
}
async function saveCommission(record: z.infer<typeof SavedCommissionRecordSchema>) {
  const existing = await readSavedCommissions()
  const records = [record, ...existing.filter((item) => item.id !== record.id)].slice(0, 30)
  await mkdir(resolve(commissionDraftsPath, '..'), { recursive: true })
  await writeFile(commissionDraftsPath, JSON.stringify(records, null, 2), 'utf8')
}
async function deleteSavedCommission(id: string) {
  const records = (await readSavedCommissions()).filter((item) => item.id !== id)
  await mkdir(resolve(commissionDraftsPath, '..'), { recursive: true })
  await writeFile(commissionDraftsPath, JSON.stringify(records, null, 2), 'utf8')
}
async function readAssetTasks() { try { return z.array(AssetTaskRecordSchema).parse(JSON.parse(await readFile(assetTasksPath, 'utf8'))) } catch { return [] } }
let assetTaskWriteQueue: Promise<void> = Promise.resolve()
function saveAssetTask(record: z.infer<typeof AssetTaskRecordSchema>) {
  const operation = assetTaskWriteQueue.then(async () => {
    const records = [record, ...(await readAssetTasks()).filter((item) => item.taskId !== record.taskId)]
    await mkdir(resolve(assetTasksPath, '..'), { recursive: true })
    await writeFile(assetTasksPath, JSON.stringify(records.slice(0, 200), null, 2), 'utf8')
  })
  assetTaskWriteQueue = operation.catch(() => undefined)
  return operation
}

class GatewayConfigurationError extends Error {}
class AssetProductionError extends Error {}
function sanitizeAssetError(message: string, alias?: string) {
  const safe = message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/bvk_[A-Za-z0-9_-]+/g, '[令牌已隐藏]')
  if (/permission|forbidden|\b403\b/i.test(safe)) {
    const logId = safe.match(/latestAiHubLogId["'\s:]+([A-Za-z0-9_-]+)/i)?.[1]
    return `AIHub 权限不足：当前 Token 无权访问 ${alias ?? '该'} 工作流。${logId ? ` 平台日志：${logId}` : ''}`
  }
  return safe.slice(0, 600)
}

function gatewayConfig() {
  const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new GatewayConfigurationError('未配置 AI_GATEWAY_API_KEY')
  const configuredBaseUrl = process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.aiae.ndhy.com/v1'
  const baseURL = configuredBaseUrl.replace(/\/$/, '').endsWith('/v1') ? configuredBaseUrl.replace(/\/$/, '') : `${configuredBaseUrl.replace(/\/$/, '')}/v1`
  return { apiKey, baseURL, model: process.env.AI_GATEWAY_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o' }
}

function gatewayClient(stage?: CommissionStage) {
  const config = gatewayConfig()
  const defaultTimeout = Number(process.env.AI_GATEWAY_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS ?? 60000)
  const timeout = stage === 'code' ? Number(process.env.AI_CODE_TIMEOUT_MS ?? 75000) : defaultTimeout
  return { config, client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout, maxRetries: stage === 'code' ? 0 : 1 }) }
}

function configuredCorsOrigin() {
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)
  return origins.length > 0 ? origins : true
}

function isGatewaySecurityBlock(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; message?: unknown }
  return candidate.status === 405 && /acw_tc|waf|tengine|security/i.test(String(candidate.message ?? ''))
}

function parseModelJson(content: string) {
  const normalized = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(normalized) as Record<string, unknown> } catch { return { text: content.trim() } }
}

function commissionInstruction(stage: CommissionStage) {
  const instructions: Record<CommissionStage, string> = {
    understanding: '理解用户一句话，但不要改写故事模板。输出 text（120字以内）、constraints（字符串数组）、extracted（含 characters、setting、goal、centralObjects）和 compatibility（match 或 conflict）。如有冲突，在 conflictSuggestion 中说明，不要静默切换模板。',
    outline: '使用 storyTemplate 的 narrativeEngine、playerRole、storyGoal 与 endingPattern 设计独立故事大纲，再用 userBrief 填充具体人物、地点和事件。输出 text 和 chapters 数组；每个 chapter 必须有 title、summary、objective。章节数严格等于 length，不得退回侦探查案结构。',
    gameplay: '保持点击寻物核心玩法，使用 storyTemplate 的 objectSemantics 与 gameplayHook 设计模板专属推进。输出 text 和 rules 数组，覆盖物件意义、章节推进、隐藏策略、提示分层、误点反馈与难度；不得根据美术风格改变玩法，也不要设计资源生产。',
    narrative: '依据故事大纲编写章节剧情，并遵守 storyTemplate 的 playerRole、hintTone 和 endingPattern。输出 text 和 chapters 数组；每个 chapter 必须有 title、caseFile、objective、hintTone，章节数严格等于 length。不要把所有类型写成调查、证物和破案。',
    resources: '只规划资源，不生产资源。视觉表现仅使用 visualStyle；剧情内容必须来自已确认的 outline 与 narrative。输出 text 和 assets 数组；每项含 type、name、purpose、source。覆盖每章场景图、每章关卡封面、寻找物件独立图、章节间过场视频、全故事结束视频、音效及导入图用途。物件项 type 使用 object_icon，至少列出 objectCount 个符合 objectSemantics 的明确名称。',
    code: '依据已确认 gameplay、narrative 与 resources 编写可交付但不执行的代码文件，不得从画风推导新玩法或改写故事类型。只输出 text 和 files 数组，最多2个文件；每项含 path、language、content，每个 content 不超过1400字符。优先输出一个关卡JSON配置和一个简短TypeScript集成文件。不得输出密钥、网络攻击代码或依赖安装脚本。直接给出JSON。',
  }
  return instructions[stage]
}

function selectPriorOutputs(priorOutputs: Record<string, string>, keys: string[]) {
  return Object.fromEntries(keys.flatMap((key) => priorOutputs[key] ? [[key, priorOutputs[key].slice(0, 2400)]] : []))
}

export function buildCommissionStageContext(stage: CommissionStage, draft: CommissionDraft, priorOutputs: Record<string, string>) {
  const story = {
    storyTemplate: draft.templateProfile ?? { id: draft.templateId ?? 'legacy', name: draft.theme },
    userBrief: draft.prompt,
    length: draft.length,
  }
  const gameplayScale = { objectCount: draft.objectCount, difficulty: draft.difficulty }
  if (stage === 'understanding') return { ...story, ...gameplayScale, uploads: draft.uploads.map(({ name, purpose }) => ({ name, purpose })) }
  if (stage === 'outline') return { ...story, priorOutputs: selectPriorOutputs(priorOutputs, ['understanding']) }
  if (stage === 'gameplay') return { ...story, ...gameplayScale, priorOutputs: selectPriorOutputs(priorOutputs, ['understanding', 'outline']) }
  if (stage === 'narrative') return { ...story, priorOutputs: selectPriorOutputs(priorOutputs, ['understanding', 'outline', 'gameplay']) }
  if (stage === 'resources') return {
    ...story,
    ...gameplayScale,
    visualStyle: { name: draft.style, direction: draft.visualDirection ?? draft.style },
    uploads: draft.uploads.map(({ name, purpose }) => ({ name, purpose })),
    priorOutputs: selectPriorOutputs(priorOutputs, ['outline', 'gameplay', 'narrative']),
  }
  return { ...story, ...gameplayScale, priorOutputs: selectPriorOutputs(priorOutputs, ['gameplay', 'narrative', 'resources']) }
}

async function generateCommissionStage(stage: CommissionStage, draft: CommissionDraft, priorOutputs: Record<string, string>) {
  const { client, config } = gatewayClient(stage)
  const context = JSON.stringify(buildCommissionStageContext(stage, draft, priorOutputs))
  const response = await client.chat.completions.create({
    model: config.model,
    max_completion_tokens: stage === 'code' ? 6000 : undefined,
    reasoning_effort: stage === 'code' ? 'low' : undefined,
    messages: [
      { role: 'developer', content: '你是中文隐藏物品寻物游戏的制作助手。只返回有效 JSON，不要 Markdown 代码围栏。严格遵守输入边界：storyTemplate 决定叙事和玩法骨架，userBrief 决定具体人物地点事件，length/objectCount/difficulty 只决定规模与难度，visualStyle 仅影响资源规划。所有剧情与固定主线独立；文本节点不能直接生产或修改图片资源。' },
      { role: 'user', content: `当前节点：${stage}。${commissionInstruction(stage)}\n委托数据：${context}` },
    ],
  })
  const content = response.choices[0]?.message.content
  if (!content) throw new Error(`模型未返回文本结果（finish_reason=${response.choices[0]?.finish_reason ?? 'unknown'}）`)
  return { stage, model: config.model, output: parseModelJson(content), rawText: content }
}

function aihubConfig() {
  const token = process.env.AIHUB_AGENT_TOKEN
  if (!token) throw new GatewayConfigurationError('未配置 AIHUB_AGENT_TOKEN')
  return { token, baseUrl: 'https://bv.new.ndhy.com/api/agent/aihub' }
}

function isVideoAssetKind(assetKind: z.infer<typeof AssetKindSchema> | undefined) {
  return assetKind === 'transition-video' || assetKind === 'ending-video'
}

function assetProvider(task: Pick<z.infer<typeof AssetTaskRecordSchema>, 'provider' | 'assetKind'>) {
  return task.provider ?? 'aihub'
}

function assetWorkflowInputs(task: z.infer<typeof AssetProductionTaskSchema>) {
  if (task.alias === 'seedance') return {
    prompt: task.prompt.slice(0, 500), Production_method: '文生视频', Video_specifications: '横屏 16:9', duration: '6', resolution: '720p', is_3d_digital_human: '否',
    image_url_list: '', video_url_list: '', audio_url_list: '',
  }
  if (task.alias === 'gpt-image2') return { prompt: task.prompt, count: 1, size: '1024x1024', quality: 'auto', background: 'transparent' }
  return {
    prompt: task.prompt, aspect_ratio: task.assetKind === 'object-image' ? '2048x2048' : task.assetKind === 'cover' ? '2304x1728' : '4096x2304', version: '即梦5.0', is_expert: '否', count: 1,
  }
}

async function startAIHubAsset(alias: z.infer<typeof AIHubAssetAliasSchema>, inputs: Record<string, unknown>, label: string) {
  aihubConfig()
  const scriptPath = resolve(process.cwd(), 'scripts', 'start-aihub-asset.ps1')
  const requestDirectory = resolve(process.cwd(), 'data', '.aihub-requests')
  const requestPath = resolve(requestDirectory, `${randomUUID()}.json`)
  try {
    await mkdir(requestDirectory, { recursive: true })
    await writeFile(requestPath, JSON.stringify({ alias, inputs, label }), 'utf8')
    const powershellPath = process.env.AIHUB_POWERSHELL_PATH ?? 'pwsh.exe'
    const { stdout } = await execFile(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-InputPath', requestPath], { env: process.env, timeout: 30000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    const result = stdout.trim().split(/\r?\n/).reverse().map((line) => {
      try { return JSON.parse(line) as { runId?: string; alias?: string; status?: string; error?: string } } catch { return undefined }
    }).find(Boolean)
    if (!result) throw new AssetProductionError('AIHub 未返回可解析的工作流结果')
    if (result.error) throw new AssetProductionError(sanitizeAssetError(result.error))
    if (!result.runId) throw new AssetProductionError('AIHub 返回缺少 runId')
    return { runId: result.runId, alias: result.alias ?? alias, status: result.status ?? 'queued' }
  } catch (error) {
    if (error instanceof AssetProductionError) throw error
    const outputText = (key: 'stdout' | 'stderr') => {
      if (typeof error !== 'object' || error === null || !(key in error)) return ''
      const value = (error as Record<string, unknown>)[key]
      return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : ''
    }
    const diagnostic = `${outputText('stderr')}\n${outputText('stdout')}`.match(/AIHUB_ERROR_JSON:(\{.*\})/)
    if (diagnostic?.[1]) {
      try {
        const result = JSON.parse(diagnostic[1]) as { error?: string }
        if (result.error) throw new AssetProductionError(sanitizeAssetError(result.error, alias))
      } catch (parseError) {
        if (parseError instanceof AssetProductionError) throw parseError
      }
    }
    const exitCode = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? 'unknown') : 'unknown'
    throw new AssetProductionError(`AIHub 启动进程异常（退出码 ${exitCode}），未创建任务号。`)
  } finally {
    await unlink(requestPath).catch(() => undefined)
  }
}

function normalizeGatewayVideoStatus(value: unknown) {
  const status = String(value ?? '').toLowerCase()
  if (['done', 'succeeded', 'success', 'completed'].includes(status)) return 'succeeded'
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed'
  if (['running', 'processing', 'in_progress', 'in-progress'].includes(status)) return 'running'
  return 'queued'
}

function gatewayVideoModel(alias?: string) {
  const configured = process.env.AI_GATEWAY_VIDEO_MODEL
  return GatewayVideoModelSchema.parse(configured || (GatewayVideoModelSchema.safeParse(alias).success ? alias : 'doubao-seedance-2-0-260128'))
}

async function startGatewayVideoAsset(task: z.infer<typeof AssetProductionTaskSchema>) {
  const config = gatewayConfig()
  const model = gatewayVideoModel(task.alias)
  const response = await fetch(`${config.baseURL}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      content: [{ type: 'text', text: task.prompt.slice(0, 500) }],
      ratio: '16:9',
      resolution: '720p',
      duration: 6,
      generate_audio: false,
      watermark: false,
    }),
  })
  const rawText = await response.text()
  let result: Record<string, unknown> = {}
  try { result = JSON.parse(rawText) as Record<string, unknown> } catch { /* handled below */ }
  if (!response.ok) {
    const detail = typeof result.error === 'object' && result.error !== null && 'message' in result.error
      ? String((result.error as { message?: unknown }).message ?? '')
      : typeof result.error === 'string' ? result.error : rawText
    throw new AssetProductionError(`视频网关提交失败 (${response.status})：${detail.slice(0, 300)}`)
  }
  const runId = [result.task_id, result.id].find((value): value is string => typeof value === 'string' && value.length > 0)
  if (!runId) throw new AssetProductionError('视频网关返回缺少任务号')
  return { runId, alias: model, model, provider: 'gateway' as const, status: normalizeGatewayVideoStatus(result.status), outputs: result }
}

function startSceneAsset(prompt: string, label: string) {
  return startAIHubAsset('jimeng', { prompt, aspect_ratio: '4096x2304', version: '即梦5.0', is_expert: '否', count: 1 }, label)
}

type AssetTaskRecord = z.infer<typeof AssetTaskRecordSchema>
const assetSubmissionLocks = new Map<string, Promise<AssetTaskRecord>>()

function submitAssetTask(commissionId: string, task: z.infer<typeof AssetProductionBatchSchema>['tasks'][number]) {
  const logicalKey = `${commissionId}:${task.assetKey}`
  const inFlight = assetSubmissionLocks.get(logicalKey)
  if (inFlight) return inFlight
  const operation = (async (): Promise<AssetTaskRecord> => {
    const provider = isVideoAssetKind(task.assetKind) ? 'gateway' as const : 'aihub' as const
    const previous = (await readAssetTasks())
      .filter((item) => item.commissionId === commissionId && (item.assetKey ?? `chapter-${item.chapterIndex + 1}-scene`) === task.assetKey)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const sameProvider = previous.filter((item) => assetProvider(item) === provider)
    const reusable = sameProvider.find((item) => ['submitting', 'queued', 'running', 'succeeded'].includes(item.status))
    if (reusable) {
      try { return await refreshAssetTask(reusable) } catch { return reusable }
    }
    const submissionAttempts = sameProvider.filter((item) => typeof item.attempt === 'number')
    if (submissionAttempts.length >= 2) return { ...submissionAttempts[0], retryLocked: true, error: `${submissionAttempts[0].error ?? '本章节提交失败'} 已达到一次重试上限，未再次提交。` }

    const createdAt = new Date().toISOString()
    const attempt = submissionAttempts.length + 1
    const model = provider === 'gateway' ? gatewayVideoModel(task.alias) : undefined
    const submitting: AssetTaskRecord = { taskId: task.taskId, commissionId, chapterIndex: task.chapterIndex, chapterTitle: task.chapterTitle, label: task.label, assetKey: task.assetKey, assetKind: task.assetKind, targetId: task.targetId, targetName: task.targetName, alias: provider === 'gateway' ? model : task.alias, provider, model, status: 'submitting', attempt, createdAt, updatedAt: createdAt }
    await saveAssetTask(submitting)
    try {
      const started = provider === 'gateway'
        ? await startGatewayVideoAsset(task)
        : await startAIHubAsset(AIHubAssetAliasSchema.parse(task.alias), assetWorkflowInputs(task), task.label)
      const record: AssetTaskRecord = { ...submitting, ...started, updatedAt: new Date().toISOString() }
      await saveAssetTask(record)
      return record
    } catch (error) {
      const record: AssetTaskRecord = { ...submitting, status: 'failed', error: error instanceof Error ? error.message : `${provider === 'gateway' ? '视频网关' : 'AIHub'}子任务提交失败`, failurePhase: 'submission', retryLocked: attempt >= 2, updatedAt: new Date().toISOString() }
      await saveAssetTask(record)
      return record
    }
  })().finally(() => assetSubmissionLocks.delete(logicalKey))
  assetSubmissionLocks.set(logicalKey, operation)
  return operation
}

async function getAssetRun(runId: string) {
  const config = aihubConfig()
  const response = await fetch(`${config.baseUrl}/workflows/runs/${encodeURIComponent(runId)}`, { headers: { Authorization: `Bearer ${config.token}` } })
  if (!response.ok) throw new Error(`AIHub 状态查询失败 (${response.status})`)
  const status = await response.json() as Record<string, unknown> & { status?: string }
  if (status.status !== 'succeeded') return status
  const outputsResponse = await fetch(`${config.baseUrl}/workflows/runs/${encodeURIComponent(runId)}/outputs`, { headers: { Authorization: `Bearer ${config.token}` } })
  return { ...status, outputs: outputsResponse.ok ? await outputsResponse.json() : undefined }
}

async function getGatewayVideoRun(runId: string) {
  const config = gatewayConfig()
  const response = await fetch(`${config.baseURL}/predictions/${encodeURIComponent(runId)}`, { headers: { Authorization: `Bearer ${config.apiKey}` } })
  const rawText = await response.text()
  let result: Record<string, unknown> = {}
  try { result = JSON.parse(rawText) as Record<string, unknown> } catch { /* handled below */ }
  if (!response.ok) throw new Error(`视频网关状态查询失败 (${response.status})`)
  return { ...result, status: normalizeGatewayVideoStatus(result.status), outputs: result }
}

function findAssetUrl(value: unknown, mediaType: 'image' | 'video'): string | undefined {
  if (typeof value === 'string') {
    if (!/^https:\/\/[^\s]+$/i.test(value)) return undefined
    const extensionPattern = mediaType === 'video' ? /\.(?:mp4|webm|mov)(?:\?|$)/i : /\.(?:png|jpe?g|webp)(?:\?|$)/i
    return extensionPattern.test(value) ? value : undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findAssetUrl(item, mediaType); if (found) return found }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const preferredKeys = mediaType === 'video' ? ['video_url', 'url', 'downloadUrl', 'output'] : ['image_url', 'image_url_list', 'imageUrls', 'url', 'output']
  for (const key of preferredKeys) {
    const found = findAssetUrl(record[key], mediaType)
    if (found) return found
  }
  for (const nested of Object.values(record)) {
    const found = findAssetUrl(nested, mediaType)
    if (found) return found
  }
  return undefined
}

async function materializeAssetTask(task: AssetTaskRecord) {
  const isVideo = isVideoAssetKind(task.assetKind)
  if (task.status !== 'succeeded' || task.publicUrl) return task
  const sourceUrl = findAssetUrl(task.outputs, isVideo ? 'video' : 'image')
  if (!sourceUrl) return task
  const response = await fetch(sourceUrl)
  const sourceLabel = task.provider === 'gateway' ? '视频网关' : 'AIHub'
  if (!response.ok) throw new Error(`${sourceLabel} ${isVideo ? '视频' : '图片'}下载失败 (${response.status})`)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (isVideo ? !contentType.startsWith('video/') && !contentType.includes('octet-stream') : !contentType.startsWith('image/')) throw new Error(`${sourceLabel}输出不是${isVideo ? '视频' : '图片'}资源`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const maxBytes = isVideo ? 250 * 1024 * 1024 : 20 * 1024 * 1024
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`${sourceLabel} ${isVideo ? '视频' : '图片'}文件大小异常`)
  const extension = isVideo ? contentType.includes('webm') ? 'webm' : contentType.includes('quicktime') ? 'mov' : 'mp4' : contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
  const relativeDirectory = task.commissionId
  const fileStem = (task.assetKey ?? `chapter-${task.chapterIndex + 1}-scene`).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')
  const fileName = `${fileStem}.${extension}`
  await mkdir(resolve(generatedAssetDirectory, relativeDirectory), { recursive: true })
  await writeFile(resolve(generatedAssetDirectory, relativeDirectory, fileName), bytes)
  const dimensions = isVideo ? undefined : imageDimensions(bytes)
  return { ...task, publicUrl: `${generatedAssetPublicBase}/${relativeDirectory}/${fileName}`, publicWidth: dimensions?.width, publicHeight: dimensions?.height, updatedAt: new Date().toISOString() }
}

function imageDimensions(bytes: Buffer) {
  if (bytes.length >= 24 && bytes.subarray(1, 4).toString('ascii') === 'PNG') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    const length = bytes.readUInt16BE(offset + 2)
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    if (length < 2) break
    offset += length + 2
  }
  return undefined
}

async function refreshAssetTask(task: AssetTaskRecord) {
  if (task.status === 'succeeded' && !task.publicUrl) {
    const materialized = await materializeAssetTask(task)
    if (materialized !== task) await saveAssetTask(materialized)
    return materialized
  }
  if (!task.runId || ['failed', 'timeout'].includes(task.status)) return task
  const live = task.provider === 'gateway' ? await getGatewayVideoRun(task.runId) : await getAssetRun(task.runId)
  const status = typeof live.status === 'string' ? live.status : task.status
  const liveError = (live as Record<string, unknown>).error
  const gatewayError = task.provider === 'gateway' && status === 'failed'
    ? typeof liveError === 'string' ? liveError : typeof liveError === 'object' && liveError !== null && 'message' in liveError ? String((liveError as { message?: unknown }).message ?? '') : '视频网关任务失败'
    : undefined
  let updated: AssetTaskRecord = { ...task, status, outputs: 'outputs' in live ? live.outputs : task.outputs, error: gatewayError ?? task.error, updatedAt: new Date().toISOString() }
  if (updated.status === 'succeeded') updated = await materializeAssetTask(updated)
  await saveAssetTask(updated)
  return updated
}

async function interpretWithOpenAI(prompt: string): Promise<LevelIntent> {
  const { client, config } = gatewayClient()
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [{ role: 'developer', content: 'You design a web hidden-object level. Return JSON only with theme, sceneTags, requestedObjects. Use reusable scenes only: detective office, archive library, ship harbor.' }, { role: 'user', content: prompt }],
  })
  return LevelIntentSchema.parse(parseModelJson(response.choices[0]?.message.content ?? ''))
}

export async function createServer() {
  const app = Fastify({ logger: true })
  await app.register(cors, { origin: configuredCorsOrigin(), methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'] })
  await restoreRecords()

  app.get('/health', async () => ({ ok: true, generationCount: records.length }))
  app.get('/api/generations', async () => records.map(({ level, ...record }) => ({ ...record, levelId: level.id, title: level.title })))
  app.get('/api/commission/drafts', async () => ({ records: await readSavedCommissions() }))
  app.put('/api/commission/drafts/:id', async (request, reply) => {
    const recordId = (request.params as { id?: string }).id
    const payload = SavedCommissionRecordSchema.safeParse(request.body)
    if (!payload.success) return reply.code(400).send({ error: '未完成委托保存数据无效' })
    if (!recordId || recordId !== payload.data.id) return reply.code(400).send({ error: '委托记录标识不匹配' })
    await saveCommission(payload.data)
    return { savedAt: payload.data.savedAt }
  })
  app.delete('/api/commission/drafts/:id', async (request, reply) => {
    const recordId = (request.params as { id?: string }).id
    if (!recordId) return reply.code(400).send({ error: '缺少委托记录标识' })
    await deleteSavedCommission(recordId)
    return { cleared: true }
  })
  app.get('/api/levels/:id', async (request, reply) => {
    const record = records.find((item) => item.level.id === (request.params as { id: string }).id)
    if (!record) return reply.code(404).send({ error: '关卡不存在' })
    return { level: record.level, meta: { provider: record.provider, fallbackUsed: record.fallbackUsed, generationMs: record.generationMs } }
  })
  app.post('/api/commission/stage', async (request, reply) => {
    const payload = CommissionRequestSchema.safeParse(request.body)
    if (!payload.success) return reply.code(400).send({ error: '委托制作请求无效', details: payload.error.flatten() })
    try {
      return await generateCommissionStage(payload.data.stage, payload.data.draft, payload.data.priorOutputs)
    } catch (error) {
      if (error instanceof GatewayConfigurationError) return reply.code(503).send({ error: '大模型尚未配置', setup: '请在 apps/api/.env 或进程环境中设置 AI_GATEWAY_API_KEY；接口使用 AI_GATEWAY_BASE_URL 与 AI_GATEWAY_MODEL。' })
      if (isGatewaySecurityBlock(error)) return reply.code(503).send({ error: '大模型网关被安全策略拦截：请为当前服务器出网 IP 放行到 AI_GATEWAY_BASE_URL 的 HTTPS 调用。' })
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) return reply.code(401).send({ error: '大模型令牌无效，请更新 AI_GATEWAY_API_KEY 后重试。' })
      if (typeof error === 'object' && error !== null && 'name' in error && String(error.name).includes('Timeout')) return reply.code(504).send({ error: payload.data.stage === 'code' ? '代码生成超过 75 秒，请重试当前节点。' : '大模型响应超时，请重试当前节点。' })
      if (error instanceof Error && error.message.startsWith('模型未返回文本结果')) return reply.code(502).send({ error: payload.data.stage === 'code' ? `代码模型未返回可见内容；${error.message}` : error.message })
      request.log.error(error, 'commission model stage failed')
      return reply.code(502).send({ error: '大模型节点执行失败，请检查网关模型配置后重试。' })
    }
  })
  app.post('/api/commission/assets/scene', async (request, reply) => {
    const payload = AssetProductionRequestSchema.safeParse(request.body)
    if (!payload.success) return reply.code(400).send({ error: '场景资产请求无效：请检查场景提示词长度与任务名称。', details: payload.error.flatten() })
    try { return await startSceneAsset(payload.data.prompt, payload.data.label) } catch (error) {
      if (error instanceof GatewayConfigurationError) return reply.code(503).send({ error: '素材生产尚未配置', setup: '请设置 AIHUB_AGENT_TOKEN 与 AIHUB_ASSET_SKILL_DIR。' })
      if (error instanceof AssetProductionError) return reply.code(502).send({ error: `AIHub 场景资产任务提交失败：${error.message}` })
      request.log.error(error, 'aihub scene asset start failed')
      return reply.code(502).send({ error: 'AIHub 场景资产任务提交失败。' })
    }
  })
  app.post('/api/commission/assets/scenes', async (request, reply) => {
    const payload = LegacyAssetProductionBatchSchema.safeParse(request.body)
    if (!payload.success) return reply.code(400).send({ error: '场景子任务请求无效' })
    const tasks = payload.data.tasks.map((task) => ({ ...task, assetKey: `chapter-${task.chapterIndex + 1}-scene`, assetKind: 'scene' as const, alias: 'jimeng' as const }))
    const results = await Promise.all(tasks.map((task) => submitAssetTask(payload.data.commissionId, task)))
    return { tasks: results }
  })
  app.post('/api/commission/assets/batch', async (request, reply) => {
    const payload = AssetProductionBatchSchema.safeParse(request.body)
    if (!payload.success) return reply.code(400).send({ error: '素材子任务请求无效', details: payload.error.flatten() })
    const results = await Promise.all(payload.data.tasks.map((task) => submitAssetTask(payload.data.commissionId, task)))
    return { tasks: results }
  })
  app.get('/api/commission/assets/tasks', async (request) => {
    const query = request.query as { commissionId?: string; latest?: string }
    let tasks = (await readAssetTasks()).filter((task) => !query.commissionId || task.commissionId === query.commissionId)
    tasks = await Promise.all(tasks.map(async (task) => {
      try { return await refreshAssetTask(task) } catch { return task }
    }))
    if (query.latest === 'true') {
      const latestByAsset = new Map<string, AssetTaskRecord>()
      for (const task of tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
        const assetKey = task.assetKey ?? `chapter-${task.chapterIndex + 1}-scene`
        if (!latestByAsset.has(assetKey)) latestByAsset.set(assetKey, task)
      }
      tasks = [...latestByAsset.values()].sort((left, right) => left.chapterIndex - right.chapterIndex || (left.assetKey ?? '').localeCompare(right.assetKey ?? ''))
    }
    return { tasks }
  })
  app.get('/api/commission/assets/:runId', async (request, reply) => {
    const runId = (request.params as { runId?: string }).runId
    if (!runId) return reply.code(400).send({ error: '缺少资产任务号' })
    try {
      const savedTask = (await readAssetTasks()).find((task) => task.runId === runId)
      return savedTask?.provider === 'gateway' ? await getGatewayVideoRun(runId) : await getAssetRun(runId)
    } catch (error) {
      if (error instanceof GatewayConfigurationError) return reply.code(503).send({ error: '素材生产尚未配置' })
      request.log.error(error, 'asset status lookup failed')
      return reply.code(502).send({ error: '素材任务状态查询失败。' })
    }
  })
  app.post('/api/generate-level', async (request, reply) => {
    const payload = GenerateRequestSchema.safeParse(request.body)
    if (!payload.success) return reply.code(400).send({ error: '请求无效', details: payload.error.flatten() })
    const startedAt = Date.now()
    const requestedMode = payload.data.mode ?? (process.env.GENERATOR_MODE === 'openai' ? 'openai' : 'mock')
    let provider: 'mock' | 'openai' = requestedMode
    let fallbackUsed = false
    let intent: LevelIntent
    try {
      intent = requestedMode === 'openai' ? await interpretWithOpenAI(payload.data.prompt) : interpretPrompt(payload.data.prompt)
    } catch {
      intent = interpretPrompt(payload.data.prompt)
      provider = 'mock'
      fallbackUsed = true
    }
    const seed = payload.data.seed ?? `seed-${Date.now().toString(36)}`
    try {
      const level = generateLevel(intent, seed)
      const record: GenerationRecord = { id: level.id, prompt: payload.data.prompt, seed, createdAt: new Date().toISOString(), level, provider, fallbackUsed, generationMs: Date.now() - startedAt }
      records = [record, ...records.filter((item) => item.level.id !== level.id)]
      await saveRecords()
      return { levelId: level.id, level, meta: { provider, fallbackUsed, generationMs: record.generationMs } }
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : '关卡生成失败' })
    }
  })
  app.post('/api/events', async (request, reply) => {
    const payload = EventBatchSchema.safeParse(request.body)
    if (!payload.success) return reply.code(400).send({ error: '事件格式无效' })
    events.push(...payload.data.events.map((event) => ({ ...event, sessionId: payload.data.sessionId })))
    return reply.code(202).send({ accepted: payload.data.events.length })
  })
  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createServer()
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: '127.0.0.1' })
}
