import {
  Vector3,
  EquirectangularReflectionMapping,
  type Scene,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { PMREMGenerator } from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { bus } from '../core/EventBus';

/** Sun + cascaded shadow maps + HDRI image-based lighting.
 *  The sun direction roughly matches the HDRI's sun so specular highlights,
 *  shadow direction and sky read as one light source. */
export class Lighting {
  readonly csm: CSM;

  constructor(scene: Scene, camera: PerspectiveCamera) {
    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: 2,
      maxFar: 60,
      mode: 'practical',
      shadowMapSize: 2048,
      lightDirection: new Vector3(-0.45, -0.7, -0.3).normalize(),
      lightIntensity: 2.6,
      lightMargin: 30,
    });
    this.csm.fade = true;
    for (const light of this.csm.lights) {
      light.shadow.bias = -0.0002;
      light.shadow.normalBias = 0.02;
      light.color.setHex(0xfff2df); // warm late-afternoon sun
    }

    bus.on('level:built', ({ csmMaterials }) => {
      for (const mat of csmMaterials) this.csm.setupMaterial(mat);
    });
  }

  /** HDRI → PMREM for IBL; raw equirect stays as the visible sky. */
  applyEnvironment(renderer: WebGLRenderer, scene: Scene, hdri: Texture): void {
    const pmrem = new PMREMGenerator(renderer);
    const envRT = pmrem.fromEquirectangular(hdri);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.55;
    hdri.mapping = EquirectangularReflectionMapping;
    scene.background = hdri;
    scene.backgroundIntensity = 1.0;
    pmrem.dispose();
  }

  setShadowMapSize(size: number): void {
    for (const light of this.csm.lights) {
      light.shadow.mapSize.set(size, size);
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
    }
  }

  update(): void {
    this.csm.update();
  }

  onResize(): void {
    this.csm.updateFrustums();
  }
}
