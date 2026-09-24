import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadStoryLevels, mainStoryFinale } from './story-levels'

function bounds(object: { x: number; y: number; width: number; height: number; hitPadding: number }, scene: { width: number; height: number }) {
  const width = object.width + object.hitPadding * 2
  const height = object.height + object.hitPadding * 2
  return {
    left: object.x * scene.width - width / 2,
    right: object.x * scene.width + width / 2,
    top: object.y * scene.height - height / 2,
    bottom: object.y * scene.height + height / 2,
  }
}

describe('fixed V0.1 levels', () => {
  it('validates and contains five playable eight-target chapters', () => {
    const result = loadStoryLevels()
    expect(result.error).toBeUndefined()
    expect(result.levels).toHaveLength(5)
    for (const story of result.levels) {
      expect(story.level.mission.targetIds).toHaveLength(8)
      expect(new Set(story.level.mission.targetIds).size).toBe(8)
      expect(story.level.objects.every((object) => object.spriteUrl.endsWith('.png'))).toBe(true)
      for (const targetId of story.level.mission.targetIds) {
        expect(story.hintSet[targetId], `${story.level.id}: ${targetId} is missing staged hints`).toHaveLength(3)
      }
    }
  })

  it('ships every background and target sprite used by the three levels', () => {
    const result = loadStoryLevels()
    for (const story of result.levels) {
      const urls = [story.level.scene.backgroundUrl, story.outro.videoUrl, ...story.level.objects.map((object) => object.spriteUrl)]
      for (const url of urls) expect(existsSync(resolve(process.cwd(), 'public', `.${url}`))).toBe(true)
    }
    expect(existsSync(resolve(process.cwd(), 'public', `.${mainStoryFinale.videoUrl}`))).toBe(true)
  })

  it('keeps padded target hit areas separate', () => {
    const result = loadStoryLevels()
    for (const story of result.levels) {
      const { objects, scene } = story.level
      for (let index = 0; index < objects.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < objects.length; otherIndex += 1) {
          const first = bounds(objects[index], scene)
          const second = bounds(objects[otherIndex], scene)
          const overlaps = first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top
          expect(overlaps, `${story.level.id}: ${objects[index].id} overlaps ${objects[otherIndex].id}`).toBe(false)
        }
      }
    }
  })
})
