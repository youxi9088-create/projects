import { describe, expect, it } from 'vitest'
import { cutOutObjectPixels } from './objectTexture'

describe('cutOutObjectPixels', () => {
  it('removes a solid border and crops to the same generated object', () => {
    const width = 4
    const height = 4
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
      const offset = (y * width + x) * 4
      pixels[offset] = 180
      pixels[offset + 1] = 80
      pixels[offset + 2] = 40
      pixels[offset + 3] = 255
    }

    const result = cutOutObjectPixels(pixels, width, height, 0)

    expect(result.width).toBe(2)
    expect(result.height).toBe(2)
    expect([...result.data]).toEqual([180, 80, 40, 255, 180, 80, 40, 255, 180, 80, 40, 255, 180, 80, 40, 255])
  })
})
