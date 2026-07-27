import {
  WebGLRenderer,
  SRGBColorSpace,
  NoToneMapping,
  PCFShadowMap,
} from 'three';

/** Base pixel ratio: honour HiDPI up to 1.5 — beyond that the fill-rate cost
 *  outweighs the sharpness gain on the target GPU (Iris Xe @1080p). */
export function basePixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 1.5);
}

export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false, // SMAA runs in the post chain
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = SRGBColorSpace;
  // Tone mapping happens in the post chain (ToneMappingEffect, ACES) so the
  // HDR buffer stays linear for AO and bloom. The renderer itself must not
  // tone-map, or we'd do it twice.
  renderer.toneMapping = NoToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // Spec asks for PCFSoftShadowMap; three r185 deprecated it and silently
  // falls back to PCFShadowMap, so we set the fallback explicitly to keep
  // the console clean. Softness comes from CSM cascade density + bias tuning.
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setPixelRatio(basePixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  // We count draw calls across ALL passes (shadow, AO prepass, main, post),
  // so reset renderer.info manually once per frame instead of per render().
  renderer.info.autoReset = false;
  return renderer;
}

/** The real GPU behind the context — perf numbers are meaningless without it. */
export function hardwareString(renderer: WebGLRenderer): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext
    ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  return gpu;
}
