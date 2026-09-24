import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Level } from '@hog/contracts'
import { apiUrl } from '../api'
import type { StoryLevel } from '../content/story-levels'
import { PhaserGame } from '../game/PhaserGame'
import { AlertIcon, ArrowLeftIcon, ArrowRightIcon, BulbIcon, CheckIcon, ClockIcon, CloseIcon, DraftIcon, LockIcon, PlayIcon } from '../icons'
import { generatedObjectHint } from './generatedHints'
import { customStoryTemplates, defaultStoryTemplate, storyBeatsForLength, storyTemplateFor, storyTemplateModelProfile, visualStyleDirection, visualStyles, type StoryTemplateId } from './storyTemplates'

type CreatorPage = 'drafts' | 'theme' | 'brief' | 'outline' | 'generating' | 'production-record' | 'map' | 'story' | 'play' | 'cutscene' | 'settlement' | 'notes' | 'gallery' | 'share'
type Length = 1 | 3 | 5
type Difficulty = '轻松' | '标准' | '隐蔽'
type UploadPurpose = '场景原图' | '风格参考' | '指定物件'
type CommissionStage = 'understanding' | 'outline' | 'gameplay' | 'narrative' | 'resources' | 'resource-production' | 'code' | 'integration'
type ModelOutput = { text: string; rawText: string; model?: string; data: Record<string, unknown> }
const CREATOR_DRAFT_STORAGE_KEY = 'hog.creator-draft.v1'

interface Draft {
  templateId?: StoryTemplateId
  theme: string
  prompt: string
  length: Length
  objectCount: 6 | 8 | 10 | 12
  difficulty: Difficulty
  style: string
  uploads: Array<{ name: string; purpose: UploadPurpose; preview: string }>
}

interface CommissionChapter {
  title: string
  summary: string
  caseFile: string
  objective: string
  hintTone?: string
  coverUrl?: string
  transitionVideoUrl?: string
  endingVideoUrl?: string
  level: Level
}

const productionSteps: Array<{ id: CommissionStage; label: string; output: string; ai: boolean }> = [
  { id: 'understanding', label: '理解委托', output: '委托语义与限制条件', ai: true },
  { id: 'outline', label: '故事大纲', output: '章节结构与悬念走向', ai: true },
  { id: 'gameplay', label: '设计玩法', output: '关卡节奏与难度方案', ai: true },
  { id: 'narrative', label: '编写剧情', output: '章节剧情与线索因果', ai: true },
  { id: 'resources', label: '规划资源', output: '场景、物件与交互清单', ai: true },
  { id: 'resource-production', label: '资源生产', output: '场景、封面、物件图、过场与结束视频', ai: false },
  { id: 'code', label: '代码编写', output: '可交付代码文件', ai: true },
  { id: 'integration', label: '拼装整合', output: '可游玩关卡与验收记录', ai: false },
]
const creatorPages: CreatorPage[] = ['drafts', 'theme', 'brief', 'outline', 'generating', 'production-record', 'map', 'story', 'play', 'cutscene', 'settlement', 'notes', 'gallery', 'share']
const defaultDraft: Draft = { templateId: defaultStoryTemplate.id, theme: defaultStoryTemplate.title, prompt: '', length: 3, objectCount: 8, difficulty: '标准', style: defaultStoryTemplate.recommendedStyle, uploads: [] }

type SavedCreatorState = { page?: CreatorPage; resumePage?: CreatorPage; draft?: Draft; chapters?: CommissionChapter[]; productionIndex?: number; activeChapter?: number; completedChapterIds?: string[]; stageOutputs?: Partial<Record<CommissionStage, ModelOutput>>; productionError?: string | null; savedAt?: string }
type SavedCommissionRecord = SavedCreatorState & { id: string }
function readSavedCreatorState(): SavedCreatorState | null {
  try {
    const stored = localStorage.getItem(CREATOR_DRAFT_STORAGE_KEY)
    return stored ? JSON.parse(stored) as SavedCreatorState : null
  } catch { return null }
}
function isCreatorPage(value: unknown): value is CreatorPage { return typeof value === 'string' && creatorPages.includes(value as CreatorPage) }
function createCommissionId() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (key) => { const value = Math.floor(Math.random() * 16); return (key === 'x' ? value : (value & 0x3) | 0x8).toString(16) }) }
function isAssetTaskPending(task: Record<string, unknown>) {
  const status = String(task.status ?? '')
  return ['submitting', 'queued', 'running'].includes(status) || (status === 'succeeded' && typeof task.publicUrl !== 'string')
}
function assetKindLabel(task: Record<string, unknown>) {
  const labels: Record<string, string> = { scene: '场景图', cover: '关卡封面', 'object-image': '寻找物件图', 'transition-video': '章节过场视频', 'ending-video': '结束视频' }
  return labels[String(task.assetKind ?? 'scene')] ?? '游戏素材'
}
function isAssetPermissionDenied(task: Record<string, unknown>) { return task.status === 'failed' && /permission|forbidden|权限不足|\b403\b/i.test(String(task.error ?? '')) }
function assetProviderLabel(task: Record<string, unknown>) { return task.provider === 'gateway' ? '网龙 AI 网关' : 'AIHub' }
function assetFailureSummary(task: Record<string, unknown>) {
  if (isAssetPermissionDenied(task)) return `当前 ${assetProviderLabel(task)} Token 没有 ${String(task.alias ?? '该')} 工作流权限。`
  return typeof task.error === 'string' ? task.error.slice(0, 180) : '素材任务失败，请查看制作记录。'
}
function assetProductionOutput(tasks: Array<Record<string, unknown>>): ModelOutput {
  const failedCount = tasks.filter((task) => ['failed', 'timeout'].includes(String(task.status ?? ''))).length
  const pendingCount = tasks.filter(isAssetTaskPending).length
  const succeededCount = tasks.filter((task) => task.status === 'succeeded' && typeof task.publicUrl === 'string').length
  const text = pendingCount > 0
    ? `素材生产服务已提交 ${tasks.length} 个子任务，${pendingCount} 个仍在生产。`
    : failedCount > 0
      ? `素材任务已收敛：${succeededCount} 个成功，${failedCount} 个失败。`
      : `${succeededCount} 个游戏素材已全部生产完成并取回结果。`
  return { text, rawText: JSON.stringify(tasks), data: { tasks, failedCount, pendingCount, succeededCount } }
}

const assetKindOrder = ['scene', 'cover', 'object-image', 'transition-video', 'ending-video'] as const

function assetTaskStatusLabel(task: Record<string, unknown>) {
  const status = String(task.status ?? 'waiting')
  if (status === 'queued') return '排队中'
  if (status === 'submitting') return '正在提交'
  if (status === 'running') return '生产中'
  if (status === 'succeeded') return '已完成'
  if (isAssetPermissionDenied(task)) return '权限不足'
  if (status === 'failed') return '提交失败'
  if (status === 'timeout') return '已超时'
  return '等待中'
}

function AssetTaskGroups({ tasks, archived = false }: { tasks: Array<Record<string, unknown>>; archived?: boolean }) {
  const groups = assetKindOrder
    .map((kind, order) => {
      const items = tasks.filter((task) => String(task.assetKind ?? 'scene') === kind)
      const failed = items.filter((task) => ['failed', 'timeout'].includes(String(task.status ?? ''))).length
      const pending = items.filter(isAssetTaskPending).length
      const succeeded = items.filter((task) => task.status === 'succeeded' && typeof task.publicUrl === 'string').length
      return { kind, order, items, failed, pending, succeeded }
    })
    .filter((group) => group.items.length > 0)
    .sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0) || Number(b.pending > 0) - Number(a.pending > 0) || a.order - b.order)

  return <section className={`asset-subtasks asset-task-groups${archived ? ' production-record-assets' : ''}`} aria-label={archived ? '已归档的游戏资产子任务' : '游戏资产子任务'}>
    <header className="asset-task-groups-header">
      <div><h2>{archived ? '游戏资产记录' : '游戏资产子任务'}</h2><p>按素材类型汇总，展开后可查看任务号与产物。</p></div>
      <strong>{tasks.length} 项</strong>
    </header>
    <div className="asset-task-group-list">
      {groups.map((group) => {
        const needsAttention = group.failed > 0 || group.pending > 0
        const stateClass = group.failed > 0 ? 'is-failed' : group.pending > 0 ? 'is-running' : 'is-complete'
        const stateLabel = group.failed > 0 ? `${group.failed} 项需处理` : group.pending > 0 ? `${group.pending} 项生产中` : '已完成'
        return <details className={`asset-task-group ${stateClass}`} open={needsAttention || undefined} key={group.kind}>
          <summary>
            <span className="asset-task-group-title">{assetKindLabel({ assetKind: group.kind })}<small>{group.items.length} 项</small></span>
            <span className="asset-task-group-progress">{group.succeeded} / {group.items.length}</span>
            <b>{stateLabel}</b>
          </summary>
          <div className="asset-task-group-details">
            {group.items.map((task, index) => {
              const status = String(task.status ?? 'waiting')
              const hasRunId = typeof task.runId === 'string' && task.runId.length > 0
              const publicUrl = typeof task.publicUrl === 'string' ? task.publicUrl : null
              return <article className="asset-task-entry" key={String(task.taskId ?? task.runId ?? task.label ?? index)}>
                <div className="asset-task-entry-title">
                  <span>{Number(task.chapterIndex ?? -1) >= 0 ? `第 ${Number(task.chapterIndex) + 1} 章` : '全故事'} · {String(task.chapterTitle ?? task.targetName ?? '未命名素材')}</span>
                  <small>{assetProviderLabel(task)} · {String(task.model ?? task.alias ?? '默认模型')}</small>
                </div>
                <b>{assetTaskStatusLabel(task)}</b>
                <small className="asset-task-run-id">{hasRunId ? `Run ID：${String(task.runId)}` : status === 'failed' ? '未生成 Run ID' : `等待${assetProviderLabel(task)}返回 Run ID`}</small>
                {publicUrl && <a href={publicUrl} target="_blank" rel="noreferrer">查看素材</a>}
                {status === 'failed' && <small className="asset-task-error">{assetFailureSummary(task)}</small>}
              </article>
            })}
          </div>
        </details>
      })}
    </div>
  </section>
}

