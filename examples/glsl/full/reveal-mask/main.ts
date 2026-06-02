import {
  Color,
  LinearFilter,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Timer,
  Uniform,
  Vector2,
  WebGLRenderer,
} from 'three'
import {
  attachPointerSplats,
  FluidSimulation,
  FULLSCREEN_VERTEX,
  FullscreenPass,
} from 'three-fluid-fx'
import { addProfileSwitcher, createControlsPane } from '../../../extras/controls/createControlsPane'
import { resolveProfile } from '../../../extras/resolveProfile'
import {
  attachDemoManualTakeover,
  createDemoSplatDriver,
  setupDemoReel,
} from '../../../extras/demo/reel'

// ---------------------------------------------------------------------------
// Reveal Mask — full demo
//
// Two image layers composited through the fluid solver:
//   • base   — the "sealed" layer, always visible
//   • reveal — the hidden layer, uncovered where the pointer paints fluid
//
// The fluid density (`.b`) is the reveal mask; the velocity field (`.rg`)
// ripples the reveal boundary like liquid. Switch between preset image pairs
// or upload your own. (Single-image looks like B/W live in Mask Effects.)
// ---------------------------------------------------------------------------

interface ImagePair {
  name: string
  base: string // the sealed layer, always visible
  reveal: string // the hidden layer, uncovered under the pointer
  baseDim: number // brightness of the base layer (lower = darker)
}

const PRESET_PAIRS: ImagePair[] = [
  // Two distinct layers, framed identically so the reveal lines up.
  { name: 'Soundbar X-Ray', base: '/backdrops/soundbar0.webp', reveal: '/backdrops/soundbar1.webp', baseDim: 1 },
  { name: 'Headphones X-Ray', base: '/backdrops/headphones0.webp', reveal: '/backdrops/headphones1.webp', baseDim: 1 },
  { name: 'Apartment (before → after)', base: '/backdrops/apartment_0.webp', reveal: '/backdrops/apartment_1.webp', baseDim: 1 },
]

const INITIAL_PAIR = PRESET_PAIRS[0]

// All tunable values in one place, bound to the GUI below.
const params = {
  // Image pair selector (mirrors PRESET_PAIRS names, plus "Custom" for uploads).
  pair: INITIAL_PAIR.name,
  // Reveal shaping.
  threshold: 0.06,
  softness: 0.26,
  edge: 0.0003,
  rim: 0.35,
  // Base (sealed) layer brightness.
  baseDim: INITIAL_PAIR.baseDim,
  // Fluid solver.
  splatRadius: 0.015,
  splatForce: 6,
  densityDissipation: 0.975,
  velocityDissipation: 0.94,
}

const stage = document.getElementById('stage')
if (!(stage instanceof HTMLElement)) throw new Error('Missing #stage element')

// --- renderer ---
const profile = resolveProfile('balanced')
const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.outputColorSpace = SRGBColorSpace
renderer.setClearColor(new Color('#07080b'), 1)
stage.appendChild(renderer.domElement)

// --- fluid solver + pointer / demo reel ---
const fluid = new FluidSimulation(renderer, {
  profile,
  splatRadius: params.splatRadius,
  splatForce: params.splatForce,
  densityDissipation: params.densityDissipation,
  velocityDissipation: params.velocityDissipation,
  // Vorticity off: a clean liquid reveal without tight decorative curls.
  enableVorticity: false,
  curlStrength: 0,
  reflectWalls: false,
})

const demo = setupDemoReel('Reveal Mask')
const detachPointerSplats = demo.enabled
  ? attachDemoManualTakeover(demo, renderer.domElement, () =>
      attachPointerSplats(renderer.domElement, fluid),
    )
  : attachPointerSplats(renderer.domElement, fluid)
const driveDemoSplats = createDemoSplatDriver(fluid, { coloredStrokes: false })

