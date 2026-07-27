/** Narrow capability interfaces so cross-cutting modules (debug harness)
 *  depend on core contracts, never on sibling system classes. main.ts is the
 *  composition root that wires concrete implementations. */
import type { QualityTier } from './GameState';

export interface CameraPoser {
  setCameraPose(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void;
}

export interface CrateResetter {
  resetCrates(): void;
}

export interface QualityControl {
  setTier(tier: QualityTier, auto: boolean): void;
  tierName(): string;
}

export interface BulletHit {
  hit: boolean;
  /** Rapier collider handle (look up in GameState.colliderToEnemy). */
  collider: number;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
}

export interface HitscanCaster {
  /** Ray from the camera through the world, excluding the player capsule.
   *  Dynamic bodies hit take a small impulse along the ray (impact punch). */
  castBullet(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxToi: number,
    out: BulletHit,
  ): void;
}

