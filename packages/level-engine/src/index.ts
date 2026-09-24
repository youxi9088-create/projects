import { validateLevel, type Level } from '@hog/contracts'
import { z } from 'zod'

export const LevelIntentSchema = z.object({
  theme: z.string().min(1),
  sceneTags: z.array(z.string()).min(1),
  requestedObjects: z.array(z.string()).max(12).default([]),
})

export type LevelIntent = z.infer<typeof LevelIntentSchema>

type TemplateObject = Omit<Level['objects'][number], 'x' | 'y' | 'width' | 'height'>
interface SceneTemplate {
  id: string
  title: string
  tags: string[]
  backgroundUrl: string
  storyHint: string
  placements: Array<{ x: number; y: number; width: number; height: number }>
  objects: TemplateObject[]
}

const shared = (id: string, name: string, sprite: string, hint: string): TemplateObject => ({
  id, name, spriteUrl: `/content/objects/${sprite}.png`, thumbnailUrl: `/content/objects/${sprite}.png`, hint, target: true, hitPadding: 8,
})

const templates: SceneTemplate[] = [
  {
    id: 'detective-office', title: '雨夜侦探书桌', tags: ['detective', 'office', 'rainy', '书房'], backgroundUrl: '/content/scenes/detective-office-layered.jpg', storyHint: '书桌上的遗物仍在等待被辨认。',
    placements: [{ x: .443, y: .392, width: 76, height: 76 }, { x: .273, y: .54, width: 205, height: 153 }, { x: .502, y: .418, width: 48, height: 50 }, { x: .828, y: .664, width: 285, height: 240 }, { x: .76, y: .4, width: 138, height: 220 }, { x: .371, y: .799, width: 210, height: 151 }, { x: .611, y: .493, width: 174, height: 112 }, { x: .19, y: .799, width: 166, height: 165 }],
    objects: [shared('pocket-watch', '怀表', 'office-1', '烛影里，时间正替侦探守候。'), shared('sealed-letter', '封蜡信件', 'office-2', '被火漆封存的秘密，静卧在纸页之间。'), shared('brass-key', '黄铜钥匙', 'office-3', '金属的答案，靠在时间的身旁。'), shared('case-file', '案件档案', 'office-4', '卷宗的分量，压住未完的真相。'), shared('magnifying-glass', '放大镜', 'office-5', '放大迷雾的圆眼，伏在地图边。'), shared('evidence-photo', '证据照片', 'office-6', '褪色的街景，记得昨天的脚步。'), shared('fountain-pen', '钢笔', 'office-7', '黑金笔尖，仍在案卷上停留。'), shared('camera', '相机', 'office-8', '双眼见证者，藏在桌角阴影中。')],
  },
  {
    id: 'old-city-archive', title: '旧城档案馆', tags: ['archive', 'library', 'museum', '档案馆', '图书馆'], backgroundUrl: '/content/scenes/old-city-archive-layered.jpg', storyHint: '旧档案的夹层里，藏着一段未公开的航向。',
    placements: [{ x: .303, y: .484, width: 105, height: 160 }, { x: .561, y: .441, width: 155, height: 110 }, { x: .406, y: .498, width: 145, height: 100 }, { x: .44, y: .67, width: 68, height: 68 }, { x: .14, y: .762, width: 125, height: 145 }, { x: .744, y: .41, width: 185, height: 120 }, { x: .87, y: .276, width: 130, height: 155 }, { x: .898, y: .09, width: 135, height: 105 }],
    objects: [shared('oil-lamp', '油灯', 'archive-1', '一盏旧火，在案桌边替无人值守。'), shared('typewriter', '打字机', 'archive-2', '密档的声音，藏在纸页与金属字键之间。'), shared('sealed-letter', '封蜡信件', 'archive-3', '红色封印压住了制图师留下的姓名。'), shared('pocket-watch', '怀表', 'archive-4', '滴答声落在桌沿前，像一次被改写的约定。'), shared('camera', '相机', 'archive-5', '桌角的黑色见证者，拍下了不该遗失的一页。'), shared('travel-chest', '旅行箱', 'archive-6', '尘封的行李，尚未等到真正的主人。'), shared('armillary', '浑仪', 'archive-7', '黄铜星轨绕着旧世界，指向一片雾港。'), shared('ship-model', '帆船模型', 'archive-8', '高处停泊的小船，替下一站报出了航向。')],
  },
  {
    id: 'fog-harbor-cabin', title: '雾港船长舱', tags: ['pirate', 'ship', 'harbor', 'nautical', '船舱', '海盗'], backgroundUrl: '/content/scenes/fog-harbor-cabin-layered.jpg', storyHint: '船长舱的航线仍在雨雾中指向真相。',
    placements: [{ x: .602, y: .208, width: 245, height: 95 }, { x: .467, y: .248, width: 90, height: 135 }, { x: .5, y: .47, width: 260, height: 100 }, { x: .353, y: .605, width: 150, height: 125 }, { x: .581, y: .576, width: 52, height: 52 }, { x: .623, y: .566, width: 43, height: 43 }, { x: .868, y: .804, width: 130, height: 145 }, { x: .718, y: .89, width: 185, height: 88 }],
    objects: [shared('telescope', '望远镜', 'cabin-1', '穿过雨雾的长眼，仍望着未归的船影。'), shared('lantern', '航海灯', 'cabin-2', '舱窗旁的暖光，替夜航者留下一道门。'), shared('star-chart', '星图', 'cabin-3', '航线的答案铺在桌心，星辰替它标了记号。'), shared('sextant', '六分仪', 'cabin-4', '测量天海夹角的黄铜弧线，伏在地图下缘。'), shared('pocket-watch', '怀表', 'cabin-5', '码头钟声未响，时间先在航图右侧停住。'), shared('brass-key', '黄铜钥匙', 'cabin-6', '开锁的金属答案，紧挨着那段停摆时刻。'), shared('camera', '相机', 'cabin-7', '靠近船舷的镜头，保留了港口最后一帧。'), shared('sealed-letter', '封蜡信件', 'cabin-8', '火漆落在船长桌上，终于把谜底封成一句话。')],
  },
]

