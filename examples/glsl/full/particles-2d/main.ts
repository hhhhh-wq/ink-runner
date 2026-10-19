import '../../../../src/styles.css'
import {
  ACESFilmicToneMapping,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  TorusGeometry,
  SphereGeometry,
  Color,
  Matrix3,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { addProfileSwitcher, createControlsPane } from '../../../extras/controls/createControlsPane'
import { createFlowParticles } from '../../../extras/particles/glsl/flowParticles'
import { attachPointerSplats, DensityTintOverlayPass, FluidSimulation } from 'three-fluid-fx'
import { RANGES, SCALE } from '../../../extras/controls/paramRanges'
import { Backdrop } from '../../../extras/backgrounds/glsl/Backdrop'
import { Slideshow } from '../../../extras/backgrounds/glsl/Slideshow'
import { DEFAULT_SLIDESHOW_PATHS } from '../../../extras/backgrounds/defaults'
import { attachBackgroundSwitcher } from '../../../extras/backgrounds/attachBackgroundSwitcher'
import { resolveBackground } from '../../../extras/backgrounds/resolveBackground'
import { resolveProfile } from '../../../extras/resolveProfile'
import {
  attachDemoManualTakeover,
  createDemoSplatDriver,
  setupDemoReel,
} from '../../../extras/demo/reel'

const stage = document.getElementById('stage')
if (!(stage instanceof HTMLElement)) {
  throw new Error('Missing #stage element')
}

const DEFAULTS = {
  splatRadius: 10,
  splatForce: 6,
  pressureIterations: 8,
  curlStrength: 0.2,
  velocityDissipation: 0.992,
  densityDissipation: 0.9,
  pressureDissipation: 0.8,
  enableVorticity: false,
  bfecc: true,
  reflectWalls: true,
  flowStrength: 1.0,
  flowThreshold: 12,
  maxFlowSpeed: 20,
  responseGamma: 4,
  depthAttenuationScale: 1,
  spring: 4.0,
  zeta: 1.15,
  dragLin: 0.28,
  dragQuad: 0.05,
  aMax: 24,
  vMaxScale: 1,
  pointSize: 6,
  rotationSpeed: 0,
  playerRadius: 0.52,
  playerForce: 2.5,
  playerSpread: 1.5,
  radiusAffectsFlow: true,
}

const demo = setupDemoReel('Particles 2D')

// — renderer + scene + camera —
const profile = resolveProfile('balanced')
const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.outputColorSpace = SRGBColorSpace
renderer.toneMapping = ACESFilmicToneMapping
renderer.toneMappingExposure = 1
renderer.setClearColor(new Color('#07080b'), 1)
stage.appendChild(renderer.domElement)

const scene = new Scene()
const playerScene = new Scene() // drawn AFTER compositing so player remains visible

// INK_RUNNER_2D_VISIBLE_BALL: visible, shaded THREE.Mesh player.
// This is a real 3D sphere that MOVES ONLY in the screen's XY plane.
const ballGeometry = new SphereGeometry(1, 64, 48)
const ballMaterial = new MeshStandardMaterial({
  color: 0xffc53d,
  metalness: 0.22,
  roughness: 0.23,
  emissive: 0x533000,
  emissiveIntensity: 0.28,
  depthTest: false,
  depthWrite: false,
})
const ball = new Mesh(ballGeometry, ballMaterial)
ball.position.set(0, 0, 1.25)
ball.renderOrder = 1000
playerScene.add(ball)

const ballOutlineGeometry = new TorusGeometry(1.09, 0.047, 12, 96)
const ballOutlineMaterial = new MeshBasicMaterial({
  color: 0x6ffaff, depthTest: false, depthWrite: false, toneMapped: false,
})
const ballOutline = new Mesh(ballOutlineGeometry, ballOutlineMaterial)
ballOutline.renderOrder = 1001
ballOutline.position.z = 0.07
ball.add(ballOutline)

const ballFillLight = new AmbientLight(0xffffff, 1.9)
const ballKeyLight = new DirectionalLight(0xffffff, 4)
ballKeyLight.position.set(-2, 3, 6)
playerScene.add(ballFillLight, ballKeyLight)

const heldKeys = new Set<string>()
const onBallKeyDown = (e: KeyboardEvent): void => {
  const k = e.key.toLowerCase()
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    heldKeys.add(k)
    if (e.target === document.body) e.preventDefault()
  }
}
const onBallKeyUp = (e: KeyboardEvent): void => { heldKeys.delete(e.key.toLowerCase()) }
const onBallBlur = (): void => { heldKeys.clear() }
window.addEventListener('keydown', onBallKeyDown)
window.addEventListener('keyup', onBallKeyUp)
window.addEventListener('blur', onBallBlur)
const camera = new PerspectiveCamera(45, 1, 0.1, 100)
camera.position.set(0, 0, 5.2)
const cameraRight = new Vector3()
const cameraUp = new Vector3()

