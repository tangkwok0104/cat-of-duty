/** Single source of truth. Systems read from and write to this object;
 *  sibling systems never import each other directly. */

export interface StaticColliderSpec {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

export interface DynamicBoxSpec {
  x: number;
  y: number;
  z: number;
  half: number;
}

export interface LevelData {
  staticColliders: StaticColliderSpec[];
  dynamicBoxes: DynamicBoxSpec[];
}

/** Physics writes crate transforms here (SoA, preallocated — the render
 *  loop interpolates prev→curr without allocating). */
export interface CrateBuffers {
  count: number;
  prevPos: Float32Array;
  currPos: Float32Array;
  prevRot: Float32Array; // quaternions, xyzw
  currRot: Float32Array;
}

export interface PerfState {
  /** Last frame's wall-clock duration in ms. */
  frameMs: number;
  /** Draw calls of the last rendered frame (all passes included). */
  drawCalls: number;
  triangles: number;
  /** JS heap in MB if the browser exposes it, else -1. */
  heapMB: number;
}

export type QualityTier = 0 | 1 | 2 | 3;

export interface GameState {
  ready: boolean;
  level: LevelData;
  crates: CrateBuffers | null;
  quality: { tier: QualityTier; auto: boolean };
  perf: PerfState;
}

export function createGameState(): GameState {
  return {
    ready: false,
    level: { staticColliders: [], dynamicBoxes: [] },
    crates: null,
    quality: { tier: 0, auto: true },
    perf: { frameMs: 0, drawCalls: 0, triangles: 0, heapMB: -1 },
  };
}