// --- composite shader ---
const composite = new ShaderMaterial({
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tBase;
    uniform sampler2D tReveal;
    uniform sampler2D tFluid;
    uniform vec2 uBaseSize;   // natural pixel size of the base image
    uniform vec2 uRevealSize; // natural pixel size of the reveal image
    uniform vec2 uViewSize;   // canvas size in pixels
    uniform float uThreshold;
    uniform float uSoftness;
    uniform float uEdge;
    uniform float uRim;
    uniform float uBaseDim;

    // background-size: cover — fill the view, crop the overflow, never stretch.
    vec2 coverUv(vec2 uv, vec2 imageSize, vec2 viewSize) {
      float viewAspect = viewSize.x / viewSize.y;
      float imageAspect = imageSize.x / imageSize.y;
      vec2 ratio = vec2(
        min(viewAspect / imageAspect, 1.0),
        min(imageAspect / viewAspect, 1.0)
      );
      return uv * ratio + (1.0 - ratio) * 0.5;
    }

    void main() {
      vec4 fluid = texture2D(tFluid, vUv);

      // Density -> reveal amount; the edge band peaks at the boundary.
      float mask = smoothstep(uThreshold, uThreshold + uSoftness, fluid.b);
      float edge = mask * (1.0 - mask) * 4.0;

      // Base (sealed) layer.
      vec3 sealed = texture2D(tBase, coverUv(vUv, uBaseSize, uViewSize)).rgb * uBaseDim;

      // Reveal layer — velocity ripples ONLY the boundary, interior stays crisp.
      vec2 revealUv = coverUv(vUv, uRevealSize, uViewSize);
      revealUv = clamp(revealUv - fluid.rg * uEdge * edge, 0.0, 1.0);
      vec3 reveal = texture2D(tReveal, revealUv).rgb;

      vec3 color = mix(sealed, reveal, mask);

      // Wet rim: a bright line where liquid meets the sealed area.
      color += reveal * edge * uRim;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
  uniforms: {
    tBase: new Uniform<Texture | null>(null),
    tReveal: new Uniform<Texture | null>(null),
    tFluid: new Uniform(fluid.densityTexture),
    uBaseSize: new Uniform(new Vector2(1, 1)),
    uRevealSize: new Uniform(new Vector2(1, 1)),
    uViewSize: new Uniform(new Vector2(1, 1)),
    uThreshold: new Uniform(params.threshold),
    uSoftness: new Uniform(params.softness),
    uEdge: new Uniform(params.edge),
    uRim: new Uniform(params.rim),
    uBaseDim: new Uniform(params.baseDim),
  },
})

const pass = new FullscreenPass(composite)

// --- image loading ---
const loader = new TextureLoader()

function applyTexture(slot: 'base' | 'reveal', url: string): void {
  const textureKey = slot === 'base' ? 'tBase' : 'tReveal'
  const sizeKey = slot === 'base' ? 'uBaseSize' : 'uRevealSize'
  const previous = composite.uniforms[textureKey].value as Texture | null

  const texture = loader.load(url, (loaded) => {
    const source = loaded.image as { width?: number; height?: number } | undefined
    if (source?.width && source?.height) {
      composite.uniforms[sizeKey].value.set(source.width, source.height)
    }
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  })
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter

  composite.uniforms[textureKey].value = texture
  if (previous && previous !== texture) previous.dispose()
}

function applyPair(pair: ImagePair): void {
  applyTexture('base', pair.base)
  applyTexture('reveal', pair.reveal)
  params.baseDim = pair.baseDim
  composite.uniforms.uBaseDim.value = pair.baseDim
}

applyPair(INITIAL_PAIR)

// Hidden file inputs drive the "Upload" buttons in the GUI.
function createUploadInput(slot: 'base' | 'reveal'): HTMLInputElement {
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

// --- controls ---
const pairOptions: Record<string, string> = { Custom: 'Custom' }
for (const pair of PRESET_PAIRS) pairOptions[pair.name] = pair.name

const controls = createControlsPane('Reveal Mask', params, (pane, p) => {
  const images = pane.addFolder({ title: 'Images' })
  images
    .addBinding(p, 'pair', { label: 'pair', options: pairOptions })
    .on('change', (ev) => {
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

// Push GUI values into the solver + shader each frame.
function syncParams(): void {
  const p = controls.params
  fluid.splatRadius = p.splatRadius
  fluid.splatForce = p.splatForce
  fluid.densityDissipation = p.densityDissipation
  fluid.velocityDissipation = p.velocityDissipation
  composite.uniforms.uThreshold.value = p.threshold
  composite.uniforms.uSoftness.value = p.softness
  composite.uniforms.uEdge.value = p.edge
  composite.uniforms.uRim.value = p.rim
  composite.uniforms.uBaseDim.value = p.baseDim
}

// --- resize ---
const resize = (): void => {
  const w = Math.max(1, stage.clientWidth)
  const h = Math.max(1, stage.clientHeight)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)
  fluid.resize(w, h)
  composite.uniforms.uViewSize.value.set(w, h)
}
resize()
window.addEventListener('resize', resize)

// --- loop ---
const clock = new Timer()
renderer.setAnimationLoop(() => {
  clock.update()
  const fluidDt = Math.min(Math.max(clock.getDelta(), 1e-6), 1 / 60)
  syncParams()
  if (demo.enabled) driveDemoSplats(demo.elapsed())
  fluid.step(fluidDt)
  composite.uniforms.tFluid.value = fluid.densityTexture
  pass.render(renderer, null)
})

// --- cleanup ---
window.addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null)
  window.removeEventListener('resize', resize)
  ;(composite.uniforms.tBase.value as Texture | null)?.dispose()
  ;(composite.uniforms.tReveal.value as Texture | null)?.dispose()
  pass.dispose()
  detachPointerSplats?.()
  controls.dispose()
  baseInput.remove()
  revealInput.remove()
  fluid.dispose()
  renderer.dispose()
  renderer.domElement.remove()
})
