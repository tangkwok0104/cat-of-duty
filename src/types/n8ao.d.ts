/** n8ao ships no type declarations — minimal surface we use. */
declare module 'n8ao' {
  import type { Scene, Camera, Color } from 'three';
  import { Pass } from 'postprocessing';

  export interface N8AOConfiguration {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    color: Color;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    setQualityMode(
      mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra',
    ): void;
    enabled: boolean;
  }
}
