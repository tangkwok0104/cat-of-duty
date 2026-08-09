import {
  BoxGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  Quaternion,
  Vector3,
  type Scene,
  type Material,
} from 'three';
import type { GameState } from '../core/GameState';
import type { PbrMaps } from '../core/Assets';
import { bus } from '../core/EventBus';

export interface LevelTextures {
  floor: PbrMaps;
  wall: PbrMaps;
  crate: PbrMaps;
}

const ROOM_HALF = 13; // 26 m × 26 m arena
const WALL_H = 3.6;
const WALL_T = 0.3;
const CRATE_HALF = 0.45;

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
// Separate non-uniform scale temp for the stair steps below — keeps the
// shared _s (used everywhere else as a fixed identity scale) untouched.
const _s2 = new Vector3();

function pbrMaterial(maps: PbrMaps, tint = 0xffffff): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    color: tint,
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    aoMap: maps.aoMap,
    roughness: 1,
    metalness: 0.0,
  });
  mat.aoMapIntensity = 1.0;
  return mat;
}

/** Grey-box arena: PBR floor/walls, four pillars, static crate clusters
 *  (instanced), six dynamic crates (instanced, driven by physics), a raised
 *  combat platform with stepped stairs, two angled mid-field cover walls,
 *  amber emissive strips + one red objective panel for the selective bloom
 *  pass. Also writes collider specs into GameState.level for the physics
 *  system. */
