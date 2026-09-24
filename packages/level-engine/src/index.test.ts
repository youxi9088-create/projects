import { describe, expect, it } from 'vitest'
import { generateLevel, interpretPrompt, mulberry32 } from './index'

describe('level engine', () => {
  it('produces repeatable random values', () => {
    const first = mulberry32(12)
    const second = mulberry32(12)
    expect([first(), first(), first()]).toEqual([second(), second(), second()])
  })

  it('maps a nautical prompt to a playable seeded level', () => {
    const intent = interpretPrompt('雾港海盗船长的船舱，寻找航海线索')
    const level = generateLevel(intent, 'sea-7')
    expect(level.scene.backgroundUrl).toContain('fog-harbor-cabin')
    expect(level.mission.targetIds).toHaveLength(8)
    expect(level.objects.every((object) => object.spriteUrl.endsWith('.png'))).toBe(true)
    expect(generateLevel(intent, 'sea-7')).toEqual(level)
  })
})
