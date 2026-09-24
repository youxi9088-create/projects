import Phaser from 'phaser'
import type { Level } from '@hog/contracts'
import { cutOutObjectPixels } from './objectTexture'

export interface GameCallbacks {
  onFound: (id: string) => void
  onWrongClick: () => void
  onComplete: () => void
  onReady: () => void
}

type TargetSprite = Phaser.GameObjects.Image

const TARGET_OPACITY_BY_LEVEL: Record<string, number> = {
  'detective-office-rainy-01': 0.64,
  'old-city-archive-02': 0.58,
  'fog-harbor-cabin-03': 0.54,
  'tide-clocktower-vault-04': 0.5,
  'mapmaker-secret-workshop-05': 0.46,
}

export class DetectiveOfficeScene extends Phaser.Scene {
  private readonly hotspots = new Map<string, TargetSprite>()
  private readonly foundIds = new Set<string>()
  private readonly level: Level
  private readonly callbacks: GameCallbacks
  private dragStart?: Phaser.Math.Vector2
  private isDragging = false

  constructor(level: Level, callbacks: GameCallbacks) {
    super('detective-office')
    this.level = level
    this.callbacks = callbacks
  }

  preload() {
    this.load.image('detective-office', this.level.scene.backgroundUrl)
    for (const object of this.level.objects) this.load.image(`target-${object.id}`, object.spriteUrl)
  }

  private prepareTargetTexture(objectId: string) {
    const sourceKey = `target-${objectId}`
    const cutoutKey = `${sourceKey}-cutout`
    const source = this.textures.get(sourceKey).getSourceImage() as CanvasImageSource & { width: number; height: number }
    try {
      const canvas = document.createElement('canvas')
      // 游戏内物件最终只显示几十到一百多像素；先缩到 512px 可避免处理 AI 原图时阻塞进场。
      const preparationScale = Math.min(1, 512 / Math.max(source.width, source.height))
      canvas.width = Math.max(1, Math.round(source.width * preparationScale))
      canvas.height = Math.max(1, Math.round(source.height * preparationScale))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return sourceKey
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
      const cutout = cutOutObjectPixels(imageData.data, imageData.width, imageData.height)
      const texture = this.textures.createCanvas(cutoutKey, cutout.width, cutout.height)
      if (!texture) return sourceKey
      const cutoutContext = texture.getContext()
      const cutoutImage = cutoutContext.createImageData(cutout.width, cutout.height)
      cutoutImage.data.set(cutout.data)
      cutoutContext.putImageData(cutoutImage, 0, 0)
      texture.refresh()
      return cutoutKey
    } catch {
      // 本地生成资源通常可读取像素；若浏览器因跨域阻止画布读取，仍保留原图可玩。
      return sourceKey
    }
  }

