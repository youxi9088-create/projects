type GeneratedCodeOutput = {
  data?: {
    files?: unknown
  }
}

type GeneratedObject = {
  name?: unknown
  hint?: unknown
}

type GeneratedLevel = {
  objects?: unknown
}

function parsedLevels(content: unknown): GeneratedLevel[] {
  if (typeof content !== 'string') return []
  try {
    const document = JSON.parse(content) as { levels?: unknown }
    return Array.isArray(document.levels)
      ? document.levels.filter((level): level is GeneratedLevel => Boolean(level && typeof level === 'object'))
      : []
  } catch {
    return []
  }
}

export function generatedObjectHint(output: GeneratedCodeOutput | undefined, chapterIndex: number, targetName: string) {
  const files = output?.data?.files
  if (!Array.isArray(files)) return undefined

  for (const file of files) {
    if (!file || typeof file !== 'object') continue
    const levels = parsedLevels((file as { content?: unknown }).content)
    const objects = levels[chapterIndex]?.objects
    if (!Array.isArray(objects)) continue
    const target = objects.find((item): item is GeneratedObject => Boolean(item && typeof item === 'object' && (item as GeneratedObject).name === targetName))
    if (target && typeof target.hint === 'string' && target.hint.trim()) return target.hint.trim()
  }

  return undefined
}