function hash(input: string) { let value = 2166136261; for (const char of input) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619) }; return value >>> 0 }
export function mulberry32(seed: number) { return () => { let value = seed += 0x6D2B79F5; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296 } }

export function interpretPrompt(prompt: string): LevelIntent {
  const normalized = prompt.toLowerCase()
  const tags = normalized.includes('海') || normalized.includes('船') || normalized.includes('pirate') ? ['ship', 'harbor']
    : normalized.includes('档') || normalized.includes('图书') || normalized.includes('museum') ? ['archive', 'library']
      : ['detective', 'office']
  return { theme: prompt.trim() || '神秘案件', sceneTags: tags, requestedObjects: [] }
}

export function generateLevel(intentInput: unknown, seed = 'default-seed'): Level {
  const intent = LevelIntentSchema.parse(intentInput)
  const rng = mulberry32(hash(`${intent.theme}:${seed}`))
  const matches = templates.filter((template) => template.tags.some((tag) => intent.sceneTags.includes(tag)))
  const template = (matches.length ? matches : templates)[Math.floor(rng() * (matches.length || templates.length))]
  const objects = template.objects.map((object, index) => ({ ...object, ...template.placements[index] }))
  const level = { version: '1.0' as const, id: `generated-${template.id}-${hash(`${intent.theme}:${seed}`).toString(36)}`, title: `${template.title} · 即时委托`, seed, source: 'preset' as const, scene: { backgroundUrl: template.backgroundUrl, width: 1536, height: 1024 }, mission: { type: 'find' as const, targetIds: objects.map((object) => object.id) }, objects }
  const result = validateLevel(level)
  if (!result.ok) throw new Error(result.message)
  return result.level
}

export const sceneCatalog = templates.map(({ id, title, tags }) => ({ id, title, tags }))
