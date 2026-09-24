import { describe, expect, it } from 'vitest'
import { LevelSchema } from './level.schema'
import { validateLevel } from './level-validation'

const level = {
  version: '1.0',
  id: 'fixture-level',
  title: 'Fixture',
  seed: 'seed-1',
  source: 'preset',
  scene: { backgroundUrl: '/scene.jpg', width: 1536, height: 1024 },
  mission: { type: 'find', targetIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
  objects: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, index) => ({
    id,
    name: id,
    spriteUrl: `/${id}.png`,
    thumbnailUrl: `/${id}.jpg`,
    hint: `${id} hint`,
    target: true,
    x: index / 10,
    y: index / 10,
    width: 80,
    height: 80,
  })),
}

describe('LevelSchema', () => {
  it('accepts an eight-target preset level', () => {
    expect(LevelSchema.safeParse(level).success).toBe(true)
  })

  it('rejects a target outside normalized coordinates', () => {
    const invalid = structuredClone(level)
    invalid.objects[0].x = 1.1
    expect(LevelSchema.safeParse(invalid).success).toBe(false)
  })

  it('returns a readable message for a missing target id', () => {
    const invalid = structuredClone(level)
    invalid.mission.targetIds[0] = 'missing-object'
    const result = validateLevel(invalid)
    expect(result).toEqual({ ok: false, message: '关卡配置错误：任务目标不存在（missing-object）' })
  })
})
