import {
  AnimationMixer,
  Bone,
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
  type AnimationClip,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clone as cloneWithSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadModel } from '../core/Assets';
import type { CatArchetype, CatData } from '../core/GameState';
import { ARCHETYPES, type EnemyArchetype } from './EnemyConfig';

/** Cat soldier visuals. Two code paths:
 *
 *  1. GLB path (preferred): a SkeletonUtils clone of the generated rigged
 *     cat soldier (catsoldier.glb — grey tabby, helmet, vest, boots) driven
 *     by walk/idle clips retargeted from catsoldier-walk/-idle.glb. The
 *     three files share one rig (verified: identical bone names, retarget
 *     probe .tmp/rig-retarget.ts) — the -walk/-idle files carry the clips
 *     but only low-poly proxy meshes, so the MESH comes from catsoldier.glb.
 *  2. Procedural fallback: the previous primitives build, kept for the time
 *     before the lazy model load resolves and for when the GLBs 404.
 *
 *  Models load lazily AFTER boot — cats spawned before the load keep their
 *  procedural bodies (they die in seconds; no retro-swap), cats spawned
 *  after get the GLB. */

export interface CatVisual {
  group: Group;
  update(cat: CatData, nowS: number): void;
}

// ---- Death timings (lifted from CatSystem — kept in lockstep by contract,
// see the BUILD SPEC note "same timings as the current CatSystem code"). ----
const FALL_TIME = 0.25;
const DESPAWN_AFTER = 2.0;

// =========================================================================
// GLB soldier path
// =========================================================================

/** Hitbox contract (CANNOT move): head ball centre sits at 0.95 × archetype
 *  scale. The rig is scaled so the model's measured head centre lands there;
 *  feet stay at y=0 because the model's feet sit on its origin plane. */
const HEAD_HITBOX_Y = 0.95;

/** Eye-socket positions in bind-pose model space, tuned by screenshot
 *  against the master mesh (.tmp/eye-tune.ts → .tmp/rig-shots/eye-*.png).
 *  The face is slightly off the bone axis (baked asymmetry), hence the
 *  asymmetric x. Converted to head-bone-local space once at load. */
const EYE_WORLD_L = new Vector3(-0.0235, 0.824, 0.168);
const EYE_WORLD_R = new Vector3(0.0655, 0.824, 0.168);
const EYE_RADIUS = 0.02; // model units — scales with the rig

const SOLDIER_EYE_BASE = 1.2; // subtle resting glow
const SOLDIER_EYE_FLARE = 8; // windup telegraph peak

/** Distance the walk clip covers per playback second at timeScale 1 —
 *  drives timeScale = cat.speed / this so feet roughly match the ground. */
const WALK_METERS_PER_SEC = 1.4;
/** Below this ground speed the cat is "holding position" → idle clip. */
const IDLE_SPEED_EPS = 0.35;
const XFADE_TIME = 0.15; // walk<->idle crossfade seconds
const MAX_FRAME_DT = 0.1; // clamp big gaps (tab-out, hitches)

/** Archetype fur tints multiplied into the master texture. Rusher keeps the
 *  natural grey tabby; gunner reads warm brown, heavy dark slate (heavy's
 *  bulk mostly comes from archetype.scale 1.35). */
const SOLDIER_TINTS: Record<CatArchetype, number | null> = {
  rusher: null,
  gunner: 0xc59a6d,
  heavy: 0x7d8593,
};

const SOLDIER_EYE_GEO = new SphereGeometry(EYE_RADIUS, 8, 8);

interface SoldierAssets {
  master: Object3D;
  walkClip: AnimationClip;
  idleClip: AnimationClip;
  /** Uniform rig scale that puts the measured head centre at HEAD_HITBOX_Y. */
  baseScale: number;
  headBoneName: string | null;
  eyeLocalL: Vector3;
  eyeLocalR: Vector3;
  /** Mesh scale that makes the shared eye-sphere geometry render at
   *  EYE_RADIUS metres despite the armature's unit scale (this rig's bones
   *  carry a 0.01 cm→m world scale, which would shrink a naive child mesh
   *  to a fraction of a millimetre). */
  eyeMeshScale: number;
  /** Per archetype: master material → shared tinted clone (empty = untinted). */
  tints: Record<CatArchetype, Map<Material, Material>>;
}