function currentFlowStage(page: CreatorPage) {
  if (page === 'drafts' || page === 'theme' || page === 'brief') return 0
  if (page === 'outline') return 1
  if (page === 'generating') return 2
  return 3
}

function fitLevelObjectCount(level: Level, objectCount: Draft['objectCount']): Level {
  const objects = Array.from({ length: objectCount }, (_, index) => {
    const source = level.objects[index % level.objects.length]
    if (index < level.objects.length) return source
    const extraIndex = index - level.objects.length
    return {
      ...source,
      id: `${source.id}-extra-${index + 1}`,
      name: `${source.name}线索`,
      x: 0.14 + (extraIndex % 4) * 0.23,
      y: 0.2 + Math.floor(extraIndex / 4) * 0.52,
    }
  })
  return { ...level, mission: { ...level.mission, targetIds: objects.map((object) => object.id) }, objects }
}

function assetTasksFromOutput(output: ModelOutput | undefined) {
  const tasks = output?.data.tasks
  return Array.isArray(tasks) ? tasks.filter((task): task is Record<string, unknown> => Boolean(task && typeof task === 'object')) : []
}

function applyProducedAssets(chapters: CommissionChapter[], tasks: Array<Record<string, unknown>>) {
  return chapters.map((chapter, index) => {
    const chapterTasks = tasks.filter((item) => Number(item.chapterIndex) === index)
    const taskKind = (task: Record<string, unknown>) => typeof task.assetKind === 'string' ? task.assetKind : 'scene'
    const sceneTask = chapterTasks.find((item) => taskKind(item) === 'scene' && typeof item.publicUrl === 'string')
    const coverTask = chapterTasks.find((item) => taskKind(item) === 'cover' && typeof item.publicUrl === 'string')
    const transitionTask = chapterTasks.find((item) => taskKind(item) === 'transition-video' && typeof item.publicUrl === 'string')
    const endingTask = tasks.find((item) => taskKind(item) === 'ending-video' && typeof item.publicUrl === 'string')
    const objects = chapter.level.objects.map((object) => {
      const objectTask = tasks.find((item) => taskKind(item) === 'object-image' && typeof item.publicUrl === 'string' && (
        (typeof item.targetName === 'string' && item.targetName === object.name) ||
        (Number(item.chapterIndex) === index && item.targetId === object.id)
      ))
      if (!objectTask) return object
      const publicUrl = String(objectTask.publicUrl)
      // 物品栏与场景必须使用同一份生成物；白底图片由游戏运行时派生透明贴图。
      return { ...object, thumbnailUrl: publicUrl, spriteUrl: publicUrl }
    })
    const scene = sceneTask ? { backgroundUrl: String(sceneTask.publicUrl), width: typeof sceneTask.publicWidth === 'number' ? sceneTask.publicWidth : chapter.level.scene.width, height: typeof sceneTask.publicHeight === 'number' ? sceneTask.publicHeight : chapter.level.scene.height } : chapter.level.scene
    return { ...chapter, coverUrl: typeof coverTask?.publicUrl === 'string' ? coverTask.publicUrl : chapter.coverUrl, transitionVideoUrl: typeof transitionTask?.publicUrl === 'string' ? transitionTask.publicUrl : chapter.transitionVideoUrl, endingVideoUrl: index === chapters.length - 1 && typeof endingTask?.publicUrl === 'string' ? endingTask.publicUrl : chapter.endingVideoUrl, level: { ...chapter.level, scene, objects } }
  })
}

function assetPackageSummary(chapters: CommissionChapter[], objectCount: Draft['objectCount'], tasks: Array<Record<string, unknown>>) {
  const required: Record<string, number> = { scene: chapters.length, cover: chapters.length, 'object-image': objectCount, 'transition-video': Math.max(0, chapters.length - 1), 'ending-video': 1 }
  const completed: Record<string, number> = { scene: 0, cover: 0, 'object-image': 0, 'transition-video': 0, 'ending-video': 0 }
  for (const task of tasks) {
    const kind = String(task.assetKind ?? 'scene')
    if (kind in completed && task.status === 'succeeded' && typeof task.publicUrl === 'string') completed[kind] += 1
  }
  const requiredTotal = Object.values(required).reduce((sum, count) => sum + count, 0)
  const completedTotal = Object.entries(required).reduce((sum, [kind, count]) => sum + Math.min(count, completed[kind] ?? 0), 0)
  return { required, completed, requiredTotal, completedTotal, complete: requiredTotal > 0 && completedTotal >= requiredTotal }
}

function normalizeChapters(chapters: CommissionChapter[], objectCount: Draft['objectCount'], output?: ModelOutput) {
  return applyProducedAssets(chapters.map((chapter) => ({ ...chapter, level: fitLevelObjectCount(chapter.level, objectCount) })), assetTasksFromOutput(output))
}

function buildChapters(stories: StoryLevel[], draft: Draft): CommissionChapter[] {
  const template = storyTemplateFor(draft.templateId, draft.theme)
  const beats = storyBeatsForLength(template, draft.length)
  return beats.map((beat, index) => {
    const source = stories[index % Math.min(stories.length, 3)]
    const title = `${draft.theme}：${beat.title}`
    const summary = index === 0 && draft.prompt ? `围绕“${draft.prompt}”，${beat.summary}` : beat.summary
    return {
      title,
      summary,
      caseFile: `${summary} 这是一条独立于主线侦探档案的${template.title}故事。`,
      objective: `${beat.objective} 本章为${draft.difficulty}难度。`,
      hintTone: template.hintTone,
      level: { ...fitLevelObjectCount(source.level, draft.objectCount), id: `commission-${Date.now()}-${index}`, title },
    }
  })
}

function templateHint(templateId: StoryTemplateId, index: number) {
  const hints: Record<StoryTemplateId, string[]> = {
    'detective-archive': ['观察它与周围证物的摆放关系。', '留意光线没有完整照到的边缘。', '从使用者最顺手的位置开始排查。'],
    'fairy-adventure': ['魔法信物喜欢躲在颜色相近的温暖角落。', '顺着会发光的细节，看看层层陈设交会的地方。', '听听故事里的自然暗示，再观察不太安分的小轮廓。'],
    'oriental-folklore': ['顺着灯影与器物摆放的方向细看。', '留意木纹、绢面与月色交界处不合常理的轮廓。', '想想它在仪式中的方位，再从对应方向寻找。'],
    'space-expedition': ['扫描舱壁与设备交界处的异常轮廓。', '检查同类模块中读数或材质略有不同的一件。', '从它所属系统附近开始排查连接件与收纳槽。'],
    'cozy-life': ['想想谁最常使用它，再看看那个人顺手的收纳位置。', '日常小物常会混在颜色和用途相近的东西之间。', '沿着刚刚有人活动过的生活痕迹慢慢找。'],
  }
  return hints[templateId][index % hints[templateId].length]
}

