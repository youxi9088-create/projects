import { z } from 'zod'

export const LevelObjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  spriteUrl: z.string().min(1),
  thumbnailUrl: z.string().min(1),
  hint: z.string().min(1),
  target: z.literal(true),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive(),
  height: z.number().positive(),
  hitPadding: z.number().nonnegative().default(8),
})

export const LevelSchema = z.object({
  version: z.literal('1.0'),
  id: z.string(),
  title: z.string(),
  seed: z.string(),
  source: z.literal('preset'),
  scene: z.object({
    backgroundUrl: z.string(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  mission: z.object({
    type: z.literal('find'),
    targetIds: z.array(z.string()).length(8),
  }),
  objects: z.array(LevelObjectSchema).length(8),
})

export type Level = z.infer<typeof LevelSchema>
