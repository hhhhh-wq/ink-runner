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
import { attachPointerSplats, FluidSimulation, FULLSCREEN_VERTEX, FullscreenPass } from 'three-fluid-fx'
import { addProfileSwitcher, createControlsPane } from '../../../extras/controls/createControlsPane'
import { resolveProfile } from '../../../extras/resolveProfile'

// ---------------------------------------------------------------------------
// Fluid Mask Effects
//
// One image, one fluid mask, many looks. The sealed surface is a stylised
// treatment of the photo; dragging the pointer paints fluid that wipes it back
// to the clean original underneath. Switch the treatment in the panel:
//   • B/W → Color   (the original Liquid Color Reveal)
//   • Blur → Sharp  (frosted glass)
//   • Pixelize      (blocks dissolve to sharp)
//   • Halftone/Riso (duotone print dots wipe to photo)
//   • Edge glow     (clean image + neon rim tracing the stroke)
// ---------------------------------------------------------------------------

const EFFECTS: Record<string, number> = {
  'B/W → Color': 0,
  'Blur → Sharp': 1,
  Pixelize: 2,
  'Halftone (Riso)': 3,
  'Edge glow': 4,
}

const IMAGES: Record<string, string> = {
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

// --- renderer ---
const profile = resolveProfile('balanced')
const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.outputColorSpace = SRGBColorSpace
renderer.setClearColor(new Color('#07080b'), 1)
stage.appendChild(renderer.domElement)

// --- fluid solver + pointer ---
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

// --- single image source ---
const loader = new TextureLoader()
function applyImage(url: string): void {
  const previous = composite.uniforms.tImage.value as Texture | null
  const texture = loader.load(url, (loaded) => {
    const source = loaded.image as { width?: number; height?: number } | undefined
    if (source?.width && source?.height) composite.uniforms.uImageSize.value.set(source.width, source.height)
  })
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  composite.uniforms.tImage.value = texture
  if (previous && previous !== texture) previous.dispose()
}

// --- composite shader: pick a sealed treatment per effect, wipe to clean ---
const composite = new ShaderMaterial({
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tImage;
    uniform sampler2D tFluid;
    uniform vec2 uImageSize;
    uniform vec2 uViewSize;
    uniform float uEdge;
    uniform float uRim;
    uniform int uEffect; // 0 B/W, 1 Blur, 2 Pixelize, 3 Halftone, 4 Edge glow

    const vec3 LUMA = vec3(0.299, 0.587, 0.114);

    vec2 coverUv(vec2 uv, vec2 imageSize, vec2 viewSize) {
      float viewAspect = viewSize.x / viewSize.y;
      float imageAspect = imageSize.x / imageSize.y;
      vec2 ratio = vec2(
        min(viewAspect / imageAspect, 1.0),
        min(imageAspect / viewAspect, 1.0)
      );
      return uv * ratio + (1.0 - ratio) * 0.5;
    }

    // Small box blur for the frosted-glass treatment.
    vec3 blur(vec2 uv) {
      vec2 px = 6.0 / uViewSize;
      vec3 c = texture2D(tImage, uv).rgb * 0.25;
      c += texture2D(tImage, uv + vec2(px.x, 0.0)).rgb * 0.125;
      c += texture2D(tImage, uv - vec2(px.x, 0.0)).rgb * 0.125;
      c += texture2D(tImage, uv + vec2(0.0, px.y)).rgb * 0.125;
      c += texture2D(tImage, uv - vec2(0.0, px.y)).rgb * 0.125;
      c += texture2D(tImage, uv + px).rgb * 0.0625;
      c += texture2D(tImage, uv - px).rgb * 0.0625;
      c += texture2D(tImage, uv + vec2(px.x, -px.y)).rgb * 0.0625;
      c += texture2D(tImage, uv + vec2(-px.x, px.y)).rgb * 0.0625;
      return c;
    }

    // Duotone halftone dots in screen space (riso print look).
    vec3 halftone(vec3 col) {
      float l = dot(col, LUMA);
      float scale = 6.0;
      vec2 g = fract(gl_FragCoord.xy / scale) - 0.5;
      float d = length(g) * 2.0;
      float radius = sqrt(clamp(1.0 - l, 0.0, 1.0));
      float ink = smoothstep(radius + 0.12, radius - 0.12, d);
      vec3 paper = vec3(0.96, 0.94, 0.88);
      vec3 inkColor = vec3(0.85, 0.13, 0.30);
      return mix(paper, inkColor, ink);
    }

    void main() {
      vec2 imgUv = coverUv(vUv, uImageSize, uViewSize);
      vec4 fluid = texture2D(tFluid, vUv);

      float mask = smoothstep(0.06, 0.32, fluid.b);
      float edge = mask * (1.0 - mask) * 4.0;

      // Clean original (the revealed layer), edge rippled by the velocity field.
      vec2 revealUv = clamp(imgUv - fluid.rg * uEdge * edge, 0.0, 1.0);
      vec3 clean = texture2D(tImage, revealUv).rgb;
      vec3 plain = texture2D(tImage, imgUv).rgb;

      // Sealed treatment depends on the chosen effect.
      vec3 sealed;
      if (uEffect == 0) {
        float l = dot(plain, LUMA);
        sealed = vec3(pow(l, 1.5)) * 0.5;          // B/W, contrast-crushed
      } else if (uEffect == 1) {
        sealed = blur(imgUv);                       // frosted
      } else if (uEffect == 2) {
        float blocks = 90.0;                        // pixelized
        vec2 pUv = (floor(imgUv * blocks) + 0.5) / blocks;
        sealed = texture2D(tImage, pUv).rgb;
      } else if (uEffect == 3) {
        sealed = halftone(plain);                   // riso/halftone
      } else {
        sealed = plain * 0.5;                        // edge glow: dim clean image
      }

      vec3 color = mix(sealed, clean, mask);

      // Wet rim — boosted + neon-tinted for the Edge glow effect.
      float rimScale = (uEffect == 4) ? 3.0 : 1.0;
      color += clean * edge * uRim * rimScale;
      if (uEffect == 4) color += vec3(0.1, 0.65, 0.95) * edge * uRim * 2.0;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
  uniforms: {
    tImage: new Uniform<Texture | null>(null),
    tFluid: new Uniform(fluid.densityTexture),
    uImageSize: new Uniform(new Vector2(1, 1)),
    uViewSize: new Uniform(new Vector2(1, 1)),
    uEdge: new Uniform(params.edge),
    uRim: new Uniform(params.rim),
    uEffect: new Uniform(EFFECTS[params.effect]),
  },
})
const pass = new FullscreenPass(composite)
applyImage(IMAGES[params.image])

// --- controls ---
const controls = createControlsPane('Mask Effects', params, (pane, p) => {
  const look = pane.addFolder({ title: 'Effect' })
  look.addBinding(p, 'effect', { options: Object.fromEntries(Object.keys(EFFECTS).map((k) => [k, k])) })
  look
    .addBinding(p, 'image', { options: Object.fromEntries(Object.keys(IMAGES).map((k) => [k, k])) })
    .on('change', (ev) => applyImage(IMAGES[ev.value as string]))

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

function syncParams(): void {
  const p = controls.params
  fluid.splatRadius = p.splatRadius
  fluid.splatForce = p.splatForce
  fluid.densityDissipation = p.densityDissipation
  fluid.velocityDissipation = p.velocityDissipation
  composite.uniforms.uEdge.value = p.edge
  composite.uniforms.uRim.value = p.rim
  composite.uniforms.uEffect.value = EFFECTS[p.effect]
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
  fluid.step(fluidDt)
  composite.uniforms.tFluid.value = fluid.densityTexture
  pass.render(renderer, null)
})

// --- cleanup ---
window.addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null)
  window.removeEventListener('resize', resize)
  ;(composite.uniforms.tImage.value as Texture | null)?.dispose()
  pass.dispose()
  controls.dispose()
  fluid.dispose()
  renderer.dispose()
  renderer.domElement.remove()
})
