import '../../../../styles.css'
import {
  Color,
  LinearFilter,
  LinearSRGBColorSpace,
  SRGBColorSpace,
  TextureLoader,
  Timer,
  Vector2,
} from 'three'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'
import { screenUV, texture, uniform } from 'three/tsl'
import { attachPointerSplats, FluidSimulation } from 'three-fluid-fx/tsl'
import { asNode, setPipelineOutput } from '../../shared/nodeInterop'
import { fluidReveal } from '../../shared/fluidReveal'
// Fluid Reveal Mask — TSL / WebGPU. The fluid density (.b) is the mask between
// two image layers; the velocity field (.rg) ripples the reveal boundary. Here:
// a run-down room revealed as renovated. The reveal node lives in
// ../../shared/fluidReveal (the WebGL inline shader ported to one TSL node).
const IMAGE_BASE = '/backdrops/apartment_0.webp'
const IMAGE_REVEAL = '/backdrops/apartment_1.webp'
const stage = document.getElementById('stage')
if (!(stage instanceof HTMLElement)) throw new Error('Missing #stage')
if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
  stage.textContent =
    'WebGPU is not available in this browser. The TSL example needs a WebGPU-capable browser.'
  throw new Error('WebGPU unavailable')
}
const renderer = new WebGPURenderer({ antialias: true, forceWebGL: false })
// Match the WebGL examples, which composite raw sRGB texels in gamma space
// without color management. LinearSRGB output skips the linear->sRGB encode so
// the sampled texels pass straight through (the WebGL ShaderMaterial does the
// same), keeping both pipelines pixel-identical.
renderer.outputColorSpace = LinearSRGBColorSpace
renderer.setClearColor(new Color('#07080b'), 1)
renderer.domElement.style.position = 'absolute'
renderer.domElement.style.inset = '0'
stage.appendChild(renderer.domElement)
await renderer.init()
const fluid = new FluidSimulation(renderer, {
  profile: 'balanced',
  splatRadius: 0.0175,
  splatForce: 6,
  densityDissipation: 0.985,
  velocityDissipation: 0.94,
  enableVorticity: false,
  curlStrength: 0,
  reflectWalls: false,
})
attachPointerSplats(renderer.domElement, fluid)
const uViewSize = uniform(new Vector2(1, 1))
const uImageSize = uniform(new Vector2(1, 1))
// Two image layers, same size so one cover-fit serves both. flipY = false keeps
// them in the render-target orientation that screenUV / the fluid use.
const loader = new TextureLoader()
function loadImage(url, onSize) {
  const tex = loader.load(url, (loaded) => {
    const source = loaded.image
    if (source?.width && source?.height) onSize?.(source.width, source.height)
  })
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.flipY = false
  return tex
}
const baseTexture = loadImage(IMAGE_BASE, (w, h) => uImageSize.value.set(w, h))
const revealTexture = loadImage(IMAGE_REVEAL)
const pipeline = new RenderPipeline(renderer)
setPipelineOutput(
  pipeline,
  fluidReveal({
    sealed: texture(baseTexture),
    reveal: texture(revealTexture),
    density: asNode(fluid.densityNode),
    screenUv: screenUV,
    viewSize: uViewSize,
    sealedSize: uImageSize,
  }),
)
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
  baseTexture.dispose()
  revealTexture.dispose()
  fluid.dispose()
  pipeline.dispose()
  renderer.dispose()
  renderer.domElement.remove()
})