  create() {
    const { width, height } = this.level.scene
    this.add.image(0, 0, 'detective-office').setOrigin(0).setDisplaySize(width, height)
    this.cameras.main.setBounds(0, 0, width, height)
    this.cameras.main.setZoom(1)

    for (const object of this.level.objects) {
      const hotspot = this.add.image(object.x * width, object.y * height, this.prepareTargetTexture(object.id))
      const texture = hotspot.texture.getSourceImage() as { width: number; height: number }
      const scale = Math.min(object.width / texture.width, object.height / texture.height)
      // Sprite 保留原始比例与独立命中区。它需要清楚地存在于桌面上，
      // 但按章节逐步降低可见度，让后续关卡仍保有观察难度。
      hotspot.setScale(scale).setAlpha(TARGET_OPACITY_BY_LEVEL[this.level.id] ?? 0.54)

      // Phaser 会把指针反算回贴图本地坐标。因此命中区必须使用原始贴图尺寸，
      // 不能使用 displayWidth / displayHeight（那会在缩放后再被缩小一次）。
      const rawPadding = object.hitPadding / scale
      hotspot.setInteractive(
        new Phaser.Geom.Rectangle(
          -rawPadding,
          -rawPadding,
          texture.width + rawPadding * 2,
          texture.height + rawPadding * 2,
        ),
        Phaser.Geom.Rectangle.Contains,
      )
      hotspot.setData('objectId', object.id)
      hotspot.on('pointerup', () => this.tryFind(object.id))
      this.hotspots.set(object.id, hotspot)
    }

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.dragStart = new Phaser.Math.Vector2(pointer.x, pointer.y)
      this.isDragging = false
    })
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown || !this.dragStart) return
      const distance = Phaser.Math.Distance.Between(pointer.x, pointer.y, this.dragStart.x, this.dragStart.y)
      if (distance > 8) this.isDragging = true
      if (!this.isDragging) return
      this.cameras.main.scrollX -= pointer.velocity.x / this.cameras.main.zoom
      this.cameras.main.scrollY -= pointer.velocity.y / this.cameras.main.zoom
    })
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
      if (!this.isDragging && currentlyOver.length === 0) this.showWrongClick(pointer.worldX, pointer.worldY)
      this.dragStart = undefined
    })
    this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _targets: Phaser.GameObjects.GameObject[], _deltaX: number, deltaY: number) => {
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom - deltaY * 0.001, 0.8, 2.5))
    })
    this.game.events.on('use-hint', this.useHint, this)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.game.events.off('use-hint', this.useHint, this))
    this.callbacks.onReady()
  }

  private tryFind(id: string) {
    if (this.isDragging || this.foundIds.has(id)) return
    const hotspot = this.hotspots.get(id)
    if (!hotspot) return
    this.foundIds.add(id)
    hotspot.disableInteractive()
    const flash = this.add.circle(hotspot.x, hotspot.y, 12, 0xffe7a6, 0.95).setBlendMode(Phaser.BlendModes.ADD).setDepth(2)
    const halo = this.add.circle(hotspot.x, hotspot.y, Math.min(hotspot.displayWidth, hotspot.displayHeight) * 0.4, 0xf3be61, 0.12)
      .setStrokeStyle(3, 0xffe2a1, 0.92)
      .setDepth(2)
    this.tweens.add({ targets: flash, scale: 2.2, alpha: 0, duration: 450, onComplete: () => flash.destroy() })
    this.tweens.add({ targets: halo, scale: 1.35, alpha: 0, duration: 560, ease: 'Sine.easeOut', onComplete: () => halo.destroy() })
    const fly = this.add.image(hotspot.x, hotspot.y, hotspot.texture.key).setDisplaySize(hotspot.displayWidth, hotspot.displayHeight).setDepth(4)
    this.tweens.add({ targets: fly, x: this.cameras.main.scrollX + this.cameras.main.width - 42, y: this.cameras.main.scrollY + this.cameras.main.height - 34, scale: .34, alpha: 0, duration: 620, ease: 'Cubic.easeIn', onComplete: () => fly.destroy() })
    this.callbacks.onFound(id)
    if (this.foundIds.size === this.level.mission.targetIds.length) this.callbacks.onComplete()
  }

  private showWrongClick(x: number, y: number) {
    const ring = this.add.circle(x, y, 10, 0xff6f5e, 0.55).setStrokeStyle(3, 0xffc0b6, 0.9)
    this.tweens.add({ targets: ring, scale: 2.8, alpha: 0, duration: 360, ease: 'Sine.easeOut', onComplete: () => ring.destroy() })
    this.callbacks.onWrongClick()
  }

  private useHint(requestedId?: string) {
    const nextId = requestedId && !this.foundIds.has(requestedId)
      ? requestedId
      : this.level.mission.targetIds.find((id) => !this.foundIds.has(id))
    const hotspot = nextId ? this.hotspots.get(nextId) : undefined
    if (!hotspot) return
    this.tweens.add({
      targets: this.cameras.main,
      scrollX: hotspot.x - this.cameras.main.width / (2 * this.cameras.main.zoom),
      scrollY: hotspot.y - this.cameras.main.height / (2 * this.cameras.main.zoom),
      duration: 420,
      ease: 'Sine.easeInOut',
    })
    const pulse = this.add.circle(hotspot.x, hotspot.y, 30, 0xf3be61, 0.18).setStrokeStyle(4, 0xffe4a0, 0.95)
    this.tweens.add({ targets: pulse, scale: 2.4, alpha: 0, duration: 800, repeat: 1, onComplete: () => pulse.destroy() })
  }
}
