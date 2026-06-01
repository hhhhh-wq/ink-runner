import { clamp, convertToTexture, float, Fn, min, mix, smoothstep, vec2, vec4 } from 'three/tsl'
/**
 * background-size: cover — fit `mediaSize` into `viewSize`, cropping the
 * overflow, never stretching. Returns the UV to sample the media with.
 */
export function coverUv(screenUv, mediaSize, viewSize) {
  const uv = screenUv
  const media = mediaSize
  const view = viewSize
  const viewAspect = view.x.div(view.y)
  const mediaAspect = media.x.div(media.y)
  const ratio = vec2(
    min(viewAspect.div(mediaAspect), float(1)),
    min(mediaAspect.div(viewAspect), float(1)),
  )
  return uv.mul(ratio).add(vec2(1).sub(ratio).mul(0.5))
}
/**
 * Composite two layers through the fluid mask: density `.b` is the reveal
 * amount, velocity `.rg` ripples the boundary, and a bright rim glows along the
 * edge. Each layer is cover-fitted to the view. Returns a vec4 colour node.
 *
 * Used by the WebGL examples' inline shader, ported to a single TSL node so the
 * Reveal Mask / Reveal Video examples stay as small as the rest of the TSL set.
 */
export function fluidReveal(options) {
  const sealed = options.sealed
  const reveal = options.reveal
  const density = convertToTexture(options.density)
  const screenUv = options.screenUv
  const viewSize = options.viewSize
  const sealedSize = options.sealedSize
  const revealSize = options.revealSize ?? options.sealedSize
  const threshold = float(options.threshold ?? 0.06)
  const softness = float(options.softness ?? 0.26)
  const edge = float(options.edge ?? 0.0003)
  const rim = float(options.rim ?? 0.35)
  const baseDim = float(options.baseDim ?? 1)
  return Fn(() => {
    const fluidSample = density.sample(screenUv)
    const mask = smoothstep(threshold, threshold.add(softness), fluidSample.b)
    const edgeBand = mask.mul(float(1).sub(mask)).mul(4)
    const sealedColor = sealed.sample(coverUv(screenUv, sealedSize, viewSize)).rgb.mul(baseDim)
    const revealUv = clamp(
      coverUv(screenUv, revealSize, viewSize).sub(fluidSample.rg.mul(edge).mul(edgeBand)),
      0,
      1,
    )
    const revealColor = reveal.sample(revealUv).rgb
    const color = mix(sealedColor, revealColor, mask).add(revealColor.mul(edgeBand).mul(rim))
    return vec4(color, 1)
  })()
}
