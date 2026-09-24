import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

type ThreeLibraryExploreProps = {
  onExit: () => void
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

function makeLabelTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (!context) return new THREE.CanvasTexture(canvas)
  context.fillStyle = '#c8a66b'
  context.fillRect(0, 0, 512, 512)
  context.strokeStyle = '#4a2f20'
  context.lineWidth = 9
  context.strokeRect(26, 26, 460, 460)
  context.strokeStyle = '#72503a'
  context.lineWidth = 3
  for (let i = 0; i < 6; i += 1) {
    context.beginPath()
    context.arc(256, 256, 66 + i * 25, Math.PI * .15, Math.PI * 1.6)
    context.stroke()
  }
  context.fillStyle = '#61432f'
  for (const [x, y, size] of [[114, 137, 8], [179, 232, 6], [303, 146, 9], [384, 238, 7], [238, 348, 8], [359, 362, 6]] as const) {
    context.beginPath()
    context.arc(x, y, size, 0, Math.PI * 2)
    context.fill()
  }
  context.fillStyle = '#c78530'
  context.font = '700 38px Georgia'
  context.textAlign = 'center'
  context.fillText('潮汐星图', 256, 449)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function ThreeLibraryExplore({ onExit }: ThreeLibraryExploreProps) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [found, setFound] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#120e18')
    scene.fog = new THREE.Fog('#120e18', 8, 24)

    const camera = new THREE.PerspectiveCamera(58, 1, .1, 100)
    camera.position.set(0, 1.95, 7.1)
    camera.rotation.order = 'YXZ'

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    mount.appendChild(renderer.domElement)

    const world = new THREE.Group()
    scene.add(world)
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const clickable: THREE.Object3D[] = []
    const cleanup: Array<() => void> = []
    const keys = new Set<string>()
    let yaw = 0
    let pitch = -.08
    let dragging = false
    let didDrag = false
    let lastPointer = { x: 0, y: 0 }
    let discovered = false

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect()
      if (!width || !height) return
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    const wood = new THREE.MeshStandardMaterial({ color: '#3f2119', roughness: .72, metalness: .05 })
    const woodDark = new THREE.MeshStandardMaterial({ color: '#211215', roughness: .86 })
    const brass = new THREE.MeshStandardMaterial({ color: '#a96b26', roughness: .3, metalness: .78 })
    const paper = new THREE.MeshStandardMaterial({ color: '#d4b36e', roughness: .85 })
    const bookMaterials = ['#6d2b2b', '#34544e', '#294064', '#754f27', '#543158'].map((color) => new THREE.MeshStandardMaterial({ color, roughness: .64 }))

    const floor = new THREE.Mesh(new THREE.BoxGeometry(15, .2, 16), woodDark)
    floor.position.y = -.1
    world.add(floor)
    for (let x = -7; x < 7; x += 1.3) {
      for (let z = -7; z < 8; z += 2) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(1.23, .028, 1.91), wood)
        plank.position.set(x + .04, .02, z)
        world.add(plank)
      }
    }

    const wallMaterial = new THREE.MeshStandardMaterial({ color: '#241828', roughness: .95 })
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(15, 7, .26), wallMaterial)
    backWall.position.set(0, 3.35, -7.8)
    world.add(backWall)
    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(.26, 7, 16), wallMaterial)
    sideWall.position.set(-7.5, 3.35, 0)
    world.add(sideWall)

    const makeShelf = (x: number, z: number, rotateY = 0) => {
      const shelf = new THREE.Group()
      shelf.position.set(x, 0, z)
      shelf.rotation.y = rotateY
      const width = 3.4
      const height = 4.7
      const depth = .58
      const sideGeometry = new THREE.BoxGeometry(.16, height, depth)
      for (const side of [-width / 2, width / 2]) {
        const post = new THREE.Mesh(sideGeometry, wood)
        post.position.set(side, height / 2, 0)
        shelf.add(post)
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(width + .2, .18, depth), wood)
      top.position.set(0, height - .02, 0)
      shelf.add(top)
      for (let row = 0; row < 4; row += 1) {
        const board = new THREE.Mesh(new THREE.BoxGeometry(width, .13, depth), wood)
        board.position.set(0, .45 + row * 1.08, 0)
        shelf.add(board)
        for (let book = 0; book < 10; book += 1) {
          const bookMesh = new THREE.Mesh(new THREE.BoxGeometry(.18 + (book % 3) * .035, .56 + ((row + book) % 3) * .11, .34), bookMaterials[(row * 3 + book) % bookMaterials.length])
          bookMesh.position.set(-1.38 + book * .29, .79 + row * 1.08, -.02)
          bookMesh.rotation.z = book % 4 === 0 ? -.09 : book % 5 === 0 ? .07 : 0
          shelf.add(bookMesh)
        }
      }
      world.add(shelf)
    }
    makeShelf(-4.85, -5.45, 0)
    makeShelf(-1.2, -5.45, 0)
    makeShelf(2.45, -5.45, 0)
    makeShelf(5.75, -5.45, 0)
    makeShelf(-6.78, -.8, Math.PI / 2)

    const desk = new THREE.Group()
    const deskTop = new THREE.Mesh(new THREE.BoxGeometry(4.7, .26, 2.25), wood)
    deskTop.position.y = 1.55
    desk.add(deskTop)
    for (const x of [-2.05, 2.05]) for (const z of [-.82, .82]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(.14, .18, 1.55, 10), woodDark)
      leg.position.set(x, .78, z)
      desk.add(leg)
    }
    desk.position.set(.65, 0, .65)
    world.add(desk)

    const chart = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshStandardMaterial({ map: makeLabelTexture(), roughness: .8, side: THREE.DoubleSide, emissive: '#643108', emissiveIntensity: .55 }))
    // The first target is deliberately suspended above the desk: a player can
    // recognise and try the explore interaction before hunting subtler clues.
    chart.position.set(.65, 2.75, 1.72)
    chart.rotation.x = -.16
    chart.name = 'tide-chart'
    clickable.push(chart)
    world.add(chart)
    const chartGlow = new THREE.PointLight('#eab35b', 1.6, 5, 2)
    chartGlow.position.set(.65, 2.8, 2.05)
    world.add(chartGlow)

    const watch = new THREE.Group()
    const watchFace = new THREE.Mesh(new THREE.CylinderGeometry(.32, .32, .1, 32), brass)
    watchFace.rotation.x = Math.PI / 2
    watch.add(watchFace)
    const watchGlass = new THREE.Mesh(new THREE.CircleGeometry(.25, 32), paper)
    watchGlass.position.z = .057
    watch.add(watchGlass)
    watch.position.set(-.72, 1.75, .84)
    watch.rotation.x = -Math.PI / 2
    world.add(watch)

    const lantern = (x: number, z: number) => {
      const group = new THREE.Group()
      const body = new THREE.Mesh(new THREE.CylinderGeometry(.2, .26, .52, 12), brass)
      body.position.y = 1.9
      group.add(body)
      const glow = new THREE.Mesh(new THREE.SphereGeometry(.14, 16, 12), new THREE.MeshStandardMaterial({ color: '#ffcf70', emissive: '#ff9c2c', emissiveIntensity: 2 }))
      glow.position.y = 2.05
      group.add(glow)
      const light = new THREE.PointLight('#f0a64b', 2.8, 7, 2)
      light.position.y = 2.1
      group.add(light)
      group.position.set(x, 0, z)
      world.add(group)
    }
    lantern(-3.2, .8)
    lantern(4.8, -2.6)
    lantern(-5.6, -4.6)

    scene.add(new THREE.HemisphereLight('#9a8ad4', '#20110b', 1.75))
    scene.add(new THREE.AmbientLight('#7c5b76', .5))
    const moon = new THREE.DirectionalLight('#a1b4ff', 1.45)
    moon.position.set(-4, 6, 3)
    scene.add(moon)
    const frontFill = new THREE.PointLight('#ffbe72', 4.2, 13, 2)
    frontFill.position.set(0, 4.8, 4.8)
    scene.add(frontFill)

    const onKeyDown = (event: KeyboardEvent) => {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault()
      keys.add(event.code)
    }
    const onKeyUp = (event: KeyboardEvent) => keys.delete(event.code)
    const onPointerDown = (event: PointerEvent) => {
      dragging = true
      didDrag = false
      lastPointer = { x: event.clientX, y: event.clientY }
      mount.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return
      const deltaX = event.clientX - lastPointer.x
      const deltaY = event.clientY - lastPointer.y
      if (Math.abs(deltaX) + Math.abs(deltaY) > 2) didDrag = true
      yaw -= deltaX * .006
      pitch = clamp(pitch - deltaY * .004, -.58, .5)
      lastPointer = { x: event.clientX, y: event.clientY }
    }
    const investigateAt = (clientX: number, clientY: number) => {
      if (discovered) return
      const bounds = renderer.domElement.getBoundingClientRect()
      pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1
      pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1
      camera.updateMatrixWorld()
      world.updateMatrixWorld(true)
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(clickable, false)[0]
      if (hit?.object.name === 'tide-chart') {
        discovered = true
        const material = (hit.object as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>).material
        material.emissive.set('#dd8b15')
        material.emissiveIntensity = 1.1
        setFound(true)
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      dragging = false
      if (mount.hasPointerCapture(event.pointerId)) mount.releasePointerCapture(event.pointerId)
      if (!didDrag) investigateAt(event.clientX, event.clientY)
    }
    // Embedded browsers can send a MouseEvent without PointerEvent; accept both.
    const onClick = (event: MouseEvent) => investigateAt(event.clientX, event.clientY)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('click', onClick)
    cleanup.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => renderer.domElement.removeEventListener('pointerdown', onPointerDown),
      () => renderer.domElement.removeEventListener('pointermove', onPointerMove),
      () => renderer.domElement.removeEventListener('pointerup', onPointerUp),
      () => renderer.domElement.removeEventListener('click', onClick),
    )

    const clock = new THREE.Clock()
    let frame = 0
    const render = () => {
      const delta = Math.min(clock.getDelta(), .05)
      const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
      const move = new THREE.Vector3()
      if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward)
      if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward)
      if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right)
      if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right)
      if (move.lengthSq()) {
        move.normalize().multiplyScalar(delta * 3.1)
        camera.position.x = clamp(camera.position.x + move.x, -6.35, 6.35)
        camera.position.z = clamp(camera.position.z + move.z, -6.25, 7.2)
      }
      camera.rotation.set(pitch, yaw, 0)
      chartGlow.intensity = discovered ? 2.8 + Math.sin(clock.elapsedTime * 4) * .35 : 1.55 + Math.sin(clock.elapsedTime * 2) * .15
      renderer.render(scene, camera)
      frame = requestAnimationFrame(render)
    }
    render()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      cleanup.forEach((dispose) => dispose())
      renderer.dispose()
      mount.replaceChildren()
    }
  }, [])

  return <main className="three-explore-shell">
    <header className="three-explore-header">
      <div><p className="eyebrow">3D 探索试验场</p><h1>会眨眼的书架</h1></div>
      <button type="button" onClick={onExit}>返回首页</button>
    </header>
    <section className="three-explore-stage" aria-label="可探索的 3D 图书馆">
      <div className="three-explore-canvas" ref={mountRef} />
      <div className="three-explore-instructions"><span>拖拽环视</span><span>WASD / 方向键移动</span></div>
      <aside className={found ? 'three-explore-clue is-found' : 'three-explore-clue'}>
        <small>{found ? '已发现线索' : '调查目标'}</small>
        <strong>{found ? '潮汐星图已收入档案' : '寻找书桌上泛着微光的潮汐星图'}</strong>
        <p>{found ? '书页上的星点开始移动，暗示下一段航线。' : '靠近中央书桌，点击发光的纸页。'}</p>
      </aside>
    </section>
  </main>
}
