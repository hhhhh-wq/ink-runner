import '../../../../src/styles.css'
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

// Fluid Reveal Mask — drag the pointer to reveal a hidden second image under
// the first. The fluid density (.b) is the mask; the velocity field (.rg)
// ripples the reveal edge so it looks liquid, not a hard circle.
//
// Here: a run-down room (base) renovated into a modern one (reveal) — two
// photos from the same camera, so the reveal lines up.

const IMAGE_BASE = '/backdrops/apartment_0.webp' // before — the sealed layer
const IMAGE_REVEAL = '/backdrops/apartment_1.webp' // after — revealed under the pointer

// All knobs in one place — change here, propagated everywhere.
const DEFAULTS = {
  splatRadius: 0.0175,
  splatForce: 6,
  // Slow density decay: the reveal lingers a good while, then heals back.
  densityDissipation: 0.985,
  // High so the fluid keeps flowing like water; vorticity stays off (no curls).
  velocityDissipation: 0.94,
  // Velocity ripple applied ONLY at the reveal boundary (liquid edge).
  edge: 0.0003,
  // Glow strength of the bright "wet" line at the reveal boundary.
  rim: 0.35,
}

// 1. Renderer + DOM
const stage = document.getElementById('stage')
if (!(stage instanceof HTMLElement)) throw new Error('Missing #stage')

const renderer = new WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.outputColorSpace = SRGBColorSpace
renderer.setClearColor(new Color('#07080b'), 1)
stage.appendChild(renderer.domElement)

// 2. Fluid solver + pointer
const fluid = new FluidSimulation(renderer, {
  splatRadius: DEFAULTS.splatRadius,
  splatForce: DEFAULTS.splatForce,
  densityDissipation: DEFAULTS.densityDissipation,
  velocityDissipation: DEFAULTS.velocityDissipation,
  enableVorticity: false,
  curlStrength: 0,
  reflectWalls: false,
})
attachPointerSplats(renderer.domElement, fluid)

// 3. Load the two layers. They share a size, so one cover-fit serves both.
const loader = new TextureLoader()
function loadImage(url: string): Texture {
  const texture = loader.load(url, (loaded) => {
    const source = loaded.image as { width?: number; height?: number } | undefined
    if (source?.width && source?.height) {
      composite.uniforms.uImageSize.value.set(source.width, source.height)
    }
  })
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  return texture
}
const baseTexture = loadImage(IMAGE_BASE)
const revealTexture = loadImage(IMAGE_REVEAL)

// 4. Composite shader: fluid density is the reveal mask, velocity warps the edge.
const composite = new ShaderMaterial({
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tBase;
    uniform sampler2D tReveal;
    uniform sampler2D tFluid;
    uniform vec2 uImageSize; // natural pixel size of the photos
    uniform vec2 uViewSize;  // canvas size in pixels
    uniform float uEdge;
    uniform float uRim;

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
      vec2 imgUv = coverUv(vUv, uImageSize, uViewSize);
      vec4 fluid = texture2D(tFluid, vUv);

      // .b is density -> the reveal amount; edge band peaks at the boundary.
      float mask = smoothstep(0.06, 0.32, fluid.b);
      float edge = mask * (1.0 - mask) * 4.0;

      vec3 base = texture2D(tBase, imgUv).rgb;

      // Reveal layer, its boundary dragged by the velocity field (.rg).
      vec2 revealUv = clamp(imgUv - fluid.rg * uEdge * edge, 0.0, 1.0);
      vec3 reveal = texture2D(tReveal, revealUv).rgb;

      vec3 color = mix(base, reveal, mask);

      // Wet rim: a bright line where liquid meets the sealed area.
      color += reveal * edge * uRim;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
  uniforms: {
    tBase: new Uniform(baseTexture),
    tReveal: new Uniform(revealTexture),
    tFluid: new Uniform(fluid.densityTexture),
    uImageSize: new Uniform(new Vector2(1, 1)),
    uViewSize: new Uniform(new Vector2(1, 1)),
    uEdge: new Uniform(DEFAULTS.edge),
    uRim: new Uniform(DEFAULTS.rim),
  },
})
const pass = new FullscreenPass(composite)

// 5. Resize
const resize = (): void => {
  const w = Math.max(1, stage.clientWidth)
  const h = Math.max(1, stage.clientHeight)
  renderer.setSize(w, h, false)
  fluid.resize(w, h)
  composite.uniforms.uViewSize.value.set(w, h)
}
resize()
window.addEventListener('resize', resize)

// 6. Loop: step fluid -> composite to screen
const clock = new Timer()
renderer.setAnimationLoop(() => {
  clock.update()
  const fluidDt = Math.min(Math.max(clock.getDelta(), 1e-6), 1 / 60)
  fluid.step(fluidDt)
  composite.uniforms.tFluid.value = fluid.densityTexture
  pass.render(renderer, null)
})
