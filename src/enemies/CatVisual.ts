import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CatArchetype, CatData } from '../core/GameState';
import { ARCHETYPES, type EnemyArchetype } from './EnemyConfig';

/** Articulated procedural cat soldier — still primitives (no model files
 *  exist yet), but now a torso + head + tail + 4 legs instead of a capsule.
 *  Hard perf budget: ≤7 Mesh objects per cat (torso, head, tail, 4 legs).
 *  Two-tone parts (vest band, ear tips, helmet plate, gunner's blaster box)
 *  ride along as extra material GROUPS merged into those 7 geometries — a
 *  group costs a draw call, not a scene-graph mesh, so it doesn't eat the
 *  budget. Geometries are shared module-level (per-archetype where the
 *  silhouette differs, fully shared where it doesn't); only the eye
 *  material is cloned per cat, because it animates per-cat (windup flare,
 *  death fade). */

export interface CatVisual {
  group: Group;
  update(cat: CatData, nowS: number): void;
}

// ---- Death timings (lifted from CatSystem — kept in lockstep by contract,
// see the BUILD SPEC note "same timings as the current CatSystem code"). ----
const FALL_TIME = 0.25;
const DESPAWN_AFTER = 2.0;

// ---- Walk-cycle tuning. ----
const GAIT_SPEED_K = 2.4; // rad of gait phase per (m/s) of cat.speed
const LEG_SWING_BASE = 0.32; // rad, swing amplitude floor
const LEG_SWING_SPEED_K = 0.05; // rad added per (m/s) of cat.speed

// Hip attachment points (group-local, unscaled). Shared across archetypes —
// legs are cosmetic (no 'leg' hitbox part exists), so exact per-archetype
// placement isn't load-bearing. FL/FR face -Z (front, matches the eyes'
// -Z offset below); BL/BR sit at +Z (back, matches the tail).
const LEG_HIP: readonly [x: number, y: number, z: number][] = [
  [-0.11, 0.22, -0.13], // front-left
  [0.11, 0.22, -0.13], // front-right
  [-0.11, 0.22, 0.13], // back-left
  [0.11, 0.22, 0.13], // back-right
];

// Shared leg geometry: pivot (hip) baked at local origin, leg hangs below —
// lets update() swing it with a plain rotation.x, no wrapper Group needed.
const LEG_LENGTH = 0.22;
const LEG_GEO = new CylinderGeometry(0.045, 0.05, LEG_LENGTH, 6).translate(0, -LEG_LENGTH / 2, 0);

// Shared tail geometry: two boxes rotated before translating (so each
// rotates about its own center first) to read as one bent segment.
const TAIL_GEO = mergeGeometries(
  [
    new BoxGeometry(0.05, 0.05, 0.24).rotateX(-0.35).translate(0, 0.56, 0.26),
    new BoxGeometry(0.045, 0.045, 0.16).rotateX(0.55).translate(0, 0.68, 0.44),
  ],
  false,
);

const EYE_BASE = new MeshStandardMaterial({
  color: 0x000000,
  emissive: 0x9ee493,
  emissiveIntensity: 2.5,
  roughness: 1,
});

interface ArchetypeAssets {
  furMat: MeshStandardMaterial;
  vestMat: MeshStandardMaterial;
  torsoGeo: BufferGeometry;
  torsoMats: MeshStandardMaterial[];
  headGeo: BufferGeometry;
  headHasHelmet: boolean;
}

/** Builds the one set of shared geometries + materials for an archetype.
 *  Runs once at module init per archetype (3 total) — never per cat. */
