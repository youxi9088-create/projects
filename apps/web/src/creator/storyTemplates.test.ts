import { describe, expect, it } from 'vitest'
import { customStoryTemplates, storyBeatsForLength, storyTemplateModelProfile } from './storyTemplates'

describe('custom story templates', () => {
  it('provides four genuinely distinct story skeletons and recommended art styles', () => {
    expect(customStoryTemplates).toHaveLength(4)
    expect(new Set(customStoryTemplates.map((item) => item.narrativeEngine)).size).toBe(4)
    expect(new Set(customStoryTemplates.map((item) => item.gameplayHook)).size).toBe(4)
    expect(new Set(customStoryTemplates.map((item) => item.recommendedStyle)).size).toBe(4)
    expect(new Set(customStoryTemplates.map((item) => item.imageUrl)).size).toBe(4)
  })

  it('adapts every template to one, three or five chapters', () => {
    for (const template of customStoryTemplates) {
      expect(storyBeatsForLength(template, 1)).toHaveLength(1)
      expect(storyBeatsForLength(template, 3)).toHaveLength(3)
      expect(storyBeatsForLength(template, 5)).toHaveLength(5)
    }
  })

  it('keeps visual presentation out of the narrative model profile', () => {
    const profile = storyTemplateModelProfile(customStoryTemplates[0])
    expect(profile).not.toHaveProperty('recommendedStyle')
    expect(profile).not.toHaveProperty('imageUrl')
    expect(profile).toHaveProperty('narrativeEngine')
    expect(profile).toHaveProperty('objectSemantics')
  })
})