let soldierAssets: SoldierAssets | null = null;

/** NEVER `instanceof` three classes on loader output: Vite pre-bundles
 *  `three` and `three/addons` as separate dep entries, so GLTFLoader's
 *  objects can come from a DIFFERENT three instance and every instanceof
 *  silently returns false (this exact bug shipped tint-less, eye-less cats
 *  on 2026-08-09). The `.isBone`/`.isMesh`/`.isMeshStandardMaterial` flags
 *  exist precisely for this — they are instance-independent. */
function isBoneObj(obj: Object3D): obj is Bone {
  return (obj as Bone).isBone === true;
}
function isMeshObj(obj: Object3D): obj is Mesh {
  return (obj as Mesh).isMesh === true;
}
function isStandardMat(mat: Material): mat is MeshStandardMaterial {
  return (mat as MeshStandardMaterial).isMeshStandardMaterial === true;
}

function findHeadBone(root: Object3D): Bone | null {
  let exact: Bone | null = null;
  let fuzzy: Bone | null = null;
  let highest: Bone | null = null;
  let highestY = -Infinity;
  const pos = new Vector3();
  root.traverse((obj) => {
    if (!isBoneObj(obj)) return;
    obj.getWorldPosition(pos);
    if (pos.y > highestY) {
      highestY = pos.y;
      highest = obj;
    }
    const name = obj.name.toLowerCase();
    if (name === 'head') exact = obj;
    else if (!fuzzy && name.includes('head')) fuzzy = obj;
  });
  return exact ?? fuzzy ?? highest;
}

/** Head centre ≈ midpoint of the head bone and its highest descendant
 *  (head_end sits at the crown on this rig). */
function measureHeadCentreY(headBone: Bone): number {
  const pos = new Vector3();
  headBone.getWorldPosition(pos);
  const headY = pos.y;
  let topY = headY;
  headBone.traverse((child) => {
    if (!isBoneObj(child) || child === headBone) return;
    child.getWorldPosition(pos);
    if (pos.y > topY) topY = pos.y;
  });
  return (headY + topY) / 2;
}

function buildTintMap(master: Object3D, tint: number | null): Map<Material, Material> {
  const map = new Map<Material, Material>();
  if (tint === null) return map;
  const tintColor = new Color(tint);
  master.traverse((obj) => {
    if (!isMeshObj(obj)) return;
    const mats: Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (map.has(mat) || !isStandardMat(mat)) continue;
      const tinted = mat.clone();
      tinted.color.multiply(tintColor);
      // This GLB is self-lit: its albedo texture doubles as the emissiveMap
      // at full-white emissive, so the visible fur colour is dominated by
      // the emissive term. Tinting only `color` is invisible — the emissive
      // factor must carry the same tint.
      tinted.emissive.multiply(tintColor);
      map.set(mat, tinted);
    }
  });
  return map;
}

