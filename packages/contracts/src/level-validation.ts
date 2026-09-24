import { LevelSchema, type Level } from './level.schema.js'

export type LevelValidationResult =
  | { ok: true; level: Level }
  | { ok: false; message: string }

export function validateLevel(input: unknown): LevelValidationResult {
  const parsed = LevelSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const path = firstIssue?.path.join('.') || '根节点'
    return { ok: false, message: `关卡配置错误：${path} ${firstIssue?.message ?? '无效'}` }
  }

  const ids = new Set(parsed.data.objects.map((object) => object.id))
  const missingTargets = parsed.data.mission.targetIds.filter((id) => !ids.has(id))
  if (missingTargets.length > 0) {
    return { ok: false, message: `关卡配置错误：任务目标不存在（${missingTargets.join('、')}）` }
  }

  if (new Set(parsed.data.mission.targetIds).size !== parsed.data.mission.targetIds.length) {
    return { ok: false, message: '关卡配置错误：任务目标不能重复。' }
  }

  return { ok: true, level: parsed.data }
}
