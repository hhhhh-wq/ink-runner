import '../../../../src/styles.css'
import {
  Color,
  ShaderMaterial,
  SRGBColorSpace,
  Timer,
  Uniform,
  Vector2,
  VideoTexture,
  WebGLRenderer,
} from 'three'
import {
  attachPointerSplats,
  FluidSimulation,
  FULLSCREEN_VERTEX,
  FullscreenPass,
} from 'three-fluid-fx'
// Reveal Mask, but the two layers are VIDEOS instead of images. The fluid
// density is the reveal mask: drag the pointer to "x-ray" the product and see
// the moving internals through the moving exterior.
//
// The two clips are one turntable rendered twice (exterior / cutaway), framed
// identically — so at every frame the revealed internals line up with the body.
const VIDEO_BASE = '/videos/product_0.mp4' // exterior — the sealed layer
const VIDEO_REVEAL = '/videos/product_1.mp4' // internals — revealed under the pointer
const VIDEO_SIZE = new Vector2(1280, 720) // natural size of both clips
// All knobs in one place.
const DEFAULTS = {
  splatRadius: 0.015,
  splatForce: 6,
  // Slow density decay: the reveal window lingers, then heals back on its own.
  densityDissipation: 0.975,
  // High so the fluid keeps flowing like water; vorticity stays off (no curls).
  velocityDissipation: 0.94,
  // Velocity ripple at the reveal boundary only — a watery edge, not a circle.
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
// 3. Two looping, muted videos -> VideoTextures (auto-update each frame).
// Classic three.js VideoTexture setup (see the webgl_materials_video example):
// a muted, looping, inline <video> kept in the DOM and played explicitly.
function createVideo(src) {
  const video = document.createElement('video')
  video.src = src
  video.loop = true
  video.muted = true // required for autoplay
  video.playsInline = true
  video.style.display = 'none'
  document.body.appendChild(video)
  void video.play().catch(() => {}) // autoplay policy may defer until a gesture
  return video
}
const baseVideo = createVideo(VIDEO_BASE)
const revealVideo = createVideo(VIDEO_REVEAL)
function makeVideoTexture(video) {
  const texture = new VideoTexture(video)
  texture.colorSpace = SRGBColorSpace
  return texture
}
const baseTexture = makeVideoTexture(baseVideo)
const revealTexture = makeVideoTexture(revealVideo)
// 4. Composite shader: fluid density is the reveal mask, velocity warps the edge.
const composite = new ShaderMaterial({
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tBase;
    uniform sampler2D tReveal;
    uniform sampler2D tFluid;
    uniform vec2 uVideoSize; // natural pixel size of the clips
    uniform vec2 uViewSize;  // canvas size in pixels
    uniform float uEdge;
    uniform float uRim;

    // background-size: cover — fill the view, crop the overflow, never stretch.
    vec2 coverUv(vec2 uv, vec2 mediaSize, vec2 viewSize) {
      float viewAspect = viewSize.x / viewSize.y;
      float mediaAspect = mediaSize.x / mediaSize.y;
      vec2 ratio = vec2(
        min(viewAspect / mediaAspect, 1.0),
        min(mediaAspect / viewAspect, 1.0)
      );
      return uv * ratio + (1.0 - ratio) * 0.5;
    }

    void main() {
      vec2 mediaUv = coverUv(vUv, uVideoSize, uViewSize);
      vec4 fluid = texture2D(tFluid, vUv);

      // .b is density -> the reveal amount; edge band peaks at the boundary.
      float mask = smoothstep(0.06, 0.32, fluid.b);
      float edge = mask * (1.0 - mask) * 4.0;

      vec3 base = texture2D(tBase, mediaUv).rgb;

      // Reveal layer, its boundary dragged by the velocity field (.rg).
      vec2 revealUv = clamp(mediaUv - fluid.rg * uEdge * edge, 0.0, 1.0);
      vec3 reveal = texture2D(tReveal, revealUv).rgb;

      vec3 color = mix(base, reveal, mask);
      color += reveal * edge * uRim;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
  uniforms: {
    tBase: new Uniform(baseTexture),
    tReveal: new Uniform(revealTexture),
    tFluid: new Uniform(fluid.densityTexture),
    uVideoSize: new Uniform(VIDEO_SIZE.clone()),
    uViewSize: new Uniform(new Vector2(1, 1)),
    uEdge: new Uniform(DEFAULTS.edge),
    uRim: new Uniform(DEFAULTS.rim),
  },
})
const pass = new FullscreenPass(composite)
// Keep the natural size accurate once metadata arrives (cover-fit math).
baseVideo.addEventListener('loadedmetadata', () => {
  composite.uniforms.uVideoSize.value.set(baseVideo.videoWidth, baseVideo.videoHeight)
})
// 5. Resize
const resize = () => {
  const w = Math.max(1, stage.clientWidth)
  const h = Math.max(1, stage.clientHeight)
  renderer.setSize(w, h, false)
  fluid.resize(w, h)
  composite.uniforms.uViewSize.value.set(w, h)
}
resize()
window.addEventListener('resize', resize)
// 6. Loop: keep the clips in lockstep, step fluid, composite to screen.
const clock = new Timer()
renderer.setAnimationLoop(() => {
  clock.update()
  const fluidDt = Math.min(Math.max(clock.getDelta(), 1e-6), 1 / 60)
  // Resync the reveal clip to the base if they drift, so the x-ray lines up.
  if (Math.abs(revealVideo.currentTime - baseVideo.currentTime) > 0.05) {
    revealVideo.currentTime = baseVideo.currentTime
  }
  fluid.step(fluidDt)
  composite.uniforms.tFluid.value = fluid.densityTexture
  pass.render(renderer, null)
})
