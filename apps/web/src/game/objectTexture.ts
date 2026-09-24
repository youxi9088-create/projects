export interface CutoutPixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

function borderColor(data: Uint8ClampedArray, width: number, height: number) {
  const points = [
    [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
    [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
    [0, Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
  ]
  const channels = [0, 1, 2].map((channel) => points.map(([x, y]) => data[(y * width + x) * 4 + channel]).sort((a, b) => a - b))
  return channels.map((values) => values[Math.floor(values.length / 2)])
}

/** Removes an opaque, nearly uniform border background and crops to the visible object. */
export function cutOutObjectPixels(source: Uint8ClampedArray, width: number, height: number, paddingRatio = 0.08): CutoutPixels {
  const data = new Uint8ClampedArray(source)
  let hasTransparency = false
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] < 245) { hasTransparency = true; break }
  }
  const [backgroundRed, backgroundGreen, backgroundBlue] = borderColor(data, width, height)
  let left = width
  let top = height
  let right = -1
  let bottom = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (!hasTransparency) {
        const distance = Math.max(Math.abs(data[offset] - backgroundRed), Math.abs(data[offset + 1] - backgroundGreen), Math.abs(data[offset + 2] - backgroundBlue))
        data[offset + 3] = distance <= 10 ? 0 : distance >= 42 ? 255 : Math.round((distance - 10) / 32 * 255)
      }
      if (data[offset + 3] > 24) {
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
  }

  if (right < left || bottom < top) return { data, width, height }
  const objectWidth = right - left + 1
  const objectHeight = bottom - top + 1
  const padding = Math.max(0, Math.round(Math.max(objectWidth, objectHeight) * paddingRatio))
  left = Math.max(0, left - padding)
  top = Math.max(0, top - padding)
  right = Math.min(width - 1, right + padding)
  bottom = Math.min(height - 1, bottom + padding)
  const resultWidth = right - left + 1
  const resultHeight = bottom - top + 1
  const result = new Uint8ClampedArray(resultWidth * resultHeight * 4)
  for (let y = 0; y < resultHeight; y += 1) {
    const sourceStart = ((top + y) * width + left) * 4
    result.set(data.subarray(sourceStart, sourceStart + resultWidth * 4), y * resultWidth * 4)
  }
  return { data: result, width: resultWidth, height: resultHeight }
}