function buildAssets(arch: EnemyArchetype): ArchetypeAssets {
  const furMat = new MeshStandardMaterial({ color: arch.furColor, roughness: 0.9, metalness: 0 });
  const vestMat = new MeshStandardMaterial({ color: arch.vestColor, roughness: 0.9, metalness: 0 });

  const bulky = arch.id === 'heavy'; // heavy: broader torso, helmet, no vest (mesh-budget trade)
  const slim = arch.id === 'gunner'; // gunner: narrower torso, shoulder blaster box

  // Capsule length is solved so the bottom of the torso always touches the
  // ground (y=0) regardless of radius — the CENTER must stay at 0.44 for
  // the hitbox promise, so a fatter capsule needs a shorter straight run.
  const torsoRadius = bulky ? 0.28 : slim ? 0.18 : 0.22;
  const torsoLen = 2 * (0.44 - torsoRadius);

  const torsoGeos: BufferGeometry[] = [
    new CapsuleGeometry(torsoRadius, torsoLen, 6, 12).translate(0, 0.44, 0),
  ];
  const torsoMats: MeshStandardMaterial[] = [furMat];
  if (!bulky) {
    // Vest band — a fully-wrapping box (an undersized box z-fights through
    // the fur as broken dark patches, same lesson as the placeholder cat).
    torsoGeos.push(
      new BoxGeometry(torsoRadius * 2 + 0.06, 0.14, torsoRadius * 2 + 0.06).translate(0, 0.48, 0),
    );
    torsoMats.push(vestMat);
  }
  if (slim) {
    // Shoulder-mounted blaster box — the gunner's at-range silhouette tell.
    torsoGeos.push(
      new BoxGeometry(0.11, 0.09, 0.17).translate(torsoRadius + 0.08, 0.54, -0.03),
    );
    torsoMats.push(vestMat);
  }
  const torsoGeo = mergeGeometries(torsoGeos, true);

  const headR = bulky ? 0.185 : slim ? 0.15 : 0.16;
  const furHeadGeo = new SphereGeometry(headR, 12, 10).translate(0, 0.95, 0);
  const earGeo = mergeGeometries(
    [
      new ConeGeometry(0.05, 0.12, 4).translate(-headR * 0.5, 0.95 + headR + 0.03, 0),
      new ConeGeometry(0.05, 0.12, 4).translate(headR * 0.5, 0.95 + headR + 0.03, 0),
    ],
    false,
  );
  const eyeGeo = mergeGeometries(
    [
      new SphereGeometry(0.024, 6, 6).translate(-headR * 0.35, 0.97, -headR - 0.02),
      new SphereGeometry(0.024, 6, 6).translate(headR * 0.35, 0.97, -headR - 0.02),
    ],
    false,
  );
  const headParts: BufferGeometry[] = [furHeadGeo, earGeo, eyeGeo];
  const headHasHelmet = bulky;
  if (bulky) {
    // Flat helmet plate — heavy's silhouette tell, folded into the head
    // mesh (not a separate mesh) so dropping the torso vest keeps the
    // 7-mesh budget intact.
    headParts.push(
      new BoxGeometry(headR * 1.7, 0.045, headR * 1.5).translate(0, 0.95 + headR + 0.02, -0.01),
    );
  }
  const headGeo = mergeGeometries(headParts, true);

  return { furMat, vestMat, torsoGeo, torsoMats, headGeo, headHasHelmet };
}

const ASSETS: Record<CatArchetype, ArchetypeAssets> = {
  rusher: buildAssets(ARCHETYPES.rusher),
  gunner: buildAssets(ARCHETYPES.gunner),
  heavy: buildAssets(ARCHETYPES.heavy),
};

/** Builds one cat's visual. Geometries + fur/vest materials are shared
 *  archetype-level assets; only the eye material is cloned (it animates
 *  per-cat: windup flare, death fade). */
