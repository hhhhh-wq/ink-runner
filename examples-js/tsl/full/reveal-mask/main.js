import {
  Color,
  LinearFilter,
  LinearSRGBColorSpace,
  SRGBColorSpace,
  Texture,
  Timer,
  Vector2,
} from 'three'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'
import { screenUV, texture, uniform } from 'three/tsl'
import { attachPointerSplats, FluidSimulation } from 'three-fluid-fx/tsl'
import { addProfileSwitcher, createControlsPane } from '../../../extras/controls/createControlsPane'
import { resolveProfile } from '../../../extras/resolveProfile'
import { asNode, setPipelineOutput } from '../../shared/nodeInterop'
import { fluidReveal } from '../../shared/fluidReveal'
const PRESET_PAIRS = [
  {
    name: 'Soundbar X-Ray',
    base: '/backdrops/soundbar0.webp',
    reveal: '/backdrops/soundbar1.webp',
    baseDim: 1,
  },
  {
    name: 'Headphones X-Ray',
    base: '/backdrops/headphones0.webp',
    reveal: '/backdrops/headphones1.webp',
    baseDim: 1,
  },
  {
    name: 'Apartment (before → after)',
    base: '/backdrops/apartment_0.webp',
    reveal: '/backdrops/apartment_1.webp',
    baseDim: 1,
  },
]
const INITIAL_PAIR = PRESET_PAIRS[0]
const params = {
  pair: INITIAL_PAIR.name,
  threshold: 0.06,
  softness: 0.26,
  edge: 0.0003,
  rim: 0.35,
  baseDim: INITIAL_PAIR.baseDim,
  splatRadius: 0.015,
  splatForce: 6,
  densityDissipation: 0.975,
  velocityDissipation: 0.94,
}
const stage = document.getElementById('stage')
if (!(stage instanceof HTMLElement)) throw new Error('Missing #stage element')
if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
  stage.textContent =
    'WebGPU is not available in this browser. The TSL example needs a WebGPU-capable browser.'
  throw new Error('WebGPU unavailable')
}
const profile = resolveProfile('balanced')
const renderer = new WebGPURenderer({ antialias: true, forceWebGL: false })
// LinearSRGB output skips the linear->sRGB encode so raw sRGB texels pass
// straight through, matching the gamma-space WebGL examples pixel-for-pixel.
renderer.outputColorSpace = LinearSRGBColorSpace
renderer.setClearColor(new Color('#07080b'), 1)
renderer.domElement.style.position = 'absolute'
renderer.domElement.style.inset = '0'
stage.appendChild(renderer.domElement)
await renderer.init()
const fluid = new FluidSimulation(renderer, {
  profile,
  splatRadius: params.splatRadius,
  splatForce: params.splatForce,
  densityDissipation: params.densityDissipation,
  velocityDissipation: params.velocityDissipation,
  enableVorticity: false,
  curlStrength: 0,
  reflectWalls: false,
})
attachPointerSplats(renderer.domElement, fluid)
// Persistent textures whose image is swapped when the pair changes. flipY =
// false matches the render-target orientation that screenUV / the fluid use.
function makeSlotTexture() {
  const tex = new Texture()
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.flipY = false
  return tex
}
const baseThreeTex = makeSlotTexture()
const revealThreeTex = makeSlotTexture()
const uViewSize = uniform(new Vector2(1, 1))
const uBaseSize = uniform(new Vector2(1, 1))
const uRevealSize = uniform(new Vector2(1, 1))
const uThreshold = uniform(params.threshold)
const uSoftness = uniform(params.softness)
const uEdge = uniform(params.edge)
const uRim = uniform(params.rim)
const uBaseDim = uniform(params.baseDim)
function applyTexture(slot, url) {
  const img = new Image()
  img.onload = () => {
    const tex = slot === 'base' ? baseThreeTex : revealThreeTex
    // Free the old GPU texture so an image of a different size re-uploads
    // (WebGPU keeps the old dimensions on a bare needsUpdate).
    tex.dispose()
    tex.image = img
    tex.needsUpdate = true
    const sizeU = slot === 'base' ? uBaseSize : uRevealSize
    sizeU.value.set(img.naturalWidth, img.naturalHeight)
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
  img.src = url
}
function applyPair(pair) {
  applyTexture('base', pair.base)
  applyTexture('reveal', pair.reveal)
  params.baseDim = pair.baseDim
  uBaseDim.value = pair.baseDim
}
applyPair(INITIAL_PAIR)
const pipeline = new RenderPipeline(renderer)
setPipelineOutput(
  pipeline,
  fluidReveal({
    sealed: texture(baseThreeTex),
    reveal: texture(revealThreeTex),
    density: asNode(fluid.densityNode),
    screenUv: screenUV,
    viewSize: uViewSize,
    sealedSize: uBaseSize,
    revealSize: uRevealSize,
    threshold: uThreshold,
    softness: uSoftness,
    edge: uEdge,
    rim: uRim,
    baseDim: uBaseDim,
  }),
)
// Hidden file inputs for uploads.
function createUploadInput(slot) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    applyTexture(slot, URL.createObjectURL(file))
    params.pair = 'Custom'
    controls.pane.refresh()
    input.value = ''
  })
  document.body.appendChild(input)
  return input
}
const baseInput = createUploadInput('base')
const revealInput = createUploadInput('reveal')
const pairOptions = { Custom: 'Custom' }
for (const pair of PRESET_PAIRS) pairOptions[pair.name] = pair.name
const controls = createControlsPane('Reveal Mask', params, (pane, p) => {
  const images = pane.addFolder({ title: 'Images' })
  images.addBinding(p, 'pair', { label: 'pair', options: pairOptions }).on('change', (ev) => {
    const pair = PRESET_PAIRS.find((entry) => entry.name === ev.value)
    if (!pair) return
    applyPair(pair)
    pane.refresh()
  })
  images.addButton({ title: 'Upload base image' }).on('click', () => baseInput.click())
  images.addButton({ title: 'Upload reveal image' }).on('click', () => revealInput.click())
  const reveal = pane.addFolder({ title: 'Reveal' })
  reveal.addBinding(p, 'threshold', { min: 0, max: 0.4, step: 0.005 })
  reveal.addBinding(p, 'softness', { min: 0.02, max: 0.6, step: 0.005 })
  reveal.addBinding(p, 'edge', { label: 'distortion', min: 0, max: 0.0012, step: 0.00005 })
  reveal.addBinding(p, 'rim', { label: 'rim glow', min: 0, max: 1.5, step: 0.01 })
  const baseLayer = pane.addFolder({ title: 'Base layer' })
  baseLayer.addBinding(p, 'baseDim', { label: 'brightness', min: 0, max: 1.2, step: 0.01 })
  const sim = pane.addFolder({ title: 'Fluid' })
  sim.addBinding(p, 'splatRadius', { label: 'splat size', min: 0.002, max: 0.02, step: 0.0005 })
  sim.addBinding(p, 'splatForce', { label: 'splat force', min: 1, max: 12, step: 0.5 })
  sim.addBinding(p, 'densityDissipation', { label: 'heal back', min: 0.9, max: 0.999, step: 0.001 })
  sim.addBinding(p, 'velocityDissipation', { label: 'flow', min: 0.8, max: 0.99, step: 0.005 })
  const debug = pane.addFolder({ title: 'Debug', expanded: false })
  addProfileSwitcher(debug, profile)
})
function syncParams() {
  const p = controls.params
  fluid.splatRadius = p.splatRadius
  fluid.splatForce = p.splatForce
  fluid.densityDissipation = p.densityDissipation
  fluid.velocityDissipation = p.velocityDissipation
  uThreshold.value = p.threshold
  uSoftness.value = p.softness
  uEdge.value = p.edge
  uRim.value = p.rim
  uBaseDim.value = p.baseDim
}
const resize = () => {
  const w = Math.max(1, stage.clientWidth)
  const h = Math.max(1, stage.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(w, h, false)
  fluid.resize(w, h)
  uViewSize.value.set(w, h)
}
resize()
window.addEventListener('resize', resize)
const clock = new Timer()
const FIXED_FLUID_DT = 1 / 60
const MAX_FLUID_SUBSTEPS = 4
let fluidAccumulator = 0
renderer.setAnimationLoop(() => {
  clock.update()
  const frameDt = Math.min(Math.max(clock.getDelta(), 1e-6), FIXED_FLUID_DT * MAX_FLUID_SUBSTEPS)
  syncParams()
  fluidAccumulator += frameDt
  let substeps = 0
  while (fluidAccumulator >= FIXED_FLUID_DT && substeps < MAX_FLUID_SUBSTEPS) {
    fluid.step(FIXED_FLUID_DT)
    fluidAccumulator -= FIXED_FLUID_DT
    substeps += 1
  }
  if (substeps === MAX_FLUID_SUBSTEPS) fluidAccumulator = 0
  pipeline.render()
})
window.addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null)
  window.removeEventListener('resize', resize)
  baseThreeTex.dispose()
  revealThreeTex.dispose()
  controls.dispose()
  baseInput.remove()
  revealInput.remove()
  fluid.dispose()
  pipeline.dispose()
  renderer.dispose()
  renderer.domElement.remove()
})