// — fluid + offscreen target for the composite —
const fluid = new FluidSimulation(renderer, {
  profile,
  splatRadius: DEFAULTS.splatRadius * SCALE.splatRadius,
  splatForce: DEFAULTS.splatForce,
  pressureIterations: DEFAULTS.pressureIterations,
  curlStrength: DEFAULTS.curlStrength,
  velocityDissipation: DEFAULTS.velocityDissipation,
  densityDissipation: DEFAULTS.densityDissipation,
  pressureDissipation: DEFAULTS.pressureDissipation,
  enableVorticity: DEFAULTS.enableVorticity,
  bfecc: DEFAULTS.bfecc,
  reflectWalls: DEFAULTS.reflectWalls,
})
const clock = new Timer()
const prevBallClip = new Vector3()
const nextBallClip = new Vector3()

// Ball footprint coupling: distribute velocity injection across the projected sphere area.
const clampUV = (v: number): number => Math.max(0.01, Math.min(0.99, v))
const updateBallAndSplat = (
  dt: number,
  radius: number,
  force: number,
  scaled: boolean,
  spread: number,
): void => {
  ball.scale.setScalar(radius)
  const halfH = Math.tan(camera.fov * Math.PI / 360) * (camera.position.z - ball.position.z)
  const halfW = halfH * camera.aspect
  const maxX = Math.max(0, halfW - radius * 1.2)
  const maxY = Math.max(0, halfH - radius * 1.2)
  ball.position.x = Math.max(-maxX, Math.min(maxX, ball.position.x))
  ball.position.y = Math.max(-maxY, Math.min(maxY, ball.position.y))

  const mx = Number(heldKeys.has('d') || heldKeys.has('arrowright')) -
             Number(heldKeys.has('a') || heldKeys.has('arrowleft'))
  const my = Number(heldKeys.has('w') || heldKeys.has('arrowup')) -
             Number(heldKeys.has('s') || heldKeys.has('arrowdown'))
  const len = Math.hypot(mx, my)
  if (len === 0) return

  prevBallClip.copy(ball.position).project(camera)
  const speed = 1.75
  ball.position.x = Math.max(-maxX, Math.min(maxX, ball.position.x + mx / len * speed * dt))
  ball.position.y = Math.max(-maxY, Math.min(maxY, ball.position.y + my / len * speed * dt))
  ball.rotation.x += my / len * speed * dt * 1.6
  ball.rotation.y += mx / len * speed * dt * 1.6
  nextBallClip.copy(ball.position).project(camera)

  const du = (nextBallClip.x - prevBallClip.x) * 0.5
  const dv = (nextBallClip.y - prevBallClip.y) * 0.5
  if (Math.abs(du) + Math.abs(dv) < 1e-7 || force <= 0) return

  const u = clampUV(nextBallClip.x * 0.5 + 0.5)
  const v = clampUV(nextBallClip.y * 0.5 + 0.5)
  // addSplat accepts pixel-sized velocity impulses, unlike the UV center.
  const dx = du * renderer.domElement.clientWidth * force * 2.5
  const dy = dv * renderer.domElement.clientHeight * force * 2.5

  if (!scaled) {
    fluid.addSplat(u, v, dx, dy)
    return
  }

  // Project the 3D sphere radius onto the visible 2D plane.
  // Separate UV radii are necessary for non-square viewports.
  const rx = (radius / Math.max(halfW, 0.001)) * 0.5 * spread
  const ry = (radius / Math.max(halfH, 0.001)) * 0.5 * spread
  // Sample a filled disc rather than only 9 sparse locations.
  // IMPORTANT: do not divide the same total impulse among all samples:
  // larger footprints would then look weaker locally.
  const footprintGain = 0.65 + 0.7 * radius
  for (let iy = -2; iy <= 2; iy += 1) {
    for (let ix = -2; ix <= 2; ix += 1) {
      const nx = ix / 2
      const ny = iy / 2
      const rr = nx * nx + ny * ny
      if (rr > 1.05) continue
      const localGain = (rr < 0.01 ? 0.65 : 0.42) * footprintGain
      const su = u + nx * rx * 0.84
      const sv = v + ny * ry * 0.84
      if (su <= 0 || su >= 1 || sv <= 0 || sv >= 1) continue
      fluid.addSplat(su, sv, dx * localGain, dy * localGain)
    }
  }
}

