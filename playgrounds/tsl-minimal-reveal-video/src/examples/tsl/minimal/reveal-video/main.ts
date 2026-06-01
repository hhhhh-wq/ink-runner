import '../../../../styles.css'
import { Color, LinearSRGBColorSpace, Timer, Vector2, VideoTexture } from 'three'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'
import { screenUV, texture, uniform } from 'three/tsl'
import { attachPointerSplats, FluidSimulation } from 'three-fluid-fx/tsl'
import { asNode, setPipelineOutput } from '../../shared/nodeInterop'
import { fluidReveal } from '../../shared/fluidReveal'

// Reveal Mask with two synced VIDEOS — TSL / WebGPU. Drag to x-ray a turntable
// product. The reveal node lives in ../../shared/fluidReveal. VideoTexture
// already uploads with flipY = false, matching the screenUV / fluid orientation.

const VIDEO_BASE = '/videos/product_0.mp4' // exterior — the sealed layer
const VIDEO_REVEAL = '/videos/product_1.mp4' // internals — revealed under the pointer
const VIDEO_SIZE = new Vector2(1280, 720)

const stage = document.getElementById('stage')
if (!(stage instanceof HTMLElement)) throw new Error('Missing #stage')

if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
  stage.textContent =
    'WebGPU is not available in this browser. The TSL example needs a WebGPU-capable browser.'
  throw new Error('WebGPU unavailable')
}

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
  profile: 'balanced',
  splatRadius: 0.015,
  splatForce: 6,
  densityDissipation: 0.975,
  velocityDissipation: 0.94,
  enableVorticity: false,
  curlStrength: 0,
  reflectWalls: false,
})
attachPointerSplats(renderer.domElement, fluid)

// Classic VideoTexture setup: a muted, looping, inline <video> in the DOM.
function createVideo(src: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.src = src
  video.loop = true
  video.muted = true
  video.playsInline = true
  video.style.display = 'none'
  document.body.appendChild(video)
  void video.play().catch(() => {})
  return video
}
const baseVideo = createVideo(VIDEO_BASE)
const revealVideo = createVideo(VIDEO_REVEAL)
// LinearSRGB (not sRGB) so WebGPU does NOT hardware-decode the video on sample;
// combined with the LinearSRGB output, the texels pass straight through in
// gamma space, matching the WebGL example. (Image textures don't decode here at
// all, so this keeps both kinds consistent.)
const baseTexture = new VideoTexture(baseVideo)
baseTexture.colorSpace = LinearSRGBColorSpace
const revealTexture = new VideoTexture(revealVideo)
revealTexture.colorSpace = LinearSRGBColorSpace

const uViewSize = uniform(new Vector2(1, 1))
const uVideoSize = uniform(VIDEO_SIZE.clone())

const pipeline = new RenderPipeline(renderer)
setPipelineOutput(
  pipeline,
  fluidReveal({
    sealed: texture(baseTexture),
    reveal: texture(revealTexture),
    density: asNode(fluid.densityNode),
    screenUv: screenUV,
    viewSize: uViewSize,
    sealedSize: uVideoSize,
  }),
)

const resize = (): void => {
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

  // Keep the reveal clip in lockstep with the base so the x-ray lines up.
  if (Math.abs(revealVideo.currentTime - baseVideo.currentTime) > 0.05) {
    revealVideo.currentTime = baseVideo.currentTime
  }

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
  baseVideo.remove()
  revealVideo.remove()
  fluid.dispose()
  pipeline.dispose()
  renderer.dispose()
  renderer.domElement.remove()
})
