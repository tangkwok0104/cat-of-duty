import { HalfFloatType, type Scene, type PerspectiveCamera, type WebGLRenderer } from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  SMAAEffect,
  SMAAPreset,
  EdgeDetectionMode,
  SelectiveBloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  HueSaturationEffect,
  VignetteEffect,
  NoiseEffect,
  BlendFunction,
} from 'postprocessing';
import type { Mesh } from 'three';
import { N8AOPostPass } from 'n8ao';
import { bus } from '../core/EventBus';

/** HDR post chain, in order:
 *    scene (linear HDR) → N8AO (half-res GTAO-style AO)
 *    → selective bloom (emissives only, threshold ≥1 in HDR)
 *    → ACES filmic tone map → vignette + film grain → SMAA.
 *  Chromatic aberration / radial blur are damage feedback (M5) — not here. */
export class PostFX {
  readonly composer: EffectComposer;
  private readonly aoPass: N8AOPostPass;
  private readonly bloom: SelectiveBloomEffect;
  private readonly bloomPass: EffectPass;
  private hueSat!: HueSaturationEffect;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: HalfFloatType,
      multisampling: 0,
    });
    this.composer.addPass(new RenderPass(scene, camera));

    this.aoPass = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
    this.aoPass.configuration.halfRes = true;
    this.aoPass.configuration.aoRadius = 1.6;
    this.aoPass.configuration.distanceFalloff = 3.2;
    this.aoPass.configuration.intensity = 2.5;
    this.aoPass.configuration.gammaCorrection = false; // stay linear pre-tonemap
    this.composer.addPass(this.aoPass);

    this.bloom = new SelectiveBloomEffect(scene, camera, {
      mipmapBlur: true,
      luminanceThreshold: 1.0,
      luminanceSmoothing: 0.2,
      intensity: 0.8,
      radius: 0.55,
    });
    this.bloom.ignoreBackground = true;

    // Bloom lives in its OWN pass: EffectPass.update() runs every fused
    // effect even when its blend is SKIP, so disabling bloom via blend mode
    // would keep paying its full mip-chain GPU cost. A dedicated pass with
    // .enabled=false is genuinely skipped by the composer — that's the whole
    // point of the quality ladder's "bloom off" step.
    this.bloomPass = new EffectPass(camera, this.bloom);
    this.composer.addPass(this.bloomPass);

    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    // Death desaturation: saturation eased toward -0.85 while dead.
    this.hueSat = new HueSaturationEffect({ saturation: 0 });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.5 });
    const grain = new NoiseEffect({ blendFunction: BlendFunction.COLOR_DODGE, premultiply: true });
    grain.blendMode.opacity.value = 0.035;
    this.composer.addPass(new EffectPass(camera, toneMapping, this.hueSat, vignette, grain));

    const smaa = new SMAAEffect({
      preset: SMAAPreset.HIGH,
      edgeDetectionMode: EdgeDetectionMode.COLOR,
    });
    this.composer.addPass(new EffectPass(camera, smaa));

    bus.on('level:built', ({ bloomMeshes }) => {
      for (const mesh of bloomMeshes) this.bloom.selection.add(mesh);
    });
  }

  setAOEnabled(on: boolean): void {
    this.aoPass.enabled = on;
  }

  setBloomEnabled(on: boolean): void {
    this.bloomPass.enabled = on;
  }

  /** Register additional emissives (viewmodel muzzle flash etc.). */
  addBloomMeshes(meshes: Mesh[]): void {
    for (const m of meshes) this.bloom.selection.add(m);
  }

  /** 0 = normal colour, 1 = fully drained (death). */
  setDesaturation(amount: number): void {
    this.hueSat.saturation = -0.85 * amount;
  }

  render(): void {
    this.composer.render();
  }

  onResize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }
}