const particles = createFlowParticles(renderer, { mode: 'plane2d', size: 80 })
scene.add(particles.points)

// — background switcher (dark / bright / slideshow) —
const switcher = attachBackgroundSwitcher({
  scene,
  initial: resolveBackground('dark', { skipStorage: true }),
  persist: false,
  factories: {
    dark: () => new Backdrop(camera, 'dark'),
    bright: () => new Backdrop(camera, 'bright'),
    slideshow: () => new Slideshow({ camera, paths: DEFAULT_SLIDESHOW_PATHS }),
  },
})

const controls = createControlsPane('Particles 2D', { ...DEFAULTS }, (pane, p) => {
  const playerPane = pane.addFolder({ title: 'Player Ball', expanded: true })
  playerPane.addBinding(p, 'playerRadius', { min: 0.15, max: 0.85, step: 0.01, label: 'ball size' })
  playerPane.addBinding(p, 'playerForce', { min: 0, max: 6, step: 0.1, label: 'stir force' })
  playerPane.addBinding(p, 'playerSpread', { min: 0.5, max: 2.5, step: 0.05, label: 'flow radius ×' })
  playerPane.addBinding(p, 'radiusAffectsFlow', { label: 'size affects flow' })

  const splat = pane.addFolder({ title: 'Splat' })
  splat.addBinding(p, 'splatRadius', { ...RANGES.splatRadius, label: 'radius' })
  splat.addBinding(p, 'splatForce', { ...RANGES.splatForce, label: 'force' })

  const sim = pane.addFolder({ title: 'Fluid sim' })
  sim.addBinding(p, 'pressureIterations', { ...RANGES.pressureIterations, label: 'pressure' })
  sim.addBinding(p, 'curlStrength', { ...RANGES.curlStrength, label: 'curl' })
  sim.addBinding(p, 'velocityDissipation', { ...RANGES.velocityDissipation, label: 'vel diss' })
  sim.addBinding(p, 'densityDissipation', { ...RANGES.densityDissipation, label: 'dens diss' })
  sim.addBinding(p, 'pressureDissipation', { ...RANGES.pressureDissipation, label: 'pres diss' })
  sim.addBinding(p, 'enableVorticity', { label: 'vorticity' })
  sim.addBinding(p, 'bfecc', { label: 'BFECC' })
  sim.addBinding(p, 'reflectWalls', { label: 'reflect walls' })

  const influence = pane.addFolder({ title: 'Influence' })
  influence.addBinding(p, 'flowStrength', { ...RANGES.flowStrength, label: 'flow' })
  influence.addBinding(p, 'flowThreshold', { ...RANGES.flowThreshold, label: 'thresh' })
  influence.addBinding(p, 'maxFlowSpeed', { ...RANGES.maxFlowSpeed, label: 'max speed' })
  influence.addBinding(p, 'responseGamma', { ...RANGES.responseGamma, label: 'response γ' })

  influence.addBinding(p, 'depthAttenuationScale', {
    ...RANGES.depthAttenuationScale,
    label: 'depth scale',
  })

  const physics = pane.addFolder({ title: 'Particle physics' })
  physics.addBinding(p, 'spring', { ...RANGES.spring, label: 'spring ω' })
  physics.addBinding(p, 'zeta', { ...RANGES.zeta, label: 'damping ζ' })
  physics.addBinding(p, 'dragLin', { ...RANGES.dragLin, label: 'drag lin' })
  physics.addBinding(p, 'dragQuad', { ...RANGES.dragQuad, label: 'drag quad' })
  physics.addBinding(p, 'aMax', { ...RANGES.aMax, label: 'a max' })
  physics.addBinding(p, 'vMaxScale', { ...RANGES.vMaxScale, label: 'v max ×' })

  const motion = pane.addFolder({ title: 'Motion' })
  motion.addBinding(p, 'rotationSpeed', { ...RANGES.rotationSpeed, label: 'spin (rad/s)' })

  const render = pane.addFolder({ title: 'Render' })
  render.addBinding(p, 'pointSize', { ...RANGES.pointSize, label: 'point size' })

  const debug = pane.addFolder({ title: 'Debug', expanded: false })
  addProfileSwitcher(debug, profile)
})

const detachPointerSplats = demo.enabled
  ? attachDemoManualTakeover(demo, renderer.domElement, () =>
      attachPointerSplats(renderer.domElement, fluid),
    )
  : attachPointerSplats(renderer.domElement, fluid)
const driveDemoSplats = createDemoSplatDriver(fluid)