export function buildGreyBoxRoom(
  scene: Scene,
  tex: LevelTextures,
  state: GameState,
): void {
  const csmMaterials: Material[] = [];
  const bloomMeshes: Mesh[] = [];

  // ---- Floor ----
  const floorMat = pbrMaterial(tex.floor);
  const floor = new Mesh(new BoxGeometry(ROOM_HALF * 2, 0.2, ROOM_HALF * 2), floorMat);
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  scene.add(floor);
  csmMaterials.push(floorMat);
  state.level.staticColliders.push({
    x: 0, y: -0.1, z: 0, hx: ROOM_HALF, hy: 0.1, hz: ROOM_HALF, rotY: 0,
  });

  // ---- Walls (4 instances of one box) ----
  // Tinted down: bare white plaster + direct sun pushes past 1.0 in HDR and
  // ACES flattens it to a blank card — the tint keeps albedo texture legible.
  const wallMat = pbrMaterial(tex.wall, 0xcfccc2);
  const wallGeo = new BoxGeometry(ROOM_HALF * 2 + WALL_T * 2, WALL_H, WALL_T);
  const walls = new InstancedMesh(wallGeo, wallMat, 4);
  const wallDefs: { x: number; z: number; rotY: number }[] = [
    { x: 0, z: -ROOM_HALF - WALL_T / 2, rotY: 0 },
    { x: 0, z: ROOM_HALF + WALL_T / 2, rotY: 0 },
    { x: -ROOM_HALF - WALL_T / 2, z: 0, rotY: Math.PI / 2 },
    { x: ROOM_HALF + WALL_T / 2, z: 0, rotY: Math.PI / 2 },
  ];
  wallDefs.forEach((w, i) => {
    _q.setFromAxisAngle(new Vector3(0, 1, 0), w.rotY);
    _m.compose(_p.set(w.x, WALL_H / 2, w.z), _q, _s);
    walls.setMatrixAt(i, _m);
    // Wall rotation is already encoded by swapping the half-extents, so the
    // collider itself stays axis-aligned (rotY 0).
    const hx = w.rotY === 0 ? ROOM_HALF + WALL_T : WALL_T / 2;
    const hz = w.rotY === 0 ? WALL_T / 2 : ROOM_HALF + WALL_T;
    state.level.staticColliders.push({
      x: w.x, y: WALL_H / 2, z: w.z, hx, hy: WALL_H / 2, hz, rotY: 0,
    });
  });
  walls.castShadow = true;
  walls.receiveShadow = true;
  scene.add(walls);
  csmMaterials.push(wallMat);

  // ---- Pillars (4 instances) ----
  const pillarGeo = new BoxGeometry(0.7, WALL_H, 0.7);
  const pillars = new InstancedMesh(pillarGeo, wallMat, 4);
  const pillarPos: [number, number][] = [
    [-6, -6],
    [6, -6],
    [-6, 6],
    [6, 6],
  ];
  pillarPos.forEach(([x, z], i) => {
    _q.identity();
    _m.compose(_p.set(x, WALL_H / 2, z), _q, _s);
    pillars.setMatrixAt(i, _m);
    state.level.staticColliders.push({
      x, y: WALL_H / 2, z, hx: 0.35, hy: WALL_H / 2, hz: 0.35, rotY: 0,
    });
  });
  pillars.castShadow = true;
  pillars.receiveShadow = true;
  scene.add(pillars);

  // ---- Static crate clusters (instanced) ----
  const crateMat = pbrMaterial(tex.crate);
  crateMat.normalScale.set(1.35, 1.35); // planks must visibly groove in sun
  const crateGeo = new BoxGeometry(CRATE_HALF * 2, CRATE_HALF * 2, CRATE_HALF * 2);
  // Stacked crates sit 4mm proud of the ones below — exactly-coplanar faces
  // produce silhouette notches where rotated corners interpenetrate.
  const STACK_LIFT = 0.004;
  const staticDefs: { x: number; y: number; z: number; rotY: number }[] = [
    // cover cluster A (stack of 3 + 1)
    { x: -2.2, y: CRATE_HALF, z: -1.8, rotY: 0.1 },
    { x: -1.25, y: CRATE_HALF, z: -1.95, rotY: -0.15 },
    { x: -1.7, y: CRATE_HALF * 3 + STACK_LIFT, z: -1.85, rotY: 0.35 },
    { x: -2.3, y: CRATE_HALF, z: -0.85, rotY: 0.55 },
    // cover cluster B (L-shape)
    { x: 3.4, y: CRATE_HALF, z: 2.6, rotY: -0.2 },
    { x: 4.35, y: CRATE_HALF, z: 2.5, rotY: 0.08 },
    { x: 3.5, y: CRATE_HALF, z: 3.55, rotY: 0.3 },
    { x: 3.45, y: CRATE_HALF * 3 + STACK_LIFT, z: 2.55, rotY: -0.4 },
    // scatter near pillars
    { x: -5.6, y: CRATE_HALF, z: 5.1, rotY: 0.7 },
    { x: 5.9, y: CRATE_HALF, z: -5.2, rotY: -0.6 },
    { x: 6.6, y: CRATE_HALF, z: -4.6, rotY: 0.2 },
    { x: -6.4, y: CRATE_HALF, z: -5.5, rotY: 1.1 },
  ];
  const staticCrates = new InstancedMesh(crateGeo, crateMat, staticDefs.length);
  staticDefs.forEach((d, i) => {
    _q.setFromAxisAngle(new Vector3(0, 1, 0), d.rotY);
    _m.compose(_p.set(d.x, d.y, d.z), _q, _s);
    staticCrates.setMatrixAt(i, _m);
    state.level.staticColliders.push({
      x: d.x, y: d.y, z: d.z,
      hx: CRATE_HALF, hy: CRATE_HALF, hz: CRATE_HALF,
      rotY: d.rotY,
    });
  });
  staticCrates.castShadow = true;
  staticCrates.receiveShadow = true;
  scene.add(staticCrates);
  csmMaterials.push(crateMat);

  // ---- Dynamic crates (physics-driven, interpolated) ----
  const dynamicSpawns: { x: number; y: number; z: number }[] = [
    { x: 0.3, y: 2.2, z: 0.2 },
    { x: 0.1, y: 3.4, z: -0.1 },
    { x: -0.25, y: 4.6, z: 0.15 },
    { x: 1.6, y: 2.8, z: -1.2 },
    { x: -1.4, y: 3.2, z: 1.3 },
    { x: 0.9, y: 5.2, z: 0.9 },
  ];
  for (const s of dynamicSpawns) {
    state.level.dynamicBoxes.push({ ...s, half: CRATE_HALF });
  }
  const dynamicCrates = new InstancedMesh(crateGeo, crateMat, dynamicSpawns.length);
  dynamicCrates.castShadow = true;
  dynamicCrates.receiveShadow = true;
  // Instance matrices are rewritten every frame, but three computes an
  // InstancedMesh bounding sphere ONCE — a stale spawn-cluster sphere would
  // frustum-cull the whole mesh (and its shadows) after the crates move.
  // Six boxes in a small arena: culling buys nothing, disable it.
  dynamicCrates.frustumCulled = false;
  dynamicCrates.instanceMatrix.setUsage(DynamicDrawUsage);
  scene.add(dynamicCrates);

  // ---- Combat platform (NE quadrant): raised hold point ----
  // Reachable by two stepped stairs. There are no sloped colliders in the
  // schema, so stairs ARE the ramp — the character controller autosteps up
  // to 0.35 m, so every riser here is capped at 0.30 m to stay inside that
  // budget. Ranged cats can still hit a player camping the top (line of
  // sight isn't blocked from range), so holding it is a punishable choice,
  // not a free win.
  const PLATFORM_CX = 8.3;
  const PLATFORM_CZ = -8.3;
  const PLATFORM_TOP = 1.2;
  // 3 m × 3 m top. Centred to stay clear of the (6,-6) pillar + its crate
  // scatter (gap ≥0.45 m) and ≥1.2 m inside the 11-11.5 spawn ring on both
  // axes (checked against the platform's own extents, the widest new shape).
  const PLATFORM_HALF = 1.5;
  const platform = new Mesh(
    new BoxGeometry(PLATFORM_HALF * 2, 0.3, PLATFORM_HALF * 2),
    wallMat, // reuse arena PBR material — no new texture
  );
  platform.position.set(PLATFORM_CX, PLATFORM_TOP - 0.15, PLATFORM_CZ);
  platform.castShadow = true;
  platform.receiveShadow = true;
  scene.add(platform);
  state.level.staticColliders.push({
    x: PLATFORM_CX, y: PLATFORM_TOP - 0.15, z: PLATFORM_CZ,
    hx: PLATFORM_HALF, hy: 0.15, hz: PLATFORM_HALF, rotY: 0,
  });

  // Stairs: 3 risers per face (0.9 / 0.6 / 0.3 m tall), landing on the
  // platform's own 0.3 m top riser (0.9 → 1.2 m) — every step is 0.3 m, so
  // the autostep controller climbs the whole flight without a jump. South
  // face (open field/spawn side) and west face (away from the SW pillar +
  // crate cluster) so both approaches stay clear of existing geometry.
  const STEP_RISE = 0.3;
  const STEP_RUN = 0.4;
  const STEP_HALF_WIDTH = 0.8; // 1.6 m wide flight, centred on the face
  const stepDefs: { x: number; z: number; hx: number; hz: number; h: number }[] = [];
  const southFaceZ = PLATFORM_CZ + PLATFORM_HALF; // -6.8, opens toward +z
  for (let i = 0; i < 3; i++) {
    const near = southFaceZ + i * STEP_RUN;
    stepDefs.push({
      x: PLATFORM_CX, z: near + STEP_RUN / 2,
      hx: STEP_HALF_WIDTH, hz: STEP_RUN / 2, h: STEP_RISE * (3 - i),
    });
  }
  const westFaceX = PLATFORM_CX - PLATFORM_HALF; // 6.8, opens toward -x
  for (let i = 0; i < 3; i++) {
    const near = westFaceX - i * STEP_RUN;
    stepDefs.push({
      x: near - STEP_RUN / 2, z: PLATFORM_CZ,
      hx: STEP_RUN / 2, hz: STEP_HALF_WIDTH, h: STEP_RISE * (3 - i),
    });
  }
  const stepGeo = new BoxGeometry(1, 1, 1); // unit box, scaled per instance
  const steps = new InstancedMesh(stepGeo, wallMat, stepDefs.length);
  stepDefs.forEach((d, i) => {
    _q.identity();
    _s2.set(d.hx * 2, d.h, d.hz * 2);
    _m.compose(_p.set(d.x, d.h / 2, d.z), _q, _s2);
    steps.setMatrixAt(i, _m);
    state.level.staticColliders.push({
      x: d.x, y: d.h / 2, z: d.z, hx: d.hx, hy: d.h / 2, hz: d.hz, rotY: 0,
    });
  });
  steps.castShadow = true;
  steps.receiveShadow = true;
  scene.add(steps);

  // ---- Mid-field cover walls ----
  // Waist-high (top 1.1 m > 1.0 m), so they block enemy line-of-sight per
  // the AI contract while a standing player (eye 1.62 m) still shoots over
  // the top and a crouched player can peek-and-hide behind them. Both sit
  // outside the centre 4 m circle, off the spawn sightline (2.5,9.5)→(0,0)
  // — which never leaves x∈[0,2.5], z∈[0,9.5] — and well inside the spawn
  // ring, so neither wall can obstruct a spawn point or the opening view.
  const COVER_LEN = 2.4;
  const COVER_H = 1.1;
  const COVER_T = 0.3;
  const coverDefs: { x: number; z: number; rotY: number }[] = [
    { x: -4.5, z: 4.0, rotY: 0.5 },
    { x: 4.0, z: -2.0, rotY: -0.35 },
  ];
  const coverGeo = new BoxGeometry(COVER_LEN, COVER_H, COVER_T);
  const coverWalls = new InstancedMesh(coverGeo, wallMat, coverDefs.length);
  coverDefs.forEach((d, i) => {
    _q.setFromAxisAngle(new Vector3(0, 1, 0), d.rotY);
    _m.compose(_p.set(d.x, COVER_H / 2, d.z), _q, _s);
    coverWalls.setMatrixAt(i, _m);
    state.level.staticColliders.push({
      x: d.x, y: COVER_H / 2, z: d.z,
      hx: COVER_LEN / 2, hy: COVER_H / 2, hz: COVER_T / 2, rotY: d.rotY,
    });
  });
  coverWalls.castShadow = true;
  coverWalls.receiveShadow = true;
  scene.add(coverWalls);

  // ---- Emissive accents (selective bloom targets) ----
  // Amber strips on the inner faces of the four pillars.
  const stripGeo = new BoxGeometry(0.1, 1.4, 0.04);
  const stripMat = new MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xffb02e,
    emissiveIntensity: 3.2, // 4.5 nuked local exposure at close range
    roughness: 1,
  });
  const strips = new InstancedMesh(stripGeo, stripMat, 4);
  pillarPos.forEach(([x, z], i) => {
    // Mount flush on the pillar face that looks toward the room centre
    // along X: offset on ONE axis only (pillar half 0.35 + strip half
    // thickness 0.02 = 0.37), and rotate the strip's thin axis to match.
    const ox = x > 0 ? -0.37 : 0.37;
    _q.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    _m.compose(_p.set(x + ox, 1.6, z), _q, _s);
    strips.setMatrixAt(i, _m);
    // Each strip spills warm light onto its pillar and the nearby floor —
    // an emissive that illuminates nothing reads as a sticker, not a light.
    const spill = new PointLight(0xffb02e, 4.5, 6, 2);
    spill.position.set(x + ox * 2.2, 1.6, z);
    scene.add(spill);
  });
  scene.add(strips);
  bloomMeshes.push(strips);

  // Platform edge trim — same amber emissive material as the pillar strips,
  // mounted just under the top lip of the south (field-facing) approach so
  // the platform reads as a marked hold point from across the arena. Sits
  // flush against geometry the platform slab collider already covers, so
  // it needs no collider of its own (same pattern as the strips above).
  const platformStrip = new Mesh(new BoxGeometry(2.6, 0.1, 0.05), stripMat);
  platformStrip.position.set(PLATFORM_CX, 1.15, southFaceZ + 0.025);
  scene.add(platformStrip);
  bloomMeshes.push(platformStrip);

  // Red signal panel on the north wall — framed in a dark bezel and flush
  // to the wall so it reads as installed signage, not a floating glitch quad.
  const wallInnerZ = -ROOM_HALF; // inner face of the north wall
  const frameMat = new MeshStandardMaterial({
    color: 0x17181c,
    roughness: 0.55,
    metalness: 0.6,
  });
  const frame = new Mesh(new BoxGeometry(1.34, 0.68, 0.06), frameMat);
  frame.position.set(0, 2.1, wallInnerZ + 0.03);
  frame.castShadow = true;
  scene.add(frame);
  const panelMat = new MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xff2210,
    emissiveIntensity: 3.0,
    roughness: 1,
  });
  const panel = new Mesh(new BoxGeometry(1.2, 0.55, 0.04), panelMat);
  panel.position.set(0, 2.1, wallInnerZ + 0.055);
  scene.add(panel);
  bloomMeshes.push(panel);

  bus.emit('level:built', { csmMaterials, bloomMeshes, dynamicCrateMesh: dynamicCrates });
}
