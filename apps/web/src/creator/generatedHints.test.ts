import { describe, expect, it } from 'vitest'
import { generatedObjectHint } from './generatedHints'

describe('generatedObjectHint', () => {
  const output = {
    data: {
      files: [{
        path: 'levels/story.json',
        content: JSON.stringify({
          levels: [
            { objects: [{ name: '毛线球', hint: '它滚到一堆书前面啦。' }] },
            { objects: [{ name: '毛线球', hint: '它贴着云朵坐垫边。' }] },
          ],
        }),
      }],
    },
  }

  it('uses the hint generated for the current chapter and target', () => {
    expect(generatedObjectHint(output, 0, '毛线球')).toBe('它滚到一堆书前面啦。')
    expect(generatedObjectHint(output, 1, '毛线球')).toBe('它贴着云朵坐垫边。')
  })

  it('ignores invalid generated files', () => {
    expect(generatedObjectHint({ data: { files: [{ content: '{broken' }] } }, 0, '毛线球')).toBeUndefined()
  })
})