// EffectComposer pipeline: RenderPass draws the scene (background + the
// particle cloud) into the composer's read buffer, then DensityTintOverlayPass
// adds a faint teal tint by fluid density. OutputPass closes the chain with
// the renderer's tone mapping + sRGB conversion to screen. Slightly darker
// tint + higher intensity than the 2D example for the cloudier 3D feel.
const tint = new DensityTintOverlayPass(fluid)
tint.color.setRGB(0.08, 0.3, 0.32)
tint.intensity = 0.18

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
composer.addPass(tint)
composer.addPass(new OutputPass())

const modelRotation = new Matrix3()
let spinAngle = 0

// — resize: keep renderer, camera, composer and fluid in sync with the stage —
const resize = (): void => {
  const w = Math.max(1, stage.clientWidth)
  const h = Math.max(1, stage.clientHeight)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  composer.setPixelRatio(dpr)
  composer.setSize(w, h)
  fluid.resize(w, h)
}
resize()
window.addEventListener('resize', resize)

// Push the current GUI values into `fluid`. Called once per frame from the
// loop. Particle physics params don't need this — they're read directly off
// `controls.params` inside the `particles.step({...})` call.
const syncFluidParams = (): void => {
  const p = controls.params
  fluid.splatRadius = p.splatRadius * SCALE.splatRadius
  fluid.splatForce = p.splatForce
  fluid.pressureIterations = p.pressureIterations
  fluid.curlStrength = p.curlStrength
  fluid.velocityDissipation = p.velocityDissipation
  fluid.densityDissipation = p.densityDissipation
  fluid.pressureDissipation = p.pressureDissipation
  fluid.enableVorticity = p.enableVorticity
  fluid.bfecc = p.bfecc
  fluid.reflectWalls = p.reflectWalls
}

renderer.setAnimationLoop(() => {
  clock.update()
  const dt = Math.min(Math.max(clock.getDelta(), 1e-6), 1 / 30)
  const fluidDt = Math.min(dt, 1 / 60)
  const elapsed = clock.getElapsed()
  const dpr = renderer.getPixelRatio()
  const p = controls.params

  spinAngle += 0 * dt
  particles.points.rotation.z = spinAngle
  particles.points.updateMatrixWorld(true)
  modelRotation.setFromMatrix4(particles.points.matrixWorld)

  syncFluidParams()
  updateBallAndSplat(dt, p.playerRadius, p.playerForce, p.radiusAffectsFlow, p.playerSpread)
  if (demo.enabled) driveDemoSplats(demo.elapsed())
  fluid.step(fluidDt)
  cameraRight.setFromMatrixColumn(camera.matrixWorld, 0)
  cameraUp.setFromMatrixColumn(camera.matrixWorld, 1)
  particles.step({
    dt,
    dpr,
    velocityField: fluid.velocityTexture,
    viewMatrix: camera.matrixWorldInverse,
    projectionMatrix: camera.projectionMatrix,
    cameraRight: cameraRight,
    cameraUp: cameraUp,
    modelRotation,
    pointSize: p.pointSize,
    spring: p.spring,
    zeta: p.zeta,
    dragLin: p.dragLin,
    dragQuad: p.dragQuad,
    aMax: p.aMax,
    vMaxScale: p.vMaxScale,
    flowStrength: p.flowStrength,
    depthLift: 0,
    flowThreshold: p.flowThreshold * SCALE.flowThreshold,
    maxFlowSpeed: p.maxFlowSpeed,
    responseGamma: p.responseGamma,
    perpendicularAngle: 0,
    sideVariation: 0,
    depthAttenuationScale: p.depthAttenuationScale,
  })

  switcher.update(dt, elapsed)
  composer.render(dt)
  // Render real 3D player mesh on top of the completed official GPU-fluid scene.
  // No backdrop or postprocessing pass can paint over it.
  const wasAutoClear = renderer.autoClear
  renderer.autoClear = false
  renderer.setRenderTarget(null)
  renderer.clearDepth()
  renderer.render(playerScene, camera)
  renderer.autoClear = wasAutoClear
})

window.addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null)
  window.removeEventListener('resize', resize)
  composer.dispose()
  scene.remove(particles.points)
  particles.dispose()
  tint.dispose()
  detachPointerSplats?.()
  switcher.dispose()
  controls.dispose()
  fluid.dispose()
  renderer.dispose()
  window.removeEventListener('keydown', onBallKeyDown)
  window.removeEventListener('keyup', onBallKeyUp)
  window.removeEventListener('blur', onBallBlur)
  playerScene.remove(ball)
  ballGeometry.dispose()
  ballMaterial.dispose()
  ballOutlineGeometry.dispose()
  ballOutlineMaterial.dispose()
  scene.remove(ballFillLight, ballKeyLight)
  renderer.domElement.remove()
})
