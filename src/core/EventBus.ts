import type { Material, Mesh, InstancedMesh } from 'three';

/** All cross-system events. Sibling system folders never import each other —
 *  they communicate through this bus (or read/write GameState). */
export interface Events {
  /** Fired once the grey-box level has been added to the scene. */
  'level:built': {
    /** Materials that must receive cascaded-shadow shader patches. */
    csmMaterials: Material[];
    /** Emissive meshes that belong in the selective bloom pass. */
    bloomMeshes: Mesh[];
    /** Instanced mesh whose transforms follow the dynamic physics crates. */
    dynamicCrateMesh: InstancedMesh;
  };
  /** Quality tier changed (user or adaptive). */
  'quality:changed': { tier: number; reason: 'manual' | 'adaptive' };
  /** A shot was fired (HUD spread, sound, viewmodel kick). */
  'weapon:fired': { hit: boolean; profile: 'rifle' | 'shotgun' | 'sniper' };
  /** Trigger pulled on an empty mag. */
  'weapon:dry': Record<string, never>;
  'weapon:reload-start': Record<string, never>;
  'weapon:reload-end': Record<string, never>;
  'weapon:switched': { slot: number; name: string };
  /** A cat took damage. */
  'enemy:hit': { id: number; part: 'head' | 'body'; damage: number; killed: boolean };
  /** The player took damage. */
  'player:damaged': { amount: number };
  'player:died': Record<string, never>;
  /** Full slice restart (R while dead) — every system resets itself. */
  'game:restart': Record<string, never>;
  'wave:started': { wave: number; count: number };
}

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

class EventBus {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, fn: Handler<K>): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as Handler<never>);
  }

  off<K extends keyof Events>(event: K, fn: Handler<K>): void {
    this.handlers.get(event)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of set) (fn as Handler<K>)(payload);
  }
}

/** Single shared bus instance. */
export const bus = new EventBus();
