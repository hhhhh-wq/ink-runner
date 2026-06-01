import { clamp, convertToTexture, float, Fn, min, mix, smoothstep, vec2, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

// TSL is loosely typed at the graph level; mirror the library's own node
// helpers (see SimpleDistortionNode) and chain on a permissive alias.
type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * background-size: cover — fit `mediaSize` into `viewSize`, cropping the
 * overflow, never stretching. Returns the UV to sample the media with.
 */
export function coverUv(screenUv: Node, mediaSize: Node, viewSize: Node): Node {
  const uv = screenUv as Any
  const media = mediaSize as Any
  const view = viewSize as Any
  const viewAspect = view.x.div(view.y)
  const mediaAspect = media.x.div(media.y)
  const ratio = vec2(
    min(viewAspect.div(mediaAspect), float(1)),
    min(mediaAspect.div(viewAspect), float(1)),
  )
  return uv.mul(ratio).add(vec2(1).sub(ratio).mul(0.5)) as Any
}

export interface FluidRevealOptions {
  /** Sealed (base) layer — a `texture(...)` node, always visible. */
  sealed: Node
  /** Hidden layer — a `texture(...)` node, revealed under the pointer. */
  reveal: Node
  /** Fluid density texture node (`.b` = density mask, `.rg` = velocity). */
  density: Node
  /** Screen UV (`screenUV`). */
  screenUv: Node
  /** Canvas size in pixels (uniform vec2). */
  viewSize: Node
  /** Natural size of the sealed layer in pixels (uniform vec2). */
  sealedSize: Node
  /** Natural size of the reveal layer; defaults to `sealedSize`. */
  revealSize?: Node
  /** Mask start / width. Defaults 0.06 / 0.26. */
  threshold?: Node | number
  softness?: Node | number
  /** Velocity ripple at the boundary. Default 0.0003. */
  edge?: Node | number
  /** Wet-rim glow. Default 0.35. */
  rim?: Node | number
  /** Sealed-layer brightness. Default 1. */
  baseDim?: Node | number
}

/**
 * Composite two layers through the fluid mask: density `.b` is the reveal
 * amount, velocity `.rg` ripples the boundary, and a bright rim glows along the
 * edge. Each layer is cover-fitted to the view. Returns a vec4 colour node.
 *
 * Used by the WebGL examples' inline shader, ported to a single TSL node so the
 * Reveal Mask / Reveal Video examples stay as small as the rest of the TSL set.
 */
export function fluidReveal(options: FluidRevealOptions): Node {
  const sealed = options.sealed as Any
  const reveal = options.reveal as Any
  const density = convertToTexture(options.density as Any) as Any
  const screenUv = options.screenUv
  const viewSize = options.viewSize
  const sealedSize = options.sealedSize
  const revealSize = options.revealSize ?? options.sealedSize
  const threshold = float((options.threshold ?? 0.06) as Any)
  const softness = float((options.softness ?? 0.26) as Any)
  const edge = float((options.edge ?? 0.0003) as Any)
  const rim = float((options.rim ?? 0.35) as Any)
  const baseDim = float((options.baseDim ?? 1) as Any)

  return Fn(() => {
    const fluidSample = density.sample(screenUv)
    const mask = smoothstep(threshold, threshold.add(softness), fluidSample.b)
    const edgeBand = mask.mul(float(1).sub(mask)).mul(4)

    const sealedColor = sealed.sample(coverUv(screenUv, sealedSize, viewSize)).rgb.mul(baseDim)
    const revealUv = clamp(
      (coverUv(screenUv, revealSize, viewSize) as Any).sub(fluidSample.rg.mul(edge).mul(edgeBand)),
      0,
      1,
    )
    const revealColor = reveal.sample(revealUv).rgb

    const color = mix(sealedColor, revealColor, mask).add(revealColor.mul(edgeBand).mul(rim))
    return vec4(color, 1)
  })() as Any
}
