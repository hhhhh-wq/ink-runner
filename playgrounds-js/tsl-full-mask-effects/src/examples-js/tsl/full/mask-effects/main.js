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
import {
  clamp,
  convertToTexture,
  dot,
  float,
  floor,
  Fn,
  fract,
  If,
  length,
  mix,
  screenUV,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { attachPointerSplats, FluidSimulation } from 'three-fluid-fx/tsl'
import { addProfileSwitcher, createControlsPane } from '../../../extras/controls/createControlsPane'
import { resolveProfile } from '../../../extras/resolveProfile'
import { asNode, setPipelineOutput } from '../../shared/nodeInterop'
import { coverUv } from '../../shared/fluidReveal'
const EFFECTS = {
  'B/W → Color': 0,
  'Blur → Sharp': 1,
  Pixelize: 2,
  'Halftone (Riso)': 3,
  'Edge glow': 4,
}
const IMAGES = {
  Neon: '/backdrops/slides-01.webp',
  Jewel: '/backdrops/slides-03.webp',
  Koi: '/backdrops/slides-06.webp',
}
const params = {
  effect: 'B/W → Color',
  image: 'Neon',
  splatRadius: 0.011,
  splatForce: 6,
  densityDissipation: 0.975,
  velocityDissipation: 0.94,
  edge: 0.0003,
  rim: 0.4,
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
const imageThreeTex = new Texture()
imageThreeTex.colorSpace = SRGBColorSpace
imageThreeTex.minFilter = LinearFilter
imageThreeTex.magFilter = LinearFilter
imageThreeTex.flipY = false // match the render-target / screenUV orientation
const uViewSize = uniform(new Vector2(1, 1))
const uImageSize = uniform(new Vector2(1, 1))
const uEdge = uniform(params.edge)
const uRim = uniform(params.rim)
const uEffect = uniform(EFFECTS[params.effect])
function applyImage(url) {
  const img = new Image()
  img.onload = () => {
    // Free the old GPU texture so a differently-sized image re-uploads.
    imageThreeTex.dispose()
    imageThreeTex.image = img
    imageThreeTex.needsUpdate = true
    uImageSize.value.set(img.naturalWidth, img.naturalHeight)
  }
  img.src = url
}
applyImage(IMAGES[params.image])
const imageTex = texture(imageThreeTex)
const fluidTex = convertToTexture(asNode(fluid.densityNode))
const LUMA = vec3(0.299, 0.587, 0.114)
const output = Fn(() => {
  const sUv = screenUV
  const imgUv = coverUv(sUv, uImageSize, uViewSize)
  const fluidSample = fluidTex.sample(sUv)
  const mask = smoothstep(0.06, 0.32, fluidSample.b)
  const edge = mask.mul(float(1).sub(mask)).mul(4)
  // Revealed clean layer (edge-rippled), and the plain sample for treatments.
  const revealUv = clamp(imgUv.sub(fluidSample.rg.mul(uEdge).mul(edge)), 0, 1)
  const clean = imageTex.sample(revealUv).rgb
  const plain = imageTex.sample(imgUv).rgb
  // Sealed-layer treatment — only the active branch executes.
  const sealed = vec3(0).toVar()
  If(uEffect.equal(0), () => {
    // B/W → Color: desaturate, contrast-crush.
    sealed.assign(vec3(dot(plain, LUMA).pow(1.5)).mul(0.5))
  })
    .ElseIf(uEffect.equal(1), () => {
      // Blur → Sharp: 9-tap box blur.
      const px = vec2(6).div(uViewSize)
      sealed.assign(
        imageTex
          .sample(imgUv)
          .rgb.mul(0.25)
          .add(imageTex.sample(imgUv.add(vec2(px.x, 0))).rgb.mul(0.125))
          .add(imageTex.sample(imgUv.sub(vec2(px.x, 0))).rgb.mul(0.125))
          .add(imageTex.sample(imgUv.add(vec2(0, px.y))).rgb.mul(0.125))
          .add(imageTex.sample(imgUv.sub(vec2(0, px.y))).rgb.mul(0.125))
          .add(imageTex.sample(imgUv.add(px)).rgb.mul(0.0625))
          .add(imageTex.sample(imgUv.sub(px)).rgb.mul(0.0625))
          .add(imageTex.sample(imgUv.add(vec2(px.x, px.y.negate()))).rgb.mul(0.0625))
          .add(imageTex.sample(imgUv.add(vec2(px.x.negate(), px.y))).rgb.mul(0.0625)),
      )
    })
    .ElseIf(uEffect.equal(2), () => {
      // Pixelize.
      const blocks = float(90)
      const pUv = floor(imgUv.mul(blocks)).add(0.5).div(blocks)
      sealed.assign(imageTex.sample(pUv).rgb)
    })
    .ElseIf(uEffect.equal(3), () => {
      // Halftone / riso dots in screen space.
      const lum = dot(plain, LUMA)
      const cell = fract(sUv.mul(uViewSize).div(6)).sub(0.5)
      const dotDist = length(cell).mul(2)
      const radius = sqrt(clamp(float(1).sub(lum), 0, 1))
      const ink = smoothstep(radius.add(0.12), radius.sub(0.12), dotDist)
      sealed.assign(mix(vec3(0.96, 0.94, 0.88), vec3(0.85, 0.13, 0.3), ink))
    })
    .Else(() => {
      // Edge glow: dimmed clean image (the wow is the neon rim below).
      sealed.assign(plain.mul(0.5))
    })
  const color = mix(sealed, clean, mask)
  // Wet rim — boosted + neon-tinted for the Edge glow effect.
  const rimColor = clean.mul(edge).mul(uRim).toVar()
  If(uEffect.equal(4), () => {
    rimColor.assign(
      clean
        .mul(edge)
        .mul(uRim)
        .mul(3)
        .add(vec3(0.1, 0.65, 0.95).mul(edge).mul(uRim).mul(2)),
    )
  })
  return vec4(color.add(rimColor), 1)
})
const pipeline = new RenderPipeline(renderer)
setPipelineOutput(pipeline, output())
const controls = createControlsPane('Mask Effects', params, (pane, p) => {
  const look = pane.addFolder({ title: 'Effect' })
  look.addBinding(p, 'effect', {
    options: Object.fromEntries(Object.keys(EFFECTS).map((k) => [k, k])),
  })
  look
    .addBinding(p, 'image', { options: Object.fromEntries(Object.keys(IMAGES).map((k) => [k, k])) })
    .on('change', (ev) => applyImage(IMAGES[ev.value]))
  const reveal = pane.addFolder({ title: 'Reveal' })
  reveal.addBinding(p, 'edge', { label: 'distortion', min: 0, max: 0.0012, step: 0.00005 })
  reveal.addBinding(p, 'rim', { label: 'rim glow', min: 0, max: 1.5, step: 0.01 })
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
  uEdge.value = p.edge
  uRim.value = p.rim
  uEffect.value = EFFECTS[p.effect]
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
  imageThreeTex.dispose()
  controls.dispose()
  fluid.dispose()
  pipeline.dispose()
  renderer.dispose()
  renderer.domElement.remove()
})
