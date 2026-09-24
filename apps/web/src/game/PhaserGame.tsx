import { useEffect, useRef } from 'react'
import Phaser from 'phaser'
import type { Level } from '@hog/contracts'
import type { GameCallbacks } from './DetectiveOfficeScene'
import { DetectiveOfficeScene } from './DetectiveOfficeScene'

export interface HintRequest {
  nonce: number
  targetId?: string
}

interface PhaserGameProps extends GameCallbacks {
  hintRequest: HintRequest
  level: Level
}

export function PhaserGame({ hintRequest, level, onFound, onWrongClick, onComplete, onReady }: PhaserGameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Phaser.Game | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: '#171009',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: level.scene.width, height: level.scene.height },
      scene: [new DetectiveOfficeScene(level, { onFound, onWrongClick, onComplete, onReady })],
    })
    gameRef.current = game
    return () => { game.destroy(true); gameRef.current = null }
  }, [level, onComplete, onFound, onReady, onWrongClick])

  useEffect(() => {
    if (hintRequest.nonce > 0) gameRef.current?.events.emit('use-hint', hintRequest.targetId)
  }, [hintRequest])

  return <div className="game-canvas" ref={containerRef} aria-label={`${level.title}寻物场景`} />
}