// Lazy fire-and-forget load — never gates state.ready or the boot screen.
// On any failure (404, malformed file) soldierAssets stays null and every
// cat keeps the procedural body.
void Promise.all([
  loadModel('catsoldier'),
  loadModel('catsoldier-walk'),
  loadModel('catsoldier-idle'),
])
  .then(([masterGltf, walkGltf, idleGltf]) => {
    const walkClip = walkGltf.animations[0];
    const idleClip = idleGltf.animations[0];
    if (!walkClip || !idleClip) {
      console.warn('[CatVisual] soldier GLBs missing clips — keeping procedural cats');
      return;
    }
    const master = masterGltf.scene;
    master.updateMatrixWorld(true);

    const headBone = findHeadBone(master);
    let baseScale = 1.15; // sane default if the rig has no bones at all
    if (headBone) {
      const headCentreY = measureHeadCentreY(headBone);
      if (headCentreY > 0.1) baseScale = HEAD_HITBOX_Y / headCentreY;
    }
    baseScale = Math.min(1.4, Math.max(0.9, baseScale));

    // Eye offsets into head-bone-local space (bind pose, master at origin).
    // worldToLocal folds the armature's unit scale into the offsets; the
    // sphere GEOMETRY needs the inverse scale applied separately (below).
    const eyeLocalL = EYE_WORLD_L.clone();
    const eyeLocalR = EYE_WORLD_R.clone();
    let eyeMeshScale = 1;
    if (headBone) {
      headBone.worldToLocal(eyeLocalL);
      headBone.worldToLocal(eyeLocalR);
      const boneScale = new Vector3();
      headBone.getWorldScale(boneScale);
      if (boneScale.x > 1e-6) eyeMeshScale = 1 / boneScale.x;
    }

    soldierAssets = {
      master,
      walkClip,
      idleClip,
      baseScale,
      headBoneName: headBone ? headBone.name : null,
      eyeLocalL,
      eyeLocalR,
      eyeMeshScale,
      tints: {
        rusher: buildTintMap(master, SOLDIER_TINTS.rusher),
        gunner: buildTintMap(master, SOLDIER_TINTS.gunner),
        heavy: buildTintMap(master, SOLDIER_TINTS.heavy),
      },
    };
    // One-line load diagnostic (counterpart of the failure warns below):
    // headBone null or tint 0 here means cats will render un-tinted/eyeless.
    console.debug(
      `[CatVisual] soldier GLBs ready — headBone=${soldierAssets.headBoneName ?? 'NONE'}`,
      `baseScale=${baseScale.toFixed(4)}`,
      `tints g=${soldierAssets.tints.gunner.size} h=${soldierAssets.tints.heavy.size}`,
    );
  })
  .catch((err: unknown) => {
    console.warn('[CatVisual] soldier GLBs unavailable — keeping procedural cats', err);
  });

function buildSoldierVisual(
  assets: SoldierAssets,
  id: number,
  archetype: EnemyArchetype,
): CatVisual {
  const group = new Group();
  group.scale.setScalar(archetype.scale);

  const rig = cloneWithSkeleton(assets.master);
  rig.scale.setScalar(assets.baseScale);
  const tintMap = assets.tints[archetype.id];
  rig.traverse((obj) => {
    if (!isMeshObj(obj)) return;
    // One shadow caster per cat (was 2 on the procedural build).
    obj.castShadow = true;
    obj.receiveShadow = false;
    // Skinned bounds don't track bones; with ≤8 cats, never frustum-cull.
    obj.frustumCulled = false;
    if (tintMap.size > 0) {
      if (Array.isArray(obj.material)) {
        obj.material = obj.material.map((m: Material) => tintMap.get(m) ?? m);
      } else {
        obj.material = tintMap.get(obj.material) ?? obj.material;
      }
    }
  });
  group.add(rig);

  // Glow eyes over the baked-texture eye sockets, riding the head bone.
  // Per-cat material — it animates (windup flare, death fade).
  const eyeMat = new MeshStandardMaterial({
    color: 0x000000,
    emissive: archetype.eyeColor,
    emissiveIntensity: SOLDIER_EYE_BASE,
    roughness: 1,
  });
  const headBone = assets.headBoneName ? rig.getObjectByName(assets.headBoneName) : null;
  if (headBone) {
    const eyeL = new Mesh(SOLDIER_EYE_GEO, eyeMat);
    eyeL.position.copy(assets.eyeLocalL);
    const eyeR = new Mesh(SOLDIER_EYE_GEO, eyeMat);
    eyeR.position.copy(assets.eyeLocalR);
    for (const eye of [eyeL, eyeR]) {
      eye.scale.setScalar(assets.eyeMeshScale); // cancel armature unit scale
      eye.castShadow = false;
      eye.receiveShadow = false;
      eye.frustumCulled = false;
    }
    headBone.add(eyeL, eyeR);
  }

  const mixer = new AnimationMixer(rig);
  const walk = mixer.clipAction(assets.walkClip);
  const idle = mixer.clipAction(assets.idleClip);
  walk.play();
  idle.play();
  // Desync gait across the wave: offset each cat's clip phase by id.
  walk.time = (id * 0.37) % assets.walkClip.duration;
  idle.time = (id * 0.53) % assets.idleClip.duration;
  let walkWeight = 1;
  walk.setEffectiveWeight(1);
  idle.setEffectiveWeight(0);
  walk.setEffectiveTimeScale(1);

  const totalWindup = archetype.ranged?.windup ?? 0.45;

  // Preallocated per-visual scratch state — update() allocates nothing.
  let prevNow = Number.NaN;
  let prevX = Number.NaN;
  let prevZ = Number.NaN;

  function update(cat: CatData, nowS: number): void {
    group.position.set(cat.x, cat.y, cat.z);
    group.rotation.y = cat.yaw;

    const dt = Number.isNaN(prevNow) ? 0 : Math.min(Math.max(nowS - prevNow, 0), MAX_FRAME_DT);
    prevNow = nowS;

    if (cat.phase === 'dying') {
      // Mixer deliberately not updated — the pose freezes at the moment of
      // death, then the body keels over sideways and sinks; eyes fade out.
      const fall = Math.min(1, cat.deadFor / FALL_TIME);
      group.rotation.z = (Math.PI / 2) * fall;
      const sink = Math.max(0, cat.deadFor - FALL_TIME) * 0.12;
      group.position.y = cat.y - sink;
      const fade = Math.max(0, 1 - cat.deadFor / DESPAWN_AFTER);
      eyeMat.emissiveIntensity = SOLDIER_EYE_BASE * fade;
      return;
    }

    // Whole-body jerk on a fresh hit.
    group.rotation.z = cat.flinch > 0 ? Math.sin(nowS * 70) * 0.08 : 0;

    // Walk vs idle from actual displacement: a gunner holding preferred
    // range stands (idle), anything covering ground walks.
    let moving = true;
    if (dt > 0 && !Number.isNaN(prevX)) {
      const dx = cat.x - prevX;
      const dz = cat.z - prevZ;
      moving = Math.sqrt(dx * dx + dz * dz) / dt > IDLE_SPEED_EPS;
    }
    prevX = cat.x;
    prevZ = cat.z;

    const target = moving ? 1 : 0;
    if (walkWeight !== target) {
      const step = dt / XFADE_TIME;
      walkWeight =
        target > walkWeight
          ? Math.min(target, walkWeight + step)
          : Math.max(target, walkWeight - step);
      walk.setEffectiveWeight(walkWeight);
      idle.setEffectiveWeight(1 - walkWeight);
    }
    // Feet pace matches ground speed (cat.speed varies per cat).
    walk.setEffectiveTimeScale(cat.speed / WALK_METERS_PER_SEC);

    // Windup telegraph: eyes flare toward the shot — the fairness window.
    if (cat.windup > 0) {
      const progress = 1 - Math.min(1, cat.windup / totalWindup);
      eyeMat.emissiveIntensity =
        SOLDIER_EYE_BASE + progress * (SOLDIER_EYE_FLARE - SOLDIER_EYE_BASE);
    } else {
      eyeMat.emissiveIntensity = SOLDIER_EYE_BASE;
    }

    mixer.update(dt);
  }

  return { group, update };
}

