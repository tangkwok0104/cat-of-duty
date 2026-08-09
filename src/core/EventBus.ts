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
  'weapon:fired': { hit: boolean; profile: 'rifle' | 'shotgun' | 'sniper' | 'smg' };
  /** Trigger pulled on an empty mag. */
  'weapon:dry': Record<string, never>;
  'weapon:reload-start': Record<string, never>;
  'weapon:reload-end': Record<string, never>;
  'weapon:switched': { slot: number; name: string };
  /** A shot hit static world geometry (wall/pillar/crate) — impact thud +
   *  where ImpactBurst/Decals already fire (this rides the same hit point).
   *  Cats have their own 'enemy:hit' cue instead; this is concrete, not fur. */
  'weapon:impact': { x: number; y: number; z: number };
  /** A cat took damage. */
  'enemy:hit': { id: number; part: 'head' | 'body'; damage: number; killed: boolean };
  /** One ground step completed (emitted by CameraFeel at bob-phase
   *  crossings, so step audio stays locked to the visual bob). */
  'player:footstep': { sprinting: boolean; crouching: boolean };
  /** Kill-chain tier increase within one 4s combo window (1 = first chain
   *  tier, 3 = highest). Fires only on tier RISE, never per kill. */
  'score:streak': { tier: 1 | 2 | 3; combo: number };
  /** A cat entered the field (heavy spawns get a growl). */
  'enemy:spawned': { id: number; archetype: import('./GameState').CatArchetype };
  /** A rusher/heavy started a claw swipe (battle meow + swipe anim). */
  'enemy:melee': { id: number };
  /** The field just went clear (victory meow; next wave after the breather). */
  /** Field is clear. `breatherS` = length of the intermission that starts
   *  now (HUD derives its countdown from this one event — no per-tick spam). */
  'wave:cleared': { wave: number; breatherS: number };
  /** A ranged cat started its telegraph (audio cue — the fair-warning chirp). */
  'enemy:windup': { id: number; x: number; z: number };
  /** A ranged cat fired a projectile (muzzle sound, minimap ping). */
  'enemy:fired': { id: number; x: number; z: number };
  /** A cat died (killfeed reads the archetype name from here — the cat may
   *  already be gone from state.cats when the HUD renders; x/z is the death
   *  spot, where pickups drop). */
  'enemy:killed': { id: number; archetype: import('./GameState').CatArchetype; headshot: boolean; x: number; z: number };
  /** The player collected a drop. */
  'pickup:collected': { kind: 'health' | 'ammo' };
  /** The player picked a weapon up off the ground. */
  'weapon:acquired': { slot: number; name: string };
  /** The player took damage (fromX/fromZ = attacker position, for the
   *  damage-direction indicator). */
  'player:damaged': { amount: number; fromX: number; fromZ: number };
  'player:died': Record<string, never>;
  /** Full slice restart (R while dead) — every system resets itself. */
  'game:restart': Record<string, never>;
  /** `special` = every-5th heavy-drop wave (extra heavies, pre-announced). */
  'wave:started': { wave: number; count: number; special: boolean };
  /** A field promotion was bought during the intermission (TUNA spent). */
  'upgrade:purchased': { id: 'claws' | 'pockets' | 'lives'; level: number; cost: number };
  /** Purchase attempt rejected — HUD gives the chip a deny shake. */
  'upgrade:denied': { id: 'claws' | 'pockets' | 'lives'; reason: 'tuna' | 'maxed' | 'closed' };
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