export function CreatorFlow({ stories, onExit, initialPage = 'drafts', appNav }: { stories: StoryLevel[]; onExit: () => void; initialPage?: 'drafts' | 'gallery'; appNav?: ReactNode }) {
  const savedState = useMemo(() => readSavedCreatorState(), [])
  const localDraft = initialPage === 'gallery' && savedState?.draft ? savedState.draft : defaultDraft
  const restoredPage = initialPage === 'gallery' && isCreatorPage(savedState?.page) ? savedState.page : initialPage
  const [page, setPage] = useState<CreatorPage>(initialPage)
  const resumePageRef = useRef<CreatorPage>(isCreatorPage(savedState?.resumePage) ? savedState.resumePage : restoredPage)
  const [draft, setDraft] = useState<Draft>(localDraft)
  const [chapters, setChapters] = useState<CommissionChapter[]>(() => initialPage === 'gallery' && Array.isArray(savedState?.chapters) && savedState.chapters.length ? normalizeChapters(savedState.chapters, localDraft.objectCount, savedState.stageOutputs?.['resource-production']) : buildChapters(stories, localDraft))
  const [productionIndex, setProductionIndex] = useState(initialPage === 'gallery' ? savedState?.productionIndex ?? 0 : 0)
  const [activeChapter, setActiveChapter] = useState(initialPage === 'gallery' ? savedState?.activeChapter ?? 0 : 0)
  const [completedChapterIds, setCompletedChapterIds] = useState<string[]>(initialPage === 'gallery' && Array.isArray(savedState?.completedChapterIds) ? savedState.completedChapterIds : [])
  const [foundIds, setFoundIds] = useState<string[]>([])
  const [wrongClicks, setWrongClicks] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [hintCount, setHintCount] = useState(0)
  const [ready, setReady] = useState(false)
  const [complete, setComplete] = useState(false)
  const [hintRequest, setHintRequest] = useState({ nonce: 0, targetId: undefined as string | undefined })
  const [hintText, setHintText] = useState<string | null>(null)
  const [stageOutputs, setStageOutputs] = useState<Partial<Record<CommissionStage, ModelOutput>>>(initialPage === 'gallery' ? savedState?.stageOutputs ?? {} : {})
  const [productionError, setProductionError] = useState<string | null>(initialPage === 'gallery' ? savedState?.productionError ?? null : null)
  const [selectedOutputStage, setSelectedOutputStage] = useState<CommissionStage | null>(null)
  const [showBuildCompleteNotice, setShowBuildCompleteNotice] = useState(false)
  const [commissionId, setCommissionId] = useState(() => initialPage === 'gallery' && typeof (savedState as SavedCommissionRecord | null)?.id === 'string' ? (savedState as SavedCommissionRecord).id : createCommissionId())
  const [savedRecords, setSavedRecords] = useState<SavedCommissionRecord[]>([])
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const chaptersRef = useRef(chapters)
  const hasActiveCommissionRef = useRef(false)

  const activeTemplate = storyTemplateFor(draft.templateId, draft.theme)
  const chapter = chapters[activeChapter]
  const targets = useMemo(() => chapter?.level.objects.filter((item) => chapter.level.mission.targetIds.includes(item.id)) ?? [], [chapter])
  const codeFiles = Array.isArray(stageOutputs.code?.data.files) ? stageOutputs.code.data.files.filter((file): file is Record<string, unknown> => Boolean(file && typeof file === 'object')) : []
  const assetTasks = assetTasksFromOutput(stageOutputs['resource-production'])
  const hasPendingAssetTasks = assetTasks.some(isAssetTaskPending)
  const hasPermissionDeniedTasks = assetTasks.some(isAssetPermissionDenied)
  const assetPackage = assetPackageSummary(chapters, draft.objectCount, assetTasks)
  const templateCompatibility = String(stageOutputs.understanding?.data.compatibility ?? '')
  const templateConflictSuggestion = typeof stageOutputs.understanding?.data.conflictSuggestion === 'string' ? stageOutputs.understanding.data.conflictSuggestion : '这句话与当前模板的叙事目标不完全一致，可以更换模板或返回修改委托。'
  const selectedStep = productionSteps.find((step) => step.id === selectedOutputStage)
  const selectedOutput = selectedOutputStage ? stageOutputs[selectedOutputStage] : undefined
  const draftRecords = savedRecords.filter((record) => !record.stageOutputs?.integration)
  const createdRecords = savedRecords.filter((record) => Boolean(record.stageOutputs?.integration))
  const activeChapterId = chapter?.level.id
  const handleChapterReady = useCallback(() => setReady(true), [])
  const handleChapterFound = useCallback((id: string) => setFoundIds((items) => items.includes(id) ? items : [...items, id]), [])
  const handleChapterWrongClick = useCallback(() => setWrongClicks((count) => count + 1), [])
  const handleChapterComplete = useCallback(() => {
    if (!activeChapterId) return
    setComplete(true)
    setCompletedChapterIds((current) => current.includes(activeChapterId) ? current : [...current, activeChapterId])
  }, [activeChapterId])

  useEffect(() => {
    if (page !== 'play' || !ready || complete) return
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [complete, page, ready])

  useEffect(() => {
    if (!showBuildCompleteNotice) return
    const timer = window.setTimeout(() => setShowBuildCompleteNotice(false), 3200)
    return () => window.clearTimeout(timer)
  }, [showBuildCompleteNotice])

  useEffect(() => {
    if (page !== 'play' || !complete || !chapter) return
    const finalChapter = activeChapter + 1 >= chapters.length
    const videoUrl = finalChapter ? chapter.endingVideoUrl : chapter.transitionVideoUrl
    if (!videoUrl) return
    const timer = window.setTimeout(() => setPage('cutscene'), 900)
    return () => window.clearTimeout(timer)
  }, [activeChapter, chapter, chapters.length, complete, page])

  useEffect(() => { chaptersRef.current = chapters }, [chapters])

  useEffect(() => {
    if (page !== 'gallery' && page !== 'theme') resumePageRef.current = page
  }, [page])

  function snapshot(pageValue = page, id = commissionId): SavedCommissionRecord {
    const savedDraft = { ...draft, uploads: draft.uploads.map(({ name, purpose }) => ({ name, purpose, preview: '' })) }
    return { id, page: pageValue, resumePage: resumePageRef.current, draft: savedDraft, chapters: chaptersRef.current, productionIndex, activeChapter, completedChapterIds, stageOutputs, productionError, savedAt: new Date().toISOString() }
  }
  function saveRecord(state: SavedCommissionRecord) {
    try { localStorage.setItem(CREATOR_DRAFT_STORAGE_KEY, JSON.stringify(state)) } catch { /* Keep the in-memory session usable if local storage is unavailable. */ }
    setSavedRecords((records) => [state, ...records.filter((record) => record.id !== state.id)].sort((left, right) => (right.savedAt ?? '').localeCompare(left.savedAt ?? '')))
    return fetch(apiUrl(`/api/commission/drafts/${state.id}`), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) }).then(async (response) => {
      if (response.ok) { setPersistenceError(null); return }
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? '委托记录保存失败')
    }).catch((error) => { setPersistenceError(error instanceof Error ? error.message : '委托记录保存失败') })
  }
  function persistCommission(pageValue = page) {
    return saveRecord(snapshot(pageValue))
  }
  function restoreCommission(state: SavedCreatorState) {
    if (!state.draft || !Array.isArray(state.chapters) || !state.chapters.length) return
    const restoredOutputs = state.stageOutputs ?? {}
    const restoredChapters = normalizeChapters(state.chapters, state.draft.objectCount, restoredOutputs['resource-production'])
    chaptersRef.current = restoredChapters
    setDraft(state.draft); setChapters(restoredChapters); setProductionIndex(state.productionIndex ?? 0); setActiveChapter(state.activeChapter ?? 0); setCompletedChapterIds(state.completedChapterIds ?? [])
    const restoredIndex = state.productionIndex ?? 0
    const currentStep = productionSteps[restoredIndex]
    const wasInterrupted = state.resumePage === 'generating' && currentStep && !restoredOutputs[currentStep.id] && !state.productionError
    setStageOutputs(restoredOutputs); setProductionError(state.productionError ?? (wasInterrupted ? '上次制作进程已中断，请重试当前节点。' : null))
    resumePageRef.current = isCreatorPage(state.resumePage) ? state.resumePage : 'brief'
  }
  useEffect(() => { if (hasActiveCommissionRef.current) void persistCommission() }, [activeChapter, chapters, completedChapterIds, draft, page, productionError, productionIndex, stageOutputs])
  useEffect(() => {
    if (initialPage !== 'gallery' && initialPage !== 'drafts') return
    let cancelled = false
    void fetch(apiUrl('/api/commission/drafts')).then(async (response) => response.ok ? await response.json() as { records?: SavedCommissionRecord[] } : {}).then((response) => {
      if (cancelled || !response.records) return
      setSavedRecords(response.records)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [initialPage])
  useEffect(() => {
    if (!assetTasks.length) return
    let cancelled = false
    const refresh = () => { void fetchLatestAssetTasks().then((tasks) => {
      if (cancelled || !tasks.length) return
      const productionOutput = assetProductionOutput(tasks)
      const complete = Number(productionOutput.data.succeededCount ?? 0) === tasks.length
      setStageOutputs((current) => ({
        ...current,
        'resource-production': productionOutput,
        integration: complete && current.integration ? { ...current.integration, text: '已将模型文本、AIHub 图片资产与网关视频资产装配进可游玩关卡，15 项素材均已回填。' } : current.integration,
      }))
      setChapters((current) => {
        const next = applyProducedAssets(current, tasks)
        chaptersRef.current = next
        return next
      })
    }).catch(() => undefined) }
    refresh()
    const timer = hasPendingAssetTasks ? window.setInterval(refresh, 5000) : undefined
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [commissionId, assetTasks.length, hasPendingAssetTasks, page])
  useEffect(() => {
    if (page !== 'generating' || productionSteps[productionIndex]?.id !== 'resource-production' || hasPendingAssetTasks || productionError) return
    const failedCount = Number(stageOutputs['resource-production']?.data.failedCount ?? 0)
    if (failedCount > 0) setProductionError(`素材生产服务有 ${failedCount} 个游戏资产子任务失败；已完成素材和任务号均已保留。`)
  }, [hasPendingAssetTasks, page, productionError, productionIndex, stageOutputs])

  function draftPayload() {
    return {
      ...draft,
      templateId: activeTemplate.id,
      templateProfile: storyTemplateModelProfile(activeTemplate),
      visualDirection: visualStyleDirection(draft.style),
      uploads: draft.uploads.map(({ name, purpose }) => ({ name, purpose })),
    }
  }
  function startNewCommission() {
    const nextId = createCommissionId(); const nextChapters = buildChapters(stories, defaultDraft)
    hasActiveCommissionRef.current = true
    chaptersRef.current = nextChapters
    setCommissionId(nextId); setDraft(defaultDraft); setChapters(nextChapters); setStageOutputs({}); setProductionError(null); setProductionIndex(0); setActiveChapter(0); setCompletedChapterIds([]); setShowBuildCompleteNotice(false); resumePageRef.current = 'theme'; setPage('theme')
    void saveRecord({ id: nextId, page: 'theme', resumePage: 'theme', draft: defaultDraft, chapters: nextChapters, productionIndex: 0, activeChapter: 0, completedChapterIds: [], stageOutputs: {}, productionError: null, savedAt: new Date().toISOString() })
  }
  function outputText(output: ModelOutput | undefined) { return output?.text || '已生成可检查产物。' }
  function modelChapters(output: ModelOutput | undefined) {
    const chapters = output?.data.chapters
    return Array.isArray(chapters) ? chapters.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : []
  }
  function applyOutline(output: ModelOutput | undefined) {
    const generated = modelChapters(output)
    setChapters((current) => current.map((chapter, index) => {
      const source = generated[index]
      if (!source) return chapter
      const title = typeof source.title === 'string' ? source.title : chapter.title
      return { ...chapter, title, level: { ...chapter.level, title }, summary: typeof source.summary === 'string' ? source.summary : chapter.summary, objective: typeof source.objective === 'string' ? source.objective : chapter.objective }
    }))
  }
  function applyNarrative(output: ModelOutput | undefined) {
    const generated = modelChapters(output)
    setChapters((current) => current.map((chapter, index) => {
      const source = generated[index]
      if (!source) return chapter
      const title = typeof source.title === 'string' ? source.title : chapter.title
      return { ...chapter, title, level: { ...chapter.level, title }, caseFile: typeof source.caseFile === 'string' ? source.caseFile : chapter.caseFile, objective: typeof source.objective === 'string' ? source.objective : chapter.objective, hintTone: typeof source.hintTone === 'string' ? source.hintTone : chapter.hintTone }
    }))
  }
  async function runModelStage(stage: Exclude<CommissionStage, 'resource-production' | 'integration'>, outputs: Partial<Record<CommissionStage, ModelOutput>>) {
    const priorOutputs = Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, value?.rawText ?? '']))
    const response = await fetch(apiUrl('/api/commission/stage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage, draft: draftPayload(), priorOutputs }) })
    const body = await response.json() as { error?: string; output?: Record<string, unknown>; rawText?: string; model?: string }
    if (!response.ok || !body.output || !body.rawText) throw new Error(body.error ?? '大模型未返回可用产物')
    const data = body.output
    return { text: typeof data.text === 'string' ? data.text : body.rawText, rawText: body.rawText, model: body.model, data }
  }
  async function runAssetProduction(outputs: Partial<Record<CommissionStage, ModelOutput>>, retryPermissionDenied = false) {
    const resourcePlan = (outputs.resources?.text || outputs.resources?.rawText || '按寻物游戏常规资源方案配置').replace(/\s+/g, ' ').slice(0, 1800)
    const resourceAssets = Array.isArray(outputs.resources?.data.assets) ? outputs.resources.data.assets.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : []
    const plannedObjectNames = resourceAssets.filter((item) => String(item.type ?? '').includes('object')).map((item) => String(item.name ?? '').replace(/图标$/, '')).filter(Boolean)
    const namedChapters = chaptersRef.current.map((chapter) => ({ ...chapter, level: { ...chapter.level, objects: chapter.level.objects.map((object, objectIndex) => ({ ...object, name: plannedObjectNames[objectIndex % Math.max(1, plannedObjectNames.length)] || object.name, hint: templateHint(activeTemplate.id, objectIndex) })) } }))
    chaptersRef.current = namedChapters
    setChapters(namedChapters)
    const tasks: Array<Record<string, unknown>> = []
    for (const [chapterIndex, chapter] of namedChapters.entries()) {
      const storyContext = `故事模板：${activeTemplate.title}。玩家身份：${activeTemplate.playerRole}。委托：${draft.prompt}。章节：${chapter.title}。剧情：${chapter.summary}。物件语义：${activeTemplate.objectSemantics}。`
      const visualContext = `视觉风格：${draft.style}。美术执行：${visualStyleDirection(draft.style)}。`
      tasks.push({ taskId: createCommissionId(), assetKey: `chapter-${chapterIndex + 1}-scene`, assetKind: 'scene', alias: 'jimeng', chapterIndex, chapterTitle: chapter.title, label: `commission-${commissionId}-chapter-${chapterIndex + 1}-scene`, prompt: [`制作横向16:9网页隐藏物品游戏场景主图，不要文字、UI、边框、水印，也不要直接画入目标物件。`, storyContext, visualContext, `难度：${draft.difficulty}。场景需要有大量自然陈设、遮挡层次和可放置小物件的空间。资源规划：${resourcePlan}`].join('\n').slice(0, 3200) })
      tasks.push({ taskId: createCommissionId(), assetKey: `chapter-${chapterIndex + 1}-cover`, assetKind: 'cover', alias: 'jimeng', chapterIndex, chapterTitle: chapter.title, label: `commission-${commissionId}-chapter-${chapterIndex + 1}-cover`, prompt: [`制作4:3关卡封面插画，不要任何文字、UI、边框或水印。画面要有明确视觉中心，适合关卡选择卡片。`, storyContext, visualContext].join('\n').slice(0, 3200) })
      if (chapterIndex < namedChapters.length - 1) {
        const nextChapter = namedChapters[chapterIndex + 1]
        tasks.push({ taskId: createCommissionId(), assetKey: `chapter-${chapterIndex + 1}-transition-video`, assetKind: 'transition-video', alias: 'doubao-seedance-2-0-260128', chapterIndex, chapterTitle: chapter.title, label: `commission-${commissionId}-chapter-${chapterIndex + 1}-transition`, prompt: `6秒横屏游戏剧情过场，无文字无字幕无水印。${storyContext}${visualContext}镜头从本章成果自然转向下一章“${nextChapter.title}”，体现“${activeTemplate.gameplayHook}”，结尾留出自然切换点。`.slice(0, 500) })
      }
    }
    const uniqueTargets = [...new Map(namedChapters.flatMap((chapter) => chapter.level.objects.filter((item) => chapter.level.mission.targetIds.includes(item.id))).map((object) => [object.name, object])).values()].slice(0, draft.objectCount)
    for (const [objectIndex, object] of uniqueTargets.entries()) {
      tasks.push({ taskId: createCommissionId(), assetKey: `story-object-${objectIndex + 1}`, assetKind: 'object-image', alias: 'jimeng', chapterIndex: -1, chapterTitle: '全故事物件库', targetName: object.name, label: `commission-${commissionId}-object-${objectIndex + 1}`, prompt: `为网页隐藏物品游戏制作“${object.name}”的独立物件图。故事模板：${activeTemplate.title}；物件在故事中属于：${activeTemplate.objectSemantics}。视觉风格：${draft.style}；${visualStyleDirection(draft.style)}。正方形构图，只出现一个完整物件，正视或轻微俯视，纯色无纹理背景，无文字、无边框、无阴影底板，轮廓清晰，作为物品栏图标和场景独立可点击物件使用。`.slice(0, 3200) })
    }
    const finalChapterIndex = Math.max(0, namedChapters.length - 1)
    tasks.push({ taskId: createCommissionId(), assetKey: 'story-ending-video', assetKind: 'ending-video', alias: 'doubao-seedance-2-0-260128', chapterIndex: finalChapterIndex, chapterTitle: namedChapters[finalChapterIndex]?.title ?? '故事结局', label: `commission-${commissionId}-ending`, prompt: `6秒横屏游戏结束动画，无文字无字幕无水印。故事模板“${activeTemplate.title}”，委托“${draft.prompt}”已经完成。结局模式：${activeTemplate.endingPattern}。视觉风格：${visualStyleDirection(draft.style)}。镜头缓慢收束并停在可作为结束画面的构图。`.slice(0, 500) })
    const previousTasks = assetTasksFromOutput(outputs['resource-production'])
    const deniedAliases = new Set(previousTasks.filter(isAssetPermissionDenied).map((task) => String(task.alias ?? '')))
    const tasksToSubmit = retryPermissionDenied ? tasks : tasks.filter((task) => !deniedAliases.has(String(task.alias ?? '')))
    const skippedTasks = previousTasks.filter((previous) => tasks.some((task) => task.assetKey === previous.assetKey && !tasksToSubmit.some((task) => task.assetKey === previous.assetKey)))
    if (!tasksToSubmit.length) return assetProductionOutput(previousTasks)
    const response = await fetch(apiUrl('/api/commission/assets/batch'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commissionId, tasks: tasksToSubmit }),
    })
    const body = await response.json() as { error?: string; tasks?: Array<Record<string, unknown>> }
    if (!response.ok || !body.tasks?.length) throw new Error(body.error ?? '素材生产服务未返回子任务')
    const submittedKeys = new Set(body.tasks.map((task) => String(task.assetKey ?? '')))
    let output = assetProductionOutput([...body.tasks, ...skippedTasks.filter((task) => !submittedKeys.has(String(task.assetKey ?? '')))])
    outputs['resource-production'] = output
    setStageOutputs({ ...outputs })
    const deadline = Date.now() + 30 * 60 * 1000
    while (Number(output.data.pendingCount ?? 0) > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 5000))
      const latestTasks = await fetchLatestAssetTasks()
      if (!latestTasks.length) break
      output = assetProductionOutput(latestTasks)
      outputs['resource-production'] = output
      setStageOutputs({ ...outputs })
    }
    if (Number(output.data.pendingCount ?? 0) > 0) {
      const timedOutTasks = (output.data.tasks as Array<Record<string, unknown>>).map((task) => isAssetTaskPending(task) ? { ...task, status: 'timeout', error: '素材生产超过 30 分钟。' } : task)
      output = assetProductionOutput(timedOutTasks)
    }
    const nextChapters = applyProducedAssets(chaptersRef.current, output.data.tasks as Array<Record<string, unknown>>)
    chaptersRef.current = nextChapters
    setChapters(nextChapters)
    return output
  }
  async function fetchLatestAssetTasks() {
    const response = await fetch(apiUrl(`/api/commission/assets/tasks?commissionId=${encodeURIComponent(commissionId)}&latest=true`))
    const body = await response.json() as { tasks?: Array<Record<string, unknown>> }
    if (!response.ok) throw new Error('素材子任务状态查询失败')
    return body.tasks ?? []
  }
  async function runStages(ids: CommissionStage[], retryPermissionDenied = false) {
    const outputs: Partial<Record<CommissionStage, ModelOutput>> = { ...stageOutputs }
    setProductionError(null)
    for (const id of ids) {
      setProductionIndex(productionSteps.findIndex((step) => step.id === id))
      let output: ModelOutput
      if (id === 'resource-production') {
        output = await runAssetProduction(outputs, retryPermissionDenied)
      } else if (id === 'integration') {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 480))
        output = { text: '已装配关卡场景、封面、寻找物件图、章节过场和结束视频，并写入可游玩关卡；图片来自 AIHub，视频来自网龙 AI 网关。', rawText: '', data: {} }
      } else output = await runModelStage(id, outputs)
      outputs[id] = output
      setStageOutputs({ ...outputs })
      void saveRecord({ ...snapshot('generating'), productionIndex: productionSteps.findIndex((step) => step.id === id), stageOutputs: { ...outputs }, productionError: null, savedAt: new Date().toISOString() })
      if (id === 'resource-production' && Number(output.data.failedCount ?? 0) > 0) throw new Error(`素材生产服务有 ${output.data.failedCount} 个游戏资产子任务失败；子任务记录已保存，可稍后补齐。`)
    }
    return outputs
  }
  async function openOutline() {
    resumePageRef.current = 'generating'; await persistCommission('generating')
    setChapters(buildChapters(stories, draft)); setStageOutputs({}); setProductionIndex(0); setPage('generating')
    try { const outputs = await runStages(['understanding', 'outline']); applyOutline(outputs.outline); setPage('outline') } catch (error) { setProductionError(error instanceof Error ? error.message : '大模型节点执行失败') }
  }
  async function startProduction() {
    resumePageRef.current = 'generating'; await persistCommission('generating')
    setProductionIndex(2); setPage('generating')
    try { const outputs = await runStages(['gameplay', 'narrative', 'resources', 'resource-production', 'code', 'integration']); applyNarrative(outputs.narrative); openMap(true) } catch (error) { setProductionError(error instanceof Error ? error.message : '大模型节点执行失败') }
  }
  async function retryProduction(retryPermissionDenied = false) {
    const remaining = productionSteps.slice(productionIndex).map((step) => step.id)
    if (!remaining.length) return
    resumePageRef.current = 'generating'; await persistCommission('generating'); setPage('generating')
    try { const outputs = await runStages(remaining, retryPermissionDenied); applyNarrative(outputs.narrative); openMap(true) } catch (error) { setProductionError(error instanceof Error ? error.message : '大模型节点执行失败') }
  }
  function openMap(showCompletion = false) { setShowBuildCompleteNotice(showCompletion); setPage('map') }
  function startChapter(index: number) {
    setActiveChapter(index); setFoundIds([]); setWrongClicks(0); setElapsedSeconds(0); setHintCount(0); setReady(false); setComplete(false); setHintText(null); setPage('story')
  }
  async function backfillAssetPackage() {
    const outputs: Partial<Record<CommissionStage, ModelOutput>> = { ...stageOutputs }
    hasActiveCommissionRef.current = true
    resumePageRef.current = 'generating'
    setProductionIndex(5)
    setProductionError(null)
    setPage('generating')
    try {
      const output = await runAssetProduction(outputs)
      outputs['resource-production'] = output
      if (Number(output.data.failedCount ?? 0) > 0) throw new Error(`素材生产服务有 ${output.data.failedCount} 个游戏资产子任务失败；已保存任务号与结果，可再次补齐。`)
      outputs.integration = { text: '已装配关卡场景、封面、寻找物件图、章节过场和结束视频，并写入可游玩关卡；图片来自 AIHub，视频来自网龙 AI 网关。', rawText: '', data: {} }
      setStageOutputs({ ...outputs })
      setProductionIndex(productionSteps.length - 1)
      setPage('production-record')
      await saveRecord({ ...snapshot('production-record'), productionIndex: productionSteps.length - 1, stageOutputs: { ...outputs }, productionError: null, savedAt: new Date().toISOString() })
    } catch (error) {
      setProductionError(error instanceof Error ? error.message : '完整素材包补齐失败')
      setPage('generating')
    }
  }
  function continueAfterComplete() {
    const finalChapter = activeChapter + 1 >= chapters.length
    const videoUrl = finalChapter ? chapter?.endingVideoUrl : chapter?.transitionVideoUrl
    if (videoUrl) { setPage('cutscene'); return }
    if (finalChapter) setPage('gallery')
    else startChapter(activeChapter + 1)
  }
  function finishCutscene() {
    if (activeChapter + 1 >= chapters.length) setPage('gallery')
    else startChapter(activeChapter + 1)
  }
  function replay() { setFoundIds([]); setWrongClicks(0); setElapsedSeconds(0); setHintCount(0); setReady(false); setComplete(false); setHintText(null); setPage('play') }
  function updateTitle(index: number, title: string) { setChapters((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, title, level: { ...item.level, title } } : item)) }
  function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const preview = URL.createObjectURL(file)
    setDraft((current) => ({ ...current, uploads: [...current.uploads, { name: file.name, purpose: '风格参考', preview }] }))
    event.target.value = ''
  }
  function requestHint(targetId?: string, focus = true) {
    if (focus && hintCount >= 3) return
    const target = targets.find((item) => item.id === targetId) ?? targets.find((item) => !foundIds.includes(item.id))
    if (!target) return
    const targetIndex = targets.findIndex((item) => item.id === target.id)
    setHintText(generatedObjectHint(stageOutputs.code, activeChapter, target.name) ?? templateHint(activeTemplate.id, targetIndex))
    if (focus) {
      setHintCount((count) => count + 1)
      setHintRequest((current) => ({ nonce: current.nonce + 1, targetId: target.id }))
    }
  }
  async function exitToShelf() { if (hasActiveCommissionRef.current) await persistCommission(); onExit() }
  function resumeRecord(record: SavedCommissionRecord) {
    const isBuilt = Boolean(record.stageOutputs?.integration)
    hasActiveCommissionRef.current = true
    setCommissionId(record.id); restoreCommission(record); setShowBuildCompleteNotice(false); setPage(isBuilt ? 'map' : isCreatorPage(record.resumePage) ? record.resumePage : 'brief')
  }
  function openProductionRecord(record: SavedCommissionRecord) {
    hasActiveCommissionRef.current = true
    setCommissionId(record.id); restoreCommission(record); setPage('production-record')
  }
  function deleteRecord(recordId: string) {
    void fetch(apiUrl(`/api/commission/drafts/${recordId}`), { method: 'DELETE' }).catch(() => undefined)
    setSavedRecords((records) => records.filter((record) => record.id !== recordId))
  }

  const isProductionPage = page === 'theme' || page === 'brief' || page === 'outline' || page === 'generating'
  const isPlayablePage = page === 'map' || page === 'story' || page === 'play' || page === 'cutscene' || page === 'notes' || page === 'share'
  const navSection = page === 'drafts' || isProductionPage ? '新建冒险' : '我创作的故事'
  const navLocation = page === 'drafts' ? '草稿箱' : isProductionPage ? '生产工作台' : page === 'production-record' ? '制作记录' : page === 'gallery' ? '故事列表' : '关卡列表'
  // 全屏游玩与过场页不挂全局导航，避免挤压画面
  const isFullscreen = page === 'play' || page === 'cutscene'
  const nav = <>{isFullscreen ? null : appNav}
    <header className="creator-subnav">
    <button type="button" onClick={() => void exitToShelf()}><ArrowLeftIcon />返回书架</button>
    <div className="creator-title"><span className="eyebrow">{navSection}</span><strong>{navLocation}</strong></div>
    <div className="creator-nav-actions">
      {isProductionPage && <span className="creator-save-state">自动保存中</span>}
      {page === 'drafts' && <button type="button" onClick={() => setPage('gallery')}>我的故事</button>}
      {page === 'gallery' && <button type="button" onClick={() => setPage('drafts')}>新建冒险</button>}
      {page === 'production-record' && <button type="button" onClick={() => openMap()}>关卡列表</button>}
      {page === 'production-record' && <button type="button" onClick={() => setPage('gallery')}>我的故事</button>}
      {isPlayablePage && page !== 'map' && <button type="button" onClick={() => openMap()}>关卡列表</button>}
      {isPlayablePage && <button type="button" onClick={() => setPage('gallery')}>我的故事</button>}
    </div>
  </header></>

  const saveNotice = persistenceError && <p className="persistence-error" role="alert">保存失败：{persistenceError}</p>

  const flowSteps = ['设定委托', '确认大纲', '制作关卡', '开始调查']
  const flowProgress = <ol className="creator-flow-progress" aria-label="故事创作进度">
    {flowSteps.map((label, index) => <li className={index < currentFlowStage(page) ? 'is-done' : index === currentFlowStage(page) ? 'is-current' : ''} key={label}><span>{index < currentFlowStage(page) ? <CheckIcon /> : index + 1}</span><b>{label}</b></li>)}
  </ol>
  const outputViewer = selectedStep && selectedOutput && <div className="output-viewer-backdrop" role="presentation" onMouseDown={() => setSelectedOutputStage(null)}><section className="output-viewer" aria-label={`${selectedStep.label}产物`} aria-modal="true" role="dialog" onMouseDown={(event) => event.stopPropagation()}><header><div><h2>{selectedStep.label}</h2></div><button aria-label="关闭产物查看" type="button" onClick={() => setSelectedOutputStage(null)}><CloseIcon /></button></header><p className="output-viewer-summary">{selectedOutput.text}</p><div className="output-viewer-data"><h3>完整产物</h3>{selectedStep.id === 'code' && codeFiles.length > 0 ? codeFiles.map((file, index) => <details key={`${String(file.path)}-${index}`} open={index === 0}><summary>{typeof file.path === 'string' ? file.path : `generated-file-${index + 1}`}</summary><pre><code>{typeof file.content === 'string' ? file.content : '模型未提供文件内容。'}</code></pre></details>) : <pre><code>{JSON.stringify(selectedOutput.data, null, 2)}</code></pre>}</div></section></div>

  if (page === 'drafts') return <main className="creator-shell">{nav}{saveNotice}
    <section className="creator-page drafts-page">
      <div className="drafts-heading"><h2>没写完的草稿</h2><span>{draftRecords.length} 份</span></div>
      {draftRecords.length > 0 ? <section className="draft-story-grid" aria-label="未完成草稿列表">{draftRecords.map((record) => {
        const cover = record.chapters?.[0]?.coverUrl ?? record.chapters?.[0]?.level.scene.backgroundUrl
        const currentStep = productionSteps[Math.min(record.productionIndex ?? 0, productionSteps.length - 1)]
        return <article className="draft-story-card" key={record.id}>
          <div className="draft-story-cover" style={cover ? { backgroundImage: `url(${cover})` } : undefined}><span>{record.productionError ? '制作暂停' : '未完成'}</span></div>
          <div className="draft-story-body"><small>{record.draft?.theme ?? '尚未选择主题'} · {record.draft?.length ?? 1} 章</small><strong>{record.draft?.prompt || '未命名草稿'}</strong><p>{record.productionError || `当前进度：${currentStep?.label ?? '设定委托'}`}</p><time>{new Date(record.savedAt ?? Date.now()).toLocaleString('zh-CN')}</time></div>
          <div className="draft-story-actions"><button className="primary-action" type="button" onClick={() => resumeRecord(record)}>继续创作<ArrowRightIcon /></button><button className="delete-record-button" type="button" onClick={() => deleteRecord(record.id)}>删除</button></div>
        </article>
      })}</section> : <section className="drafts-empty"><DraftIcon /><strong>还没有未完成的草稿</strong><small>开始创作后会自动保存进度。</small></section>}
      <div className="creator-footer"><button className="primary-action" type="button" onClick={startNewCommission}>创建新故事<ArrowRightIcon /></button></div>
    </section>
  </main>

  if (page === 'theme') return <main className="creator-shell">{nav}{saveNotice}
    <section className="creator-page theme-page">{flowProgress}<h1>这次想进入什么样的故事？</h1><p className="theme-page-intro">精选故事已经提供“侦探档案”。这里选择的是故事骨架，它会决定玩家身份、关卡推进和物件在剧情中的意义。</p>
      <div className="theme-grid">{customStoryTemplates.map((template) => <button aria-pressed={activeTemplate.id === template.id} className={activeTemplate.id === template.id ? 'theme-card is-selected' : 'theme-card'} key={template.id} type="button" onClick={() => setDraft((current) => ({ ...current, templateId: template.id, theme: template.title, style: template.recommendedStyle }))}><img alt={`${template.title}故事模板预览`} src={template.imageUrl} /><span className="theme-card-kicker">{template.category}</span><strong>{template.title}</strong><small>{template.description}</small><p>{template.playerRole} · {template.gameplayHook}</p><em>{activeTemplate.id === template.id ? '已选择' : `推荐：${template.recommendedStyle}`}</em></button>)}</div>
      <div className="creator-footer"><button className="primary-action" type="button" onClick={() => setPage('brief')}>继续设定<ArrowRightIcon /></button></div>
    </section>
  </main>

  if (page === 'brief') return <main className="creator-shell">{nav}{saveNotice}
    <section className="creator-page brief-page">{flowProgress}<h1>用一句话描述你的委托</h1>
      <section className="selected-template-summary" aria-label="当前故事模板"><img alt="" src={activeTemplate.imageUrl} /><div><span>当前模板 · {activeTemplate.category}</span><strong>{activeTemplate.title}</strong><p>{activeTemplate.playerRole}；{activeTemplate.narrativeEngine}。</p></div><button type="button" onClick={() => setPage('theme')}>更换模板</button></section>
      <textarea value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder={`例如：${activeTemplate.inspirations[0] ?? '描述你想发生的故事'}`} />
      <div className="inspiration-row"><span>这个模板的灵感：</span>{activeTemplate.inspirations.map((item) => <button key={item} type="button" onClick={() => setDraft((current) => ({ ...current, prompt: item }))}>{item}</button>)}</div>
      <div className="parameter-grid">
        <fieldset><legend>故事长度</legend>{([1, 3, 5] as Length[]).map((value) => <button className={draft.length === value ? 'choice is-selected' : 'choice'} key={value} type="button" onClick={() => setDraft((current) => ({ ...current, length: value }))}>{value === 1 ? '单关' : `${value} 关`}</button>)}</fieldset>
        <fieldset><legend>寻找物件（每关）</legend>{([6, 8, 10, 12] as const).map((value) => <button className={draft.objectCount === value ? 'choice is-selected' : 'choice'} key={value} type="button" onClick={() => setDraft((current) => ({ ...current, objectCount: value }))}>{value} 件</button>)}</fieldset>
        <fieldset><legend>难度</legend>{(['轻松', '标准', '隐蔽'] as Difficulty[]).map((value) => <button className={draft.difficulty === value ? 'choice is-selected' : 'choice'} key={value} type="button" onClick={() => setDraft((current) => ({ ...current, difficulty: value }))}>{value}</button>)}</fieldset>
        <fieldset className="visual-style-field"><legend>美术风格</legend><small>只改变图片和视频表现，不改变故事与玩法。</small>{visualStyles.map((item) => <button aria-pressed={draft.style === item.name} className={draft.style === item.name ? 'choice is-selected' : 'choice'} key={item.name} title={item.description} type="button" onClick={() => setDraft((current) => ({ ...current, style: item.name }))}>{item.name}{item.name === activeTemplate.recommendedStyle && <em>推荐</em>}</button>)}</fieldset>
      </div>
      <section className="upload-panel"><div><b>导入图片</b><small>可作为场景原图、风格参考或指定寻找物件使用。</small></div><label className="upload-button">选择图片<input accept="image/png,image/jpeg,image/webp" type="file" onChange={upload} /></label></section>
      {draft.uploads.length > 0 && <div className="upload-list">{draft.uploads.map((item, index) => <div className="upload-chip" key={`${item.name}-${index}`}>{item.preview && <img alt="已导入图片预览" src={item.preview} />}<select aria-label={`${item.name}的用途`} value={item.purpose} onChange={(event) => setDraft((current) => ({ ...current, uploads: current.uploads.map((uploadItem, uploadIndex) => uploadIndex === index ? { ...uploadItem, purpose: event.target.value as UploadPurpose } : uploadItem) }))}><option>场景原图</option><option>风格参考</option><option>指定物件</option></select><span>{item.name}</span></div>)}</div>}
      <label className="rights-check"><input type="checkbox" defaultChecked /> 我确认拥有导入素材的游戏使用权。</label>
      <div className="creator-footer"><button type="button" onClick={() => setPage('theme')}>上一步</button><button className="primary-action" disabled={!draft.prompt.trim()} type="button" onClick={openOutline}>生成故事大纲<ArrowRightIcon /></button></div>
    </section>
  </main>

  if (page === 'outline') return <main className="creator-shell">{nav}
    <section className="creator-page outline-page">{flowProgress}<h1>你的委托会这样展开</h1><p>标题可以直接改。每一章会单独生成剧情、场景与物件清单。</p>
      <div className="outline-overview"><span>模板：{activeTemplate.title}</span><span>规模：{draft.length === 1 ? '单关故事' : `${draft.length} 关短篇`}</span><span>难度：{draft.difficulty}</span><span>物件：每关 {draft.objectCount} 件</span><span>画风：{draft.style}</span></div>
      <aside className="design-handoff-summary"><span>模型解读</span><p>{outputText(stageOutputs.understanding)} 本故事使用“{activeTemplate.narrativeEngine}”作为骨架，画风只在资源生产阶段生效；主线《失踪制图师与星图》不会被修改。</p></aside>
      {templateCompatibility === 'conflict' && <aside className="template-conflict" role="alert"><div><b>一句话与当前模板可能不匹配</b><p>{templateConflictSuggestion}</p></div><button type="button" onClick={() => setPage('theme')}>更换模板</button></aside>}
      <div className="chapter-outline">{chapters.map((item, index) => <article key={item.level.id}><span>第 {String(index + 1).padStart(2, '0')} 章</span><input aria-label={`第${index + 1}章标题`} value={item.title} onChange={(event) => updateTitle(index, event.target.value)} /><p>{item.summary}</p><small>{item.objective}</small></article>)}</div>
      <div className="creator-footer"><button type="button" onClick={() => setPage('brief')}>返回修改</button><button className="primary-action" type="button" onClick={startProduction}>确认并开始制作<ArrowRightIcon /></button></div>
    </section>
  </main>

  if (page === 'generating') return <main className="creator-shell">{nav}
    <section className="creator-page production-page">{flowProgress}<h1>{productionIndex < 2 ? '正在理解与构思故事…' : productionIndex < 5 ? '正在编排玩法、剧情与资源…' : '正在装配资源与代码…'}</h1><p>这一页的产出只用于制作过程，完成后进入关卡列表。</p>
      <ol className="production-track" aria-label="关卡生成过程记录">{productionSteps.map((step, index) => { const output = stageOutputs[step.id]; const pending = step.id === 'resource-production' && hasPendingAssetTasks; const done = Boolean(output) && !pending; const failed = Boolean(productionError) && index === productionIndex && !done; const active = !failed && (pending || index === productionIndex); return <li className={done ? 'is-done' : failed ? 'is-failed' : active ? 'is-active' : ''} key={step.id}><span>{done ? <CheckIcon /> : failed ? <AlertIcon /> : String(index + 1)}</span><div><b>{step.label} {step.ai && <i>模型</i>}</b><small>{output ? outputText(output) : step.output}</small></div>{output && <button className="view-output-button" type="button" onClick={() => setSelectedOutputStage(step.id)}>查看产物</button>}{!done && <em>{failed ? '失败' : active ? '进行中' : '等待中'}</em>}</li> })}</ol>
      {assetTasks.length > 0 && <AssetTaskGroups tasks={assetTasks} />}
      {productionError && <div className="production-error" role="alert"><b>制作暂停</b><p>{productionError}</p><div className="production-error-actions"><button className="primary-action" type="button" onClick={() => productionIndex < 2 ? openOutline() : retryProduction(false)}>{hasPermissionDeniedTasks ? '继续生产可用素材' : '重试当前流程'}</button>{hasPermissionDeniedTasks && <button type="button" onClick={() => retryProduction(true)}>权限已开通，重试受限素材</button>}</div></div>}
    </section>{outputViewer}
  </main>

  if (page === 'production-record') return <main className="creator-shell">{nav}
    <section className="creator-page production-record-page"><h1>{draft.prompt || chapters[0]?.title || '未命名故事'}</h1><p>缺失的素材可以在这份档案上继续补齐。</p>
      <section className="production-record-summary" aria-label="制作记录摘要"><span>{assetPackage.complete ? <CheckIcon /> : <AlertIcon />}</span><div><strong>{assetPackage.complete ? '完整素材包已完成' : '关卡基础版已完成，素材包待补齐'}</strong><small>{productionSteps.filter((step) => stageOutputs[step.id]).length} / {productionSteps.length} 个节点已归档 · 素材 {assetPackage.completedTotal} / {assetPackage.requiredTotal} 项</small></div>{!assetPackage.complete && <button className="primary-action" type="button" onClick={() => void backfillAssetPackage()}>补齐缺失素材</button>}</section>
      <section className="asset-package-grid" aria-label="完整素材包进度">{Object.entries(assetPackage.required).map(([kind, required]) => <div className={(assetPackage.completed[kind] ?? 0) >= required ? 'is-complete' : ''} key={kind}><span>{assetKindLabel({ assetKind: kind })}</span><strong>{Math.min(assetPackage.completed[kind] ?? 0, required)} / {required}</strong></div>)}</section>
      <ol className="production-track production-track-archive" aria-label="已完成的关卡生成流水线">{productionSteps.map((step, index) => { const output = stageOutputs[step.id]; return <li className={output ? 'is-done' : ''} key={step.id}><span>{output ? <CheckIcon /> : String(index + 1)}</span><div><b>{step.label} {step.ai && <i>模型</i>}</b><small>{output ? outputText(output) : '该节点没有保存产物'}</small></div>{output ? <button className="view-output-button" type="button" onClick={() => setSelectedOutputStage(step.id)}>查看产物</button> : <em>无记录</em>}</li> })}</ol>
      {assetTasks.length > 0 && <AssetTaskGroups tasks={assetTasks} archived />}
      {codeFiles.length > 0 && <section className="production-record-files" aria-label="已归档的代码文件"><div><h2>代码文件</h2><span>{codeFiles.length} 个文件已归档</span></div><ul>{codeFiles.map((file, index) => <li key={`${String(file.path)}-${index}`}>{typeof file.path === 'string' ? file.path : `generated-file-${index + 1}`}</li>)}</ul><button className="view-output-button" type="button" onClick={() => setSelectedOutputStage('code')}>查看代码内容</button></section>}
      <div className="map-actions"><button className="primary-action" type="button" onClick={() => openMap()}>进入关卡列表</button><button type="button" onClick={() => setPage('gallery')}>返回故事列表</button></div>
    </section>{outputViewer}
  </main>

  if (page === 'map') return <main className="creator-shell">{nav}
    <section className="creator-page map-page"><h1>{chapters[0]?.title.replace(/：.*/, '') ?? '我创作的故事'}</h1><p>{activeTemplate.ui.mapIntro}</p>
      {showBuildCompleteNotice && <div className="map-completion" role="status"><span aria-hidden="true"><CheckIcon /></span><strong>关卡搭建已完成</strong></div>}
      <div className="story-map">{chapters.map((item, index) => { const done = completedChapterIds.includes(item.level.id); const unlocked = index === 0 || completedChapterIds.includes(chapters[index - 1].level.id); return <button className={unlocked ? 'map-node is-open' : 'map-node'} disabled={!unlocked} key={item.level.id} type="button" onClick={() => unlocked && startChapter(index)}>{item.coverUrl && <span aria-hidden="true" className="map-node-cover" style={{ backgroundImage: `url(${item.coverUrl})` }} />}<span className="map-node-status">{done ? <CheckIcon /> : unlocked ? <PlayIcon /> : <LockIcon />}</span><b>第 {index + 1} 章</b><small>{item.title}</small><em>{done ? `已完成 · ${activeTemplate.ui.replay}` : unlocked ? activeTemplate.ui.start : '待解锁'}</em></button> })}</div>
      <div className="map-actions"><button className="primary-action" type="button" onClick={() => startChapter(0)}>查看关卡</button><button type="button" onClick={() => setPage('gallery')}>返回</button></div>
    </section>
  </main>

  if (page === 'story' && chapter) return <main className="creator-shell story-shell">{nav}
    <section className="story-page"><img alt="本章封面" src={chapter.coverUrl ?? chapter.level.scene.backgroundUrl} /><div className="story-copy"><p className="eyebrow">第 {activeChapter + 1} 章</p><h1>{chapter.title}</h1><p>{chapter.caseFile}</p><blockquote>“{chapter.objective}”</blockquote><button className="primary-action" type="button" onClick={() => setPage('play')}>{activeTemplate.ui.enter}<ArrowRightIcon /></button></div></section>
  </main>

  if (page === 'play' && chapter) return <main className="creator-shell commission-game">{nav}
    <header className="commission-hud"><div><p className="eyebrow">第 {activeChapter + 1} 章</p><h1>{chapter.title}</h1></div><div className="commission-stats"><span><ClockIcon />{String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')}</span><strong>{foundIds.length} / {targets.length}</strong></div></header>
    <section className="commission-play-area" style={{ aspectRatio: `${chapter.level.scene.width} / ${chapter.level.scene.height}` }}>{!ready && <div className="loading">正在布置隐藏线索…</div>}<PhaserGame key={chapter.level.id} hintRequest={hintRequest} level={chapter.level} onReady={handleChapterReady} onFound={handleChapterFound} onWrongClick={handleChapterWrongClick} onComplete={handleChapterComplete} /></section>
    <section className="commission-mission"><button className="hint-button" type="button" onClick={() => requestHint()} disabled={complete || hintCount >= 3}><BulbIcon />提示 {3 - hintCount}</button>{targets.map((item) => <button aria-label={`提示：${item.name}`} className={foundIds.includes(item.id) ? 'target-card is-found' : 'target-card'} disabled={foundIds.includes(item.id)} key={item.id} type="button" onClick={() => requestHint(item.id, false)}>{foundIds.includes(item.id) ? <CheckIcon /> : <img alt="" src={item.thumbnailUrl} />}</button>)}<span>道具：提示 {3 - hintCount}/3<br />误判 {wrongClicks} 次</span></section>
    {hintText && <div className="hint-toast" role="status">{hintText}</div>}
    {complete && <div className="completion" role="dialog" aria-modal="true" aria-label="本章结算"><div className="completion-card"><p className="eyebrow">{activeChapter + 1 === chapters.length ? '故事已完成' : '本章已完成'}</p><h2>{activeChapter + 1 === chapters.length ? activeTemplate.endingPattern : activeTemplate.ui.complete}</h2><p>{activeChapter + 1 < chapters.length && chapter.transitionVideoUrl ? '正在播放章节过场…' : chapter.summary}</p><div className="completion-actions"><button type="button" onClick={continueAfterComplete}>{activeChapter + 1 < chapters.length ? chapter.transitionVideoUrl ? '立即观看过场' : '前往下一章' : chapter.endingVideoUrl ? '立即观看结束动画' : '返回我创作的故事'}<ArrowRightIcon /></button><button className="secondary-action" type="button" onClick={replay}>{activeTemplate.ui.replay}</button></div></div></div>}
  </main>

  if (page === 'cutscene' && chapter) { const isEnding = activeChapter + 1 >= chapters.length; const videoUrl = isEnding ? chapter.endingVideoUrl : chapter.transitionVideoUrl; return <main className="creator-shell commission-cutscene-shell">{nav}<section className="commission-cutscene"><video autoPlay controls muted playsInline src={videoUrl} onEnded={finishCutscene} /><div><p className="eyebrow">{isEnding ? '故事终章' : '章节过场'}</p><h1>{isEnding ? '故事已经结束' : `下一章：${chapters[activeChapter + 1]?.title ?? ''}`}</h1><button className="primary-action" type="button" onClick={finishCutscene}>{isEnding ? '返回我的故事' : '跳过并继续'}<ArrowRightIcon /></button></div></section></main> }

  if (page === 'notes') return <main className="creator-shell">{nav}
    <section className="creator-page notes-page"><h1>{activeTemplate.ui.notesTitle}</h1><div className="notes-list">{chapters.map((item, index) => <article key={item.level.id}><span>第 {index + 1} 章</span><h2>{item.title}</h2><p>{item.caseFile}</p><small>{item.objective}</small></article>)}</div><div className="creator-footer"><button type="button" onClick={() => openMap()}>返回章节地图</button><button className="primary-action" type="button" onClick={() => setPage('share')}>生成分享预览<ArrowRightIcon /></button></div></section>
  </main>

  if (page === 'gallery') return <main className="creator-shell">{nav}{saveNotice}
    <section className="creator-page gallery-page"><h1>我创作的故事</h1>
      {createdRecords.length > 0 ? <section className="created-story-grid" aria-label="我创作的故事列表">{createdRecords.map((record) => {
        const built = Boolean(record.stageOutputs?.integration)
        const finishedCount = record.completedChapterIds?.length ?? 0
        const chapterCount = record.chapters?.length ?? record.draft?.length ?? 1
        const storyFinished = built && finishedCount >= chapterCount
        const cover = record.chapters?.[0]?.coverUrl ?? record.chapters?.[0]?.level.scene.backgroundUrl
        return <article className="created-story-card" key={record.id}>
          <div className="created-story-cover" style={cover ? { backgroundImage: `url(${cover})` } : undefined}><span>{record.productionError ? '制作暂停' : storyFinished ? '故事已完成' : built ? '关卡搭建已完成' : '制作中'}</span></div>
          <div className="created-story-body"><small>{record.draft?.theme ?? '原创故事'} · {chapterCount} 章</small><strong>{record.draft?.prompt || record.chapters?.[0]?.title || '未命名故事'}</strong><p>{record.productionError || `${record.draft?.style ?? '自定义画风'} · ${record.draft?.difficulty ?? '标准'}难度`}</p><div className="created-story-progress"><span style={{ width: `${chapterCount ? Math.min(100, finishedCount / chapterCount * 100) : 0}%` }} /><small>{storyFinished ? '全部章节已完成' : built ? `游玩进度 ${finishedCount}/${chapterCount}` : '等待关卡搭建完成'}</small></div></div>
          <div className="created-story-actions"><button className="primary-action" type="button" onClick={() => resumeRecord(record)}>{built ? '查看关卡' : '继续制作'}<ArrowRightIcon /></button>{built && <button className="production-record-button" type="button" onClick={() => openProductionRecord(record)}>制作记录</button>}<button className="delete-record-button" type="button" onClick={() => deleteRecord(record.id)}>删除</button></div>
        </article>
      })}</section> : <section className="resume-commission is-empty" aria-label="我创作的故事列表"><div><strong>还没有完成的故事</strong><small>还没搭建完的故事在草稿箱里。</small></div><button className="primary-action" type="button" onClick={() => setPage('drafts')}>查看草稿<ArrowRightIcon /></button></section>}
      <div className="creator-footer"><button className="primary-action" type="button" onClick={startNewCommission}>新建冒险<ArrowRightIcon /></button></div></section>
  </main>

  return <main className="creator-shell">{nav}<section className="creator-page share-page"><div className="share-preview"><span>我创作的寻物故事</span><h1>{chapters[0]?.title.replace(/：.*/, '') ?? '新建冒险'}</h1><p>{draft.prompt || '一段等待开启的神秘故事'}</p><small>#{draft.theme} #{draft.style} #{draft.difficulty}寻物</small></div><div className="share-actions"><button type="button">复制主题码</button><button type="button">生成分享图</button><button className="primary-action" type="button" onClick={() => setPage('gallery')}>返回故事列表</button></div></section></main>
}
