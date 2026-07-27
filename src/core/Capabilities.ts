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
