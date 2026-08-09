import {
  TextureLoader,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export interface PbrMaps {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
  aoMap: Texture;
}

const TEX_ROOT = '/assets/textures';
export const HDRI_URL = '/assets/hdri/kloppenheim_06_puresky_1k.hdr';

/** One texture set = 4 maps. 3 sets + 1 HDRI + physics init = 14 units. */
export const TOTAL_LOAD_UNITS = 14;

const texLoader = new TextureLoader();
const hdrLoader = new HDRLoader();

async function loadTex(
  url: string,
  opts: { srgb: boolean; repeatX: number; repeatY: number },
): Promise<Texture> {
  const tex = await texLoader.loadAsync(url);
  tex.colorSpace = opts.srgb ? SRGBColorSpace : tex.colorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(opts.repeatX, opts.repeatY);
  tex.anisotropy = 8;
  // Our geometry only has one UV channel; AO/roughness default to channel 0
  // anyway, but be explicit so aoMap (default channel 1 in three) works.
  tex.channel = 0;
  return tex;
}

export async function loadPbrSet(
  name: string,
  repeatX: number,
  repeatY: number,
  onProgress: (label: string) => void,
): Promise<PbrMaps> {
  const base = `${TEX_ROOT}/${name}/${name}`;
  const [map, normalMap, roughnessMap, aoMap] = await Promise.all([
    loadTex(`${base}_diff_1k.jpg`, { srgb: true, repeatX, repeatY }).then((t) => {
      onProgress(`${name}/diff`);
      return t;
    }),
    loadTex(`${base}_nor_gl_1k.jpg`, { srgb: false, repeatX, repeatY }).then((t) => {
      onProgress(`${name}/normal`);
      return t;
    }),
    loadTex(`${base}_rough_1k.jpg`, { srgb: false, repeatX, repeatY }).then((t) => {
      onProgress(`${name}/rough`);
      return t;
    }),
    loadTex(`${base}_ao_1k.jpg`, { srgb: false, repeatX, repeatY }).then((t) => {
      onProgress(`${name}/ao`);
      return t;
    }),
  ]);
  return { map, normalMap, roughnessMap, aoMap };
}

export async function loadHdri(onProgress: (label: string) => void): Promise<Texture> {
  const tex = await hdrLoader.loadAsync(HDRI_URL);
  onProgress('hdri');
  return tex;
}

/** Generated GLB models (Higgsfield pipeline — see CREDITS.md). Loaded
 *  lazily AFTER boot: systems keep their placeholder visuals until the
 *  promise resolves, then swap. Never gate `ready` on these. Meshy GLBs
 *  normalize their long axis (~1.9) / character height (1.0) — callers MUST
 *  apply an explicit scale; the file's own size is not meters. */
const MODEL_ROOT = '/assets/gen/models';
const gltfLoader = new GLTFLoader();
const modelCache = new Map<string, Promise<GLTF>>();

export function loadModel(name: string): Promise<GLTF> {
  let p = modelCache.get(name);
  if (!p) {
    p = gltfLoader.loadAsync(`${MODEL_ROOT}/${name}.glb`);
    modelCache.set(name, p);
  }
  return p;
}