// =========================================================================
// Procedural fallback path (pre-load + GLB-404 safety net)
// =========================================================================

/** Articulated procedural cat soldier — primitives (torso + head + tail +
 *  4 legs). Hard perf budget: ≤7 Mesh objects per cat. Two-tone parts ride
 *  along as extra material GROUPS merged into those 7 geometries. Geometries
 *  are shared module-level; only the eye material is cloned per cat (windup
 *  flare, death fade). */

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

/** Builds one cat's procedural visual (pre-GLB fallback). Geometries +
 *  fur/vest materials are shared archetype-level assets; only the eye
 *  material is cloned (it animates per-cat: windup flare, death fade). */
function buildProceduralVisual(id: number, archetype: EnemyArchetype): CatVisual {
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

  // Only torso + head cast shadows — tail/legs are shadow-invisible at
  // gameplay distance, and 7 casters/cat × 8 cats × 2 CSM cascades was the
  // in-combat draw-call blowout (305 seen vs the 150 budget).
  const tailMesh = new Mesh(TAIL_GEO, assets.vestMat);
  tailMesh.castShadow = false;
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
    leg.castShadow = false;
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

/** Builds one cat's visual: the rigged GLB soldier once the lazy model load
 *  has resolved, the procedural primitives build until then (and forever if
 *  the GLBs 404 — the game must keep working without them). */
export function buildCatVisual(id: number, archetype: EnemyArchetype): CatVisual {
  if (soldierAssets) return buildSoldierVisual(soldierAssets, id, archetype);
  return buildProceduralVisual(id, archetype);
}