export function buildCatVisual(id: number, archetype: EnemyArchetype): CatVisual {
  const assets = ASSETS[archetype.id];
  const group = new Group();
  group.scale.setScalar(archetype.scale);

  const torsoMesh = new Mesh(assets.torsoGeo, assets.torsoMats);
  torsoMesh.castShadow = true;
  torsoMesh.receiveShadow = false;

  const eyeMat = EYE_BASE.clone();
  eyeMat.emissive.setHex(archetype.eyeColor);
  const headMats: MeshStandardMaterial[] = assets.headHasHelmet
    ? [assets.furMat, assets.vestMat, eyeMat, assets.vestMat]
    : [assets.furMat, assets.vestMat, eyeMat];
  const headMesh = new Mesh(assets.headGeo, headMats);
  headMesh.castShadow = true;
  headMesh.receiveShadow = false;

  const tailMesh = new Mesh(TAIL_GEO, assets.vestMat);
  tailMesh.castShadow = true;
  tailMesh.receiveShadow = false;

  const legFL = new Mesh(LEG_GEO, assets.furMat);
  const legFR = new Mesh(LEG_GEO, assets.furMat);
  const legBL = new Mesh(LEG_GEO, assets.furMat);
  const legBR = new Mesh(LEG_GEO, assets.furMat);
  const legs = [legFL, legFR, legBL, legBR] as const;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const hip = LEG_HIP[i];
    if (!leg || !hip) continue; // unreachable — both arrays are fixed-length 4
    leg.position.set(hip[0], hip[1], hip[2]);
    leg.castShadow = true;
    leg.receiveShadow = false;
  }

  group.add(torsoMesh, headMesh, tailMesh, legFL, legFR, legBL, legBR);

  // Total windup duration for this archetype (0 windup = "about to fire").
  // Melee-only archetypes never receive cat.windup > 0, but a fallback
  // keeps the ramp math finite either way.
  const totalWindup = archetype.ranged?.windup ?? 0.45;

  function update(cat: CatData, nowS: number): void {
    group.position.set(cat.x, cat.y, cat.z);
    group.rotation.y = cat.yaw;

    if (cat.phase === 'dying') {
      // Keel over sideways, then sink slightly; eyes fade to black.
      const fall = Math.min(1, cat.deadFor / FALL_TIME);
      group.rotation.z = (Math.PI / 2) * fall;
      const sink = Math.max(0, cat.deadFor - FALL_TIME) * 0.12;
      group.position.y = cat.y - sink;
      const fade = Math.max(0, 1 - cat.deadFor / DESPAWN_AFTER);
      eyeMat.emissiveIntensity = 2.5 * fade;
      return;
    }

    // Whole-body jerk on a fresh hit; otherwise rotation.z is free (the
    // walk waddle now lives in the legs, not a body-wide rock).
    group.rotation.z = cat.flinch > 0 ? Math.sin(nowS * 70) * 0.08 : 0;

    // Trot gait: diagonal leg pairs swing together (FL+BR, FR+BL), offset
    // by id so a wave of cats doesn't all step in lockstep. Amplitude
    // scales with cat.speed so a slow-strafing gunner still visibly steps.
    const gaitPhase = nowS * (cat.speed * GAIT_SPEED_K) + id;
    const amp = LEG_SWING_BASE + cat.speed * LEG_SWING_SPEED_K;
    const swingA = Math.sin(gaitPhase) * amp;
    const swingB = Math.sin(gaitPhase + Math.PI) * amp;
    legFL.rotation.x = swingA;
    legBR.rotation.x = swingA;
    legFR.rotation.x = swingB;
    legBL.rotation.x = swingB;

    // Tail: slow side sway plus a small speed-driven lift.
    tailMesh.rotation.y = Math.sin(nowS * 1.4 + id) * 0.22;
    tailMesh.rotation.x = Math.min(0.12, cat.speed * 0.025);

    // Windup telegraph: eyes flare 2.5 -> ~8 as the shot approaches, with a
    // slight head-lower crouch — readable at 10m so the player can react.
    let crouch = 0;
    if (cat.windup > 0) {
      const progress = 1 - Math.min(1, cat.windup / totalWindup);
      crouch = progress * 0.07;
      eyeMat.emissiveIntensity = 2.5 + progress * 5.5;
    } else {
      eyeMat.emissiveIntensity = 2.5;
    }
    const bob = Math.sin(gaitPhase * 2) * 0.012;
    headMesh.position.set(0, bob - crouch, 0);
  }

  return { group, update };
}
