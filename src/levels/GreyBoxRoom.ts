import {
  BoxGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Scene,
  type Material,
} from 'three';
import type { GameState } from '../core/GameState';
import type { PbrMaps } from '../core/Assets';
import { loadModel } from '../core/Assets';
import { bus } from '../core/EventBus';

export interface LevelTextures {
  floor: PbrMaps;
  wall: PbrMaps;
  crate: PbrMaps;
}

const ROOM_HALF = 19; // 38 m × 38 m arena (was 26 m × 26 m — playtest: too small)
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

  // ---- Outer-ring pillar blocks (arena expansion 26m→38m) ----
  // Same geometry/material as the corner pillars above, reused via a
  // SEPARATE InstancedMesh rather than appending to `pillarPos` — that
  // array (and its length) is shared with the amber strip-lighting loop
  // below, which is hard-sized to 4 instances; extending it would silently
  // overrun the strips InstancedMesh's fixed instance count. These fill the
  // new moat between the old 13 m walls and the new 19 m walls, laterally
  // (east/west) where the diagonal cover walls below don't reach. Checked
  // clear of every spawn point (SPAWN_POINTS, CatSystem.ts) and every
  // frozen weapon/station/player-spawn coordinate by >=7 m.
  const outerPillarPos: [number, number][] = [
    [14.5, 2.5],
    [-14.7, -2.2],
  ];
  const outerPillars = new InstancedMesh(pillarGeo, wallMat, outerPillarPos.length);
  outerPillarPos.forEach(([x, z], i) => {
    _q.identity();
    _m.compose(_p.set(x, WALL_H / 2, z), _q, _s);
    outerPillars.setMatrixAt(i, _m);
    state.level.staticColliders.push({
      x, y: WALL_H / 2, z, hx: 0.35, hy: WALL_H / 2, hz: 0.35, rotY: 0,
    });
  });
  outerPillars.castShadow = true;
  outerPillars.receiveShadow = true;
  scene.add(outerPillars);

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
    // outer-ring cluster N (arena expansion): breaks sightline for cats
    // stepping off the north spawn points (0,-17.5)/(±17,-17), >=4 m clear
    // of all three.
    { x: 2.5, y: CRATE_HALF, z: -14.3, rotY: 0.2 },
    { x: 3.5, y: CRATE_HALF, z: -14.15, rotY: -0.25 },
    { x: 3.0, y: CRATE_HALF * 3 + STACK_LIFT, z: -14.25, rotY: 0.4 },
    // outer-ring cluster S: mirrors cluster N for the south spawn points
    // (0,17.5)/(±17,17).
    { x: -2.5, y: CRATE_HALF, z: 14.3, rotY: -0.2 },
    { x: -3.5, y: CRATE_HALF, z: 14.15, rotY: 0.25 },
    { x: -3.0, y: CRATE_HALF * 3 + STACK_LIFT, z: 14.25, rotY: -0.4 },
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
  // scatter (gap ≥0.45 m) and well inside the 17-17.5 spawn ring on both
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
    // Original mid-field pair (unchanged) — see comment above.
    { x: -4.5, z: 4.0, rotY: 0.5 },
    { x: 4.0, z: -2.0, rotY: -0.35 },
    // Outer-ring set (arena expansion 26m→38m): fills the moat between the
    // old 13 m walls and the new 19 m walls, one per quadrant, so it isn't
    // a barren gap and cats stepping off the spawn ring get somewhere to
    // break sightline immediately. Each keeps >=7 m clearance from every
    // SPAWN_POINTS entry (CatSystem.ts) and from the frozen weapon/station/
    // player-spawn coordinates.
    { x: -13.8, z: -10.2, rotY: 0.45 },
    { x: 13.6, z: -9.6, rotY: -0.4 },
    { x: -13.2, z: 10.8, rotY: 0.3 },
    { x: 13.4, z: 10.3, rotY: -0.35 },
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

  // ---- Wall posters (textured planes, flush-mounted) ----
  // Source art is 665×1024 px — use its real pixel aspect so the print
  // isn't stretched. East wall poster sits near the player spawn (2.5, 0.9,
  // 9.5) so it's the first thing visible turning right out of spawn; west
  // wall gets the companion poster on the opposite side of the arena.
  const POSTER_H = 1.4;
  const POSTER_ASPECT = 665 / 1024;
  const POSTER_W = POSTER_H * POSTER_ASPECT;
  const POSTER_Y = 1.75; // eye-height-ish, matches the pillar strip/red panel band
  const FRAME_MARGIN = 0.08;
  const posterTexLoader = new TextureLoader();

  /** Flush-mount a framed poster on a wall. (normalX, normalZ) is the unit
   *  direction the art faces (into the room); rotY must rotate the plane's
   *  default +Z-facing normal to match it. No collider — flush geometry. */
  function mountPoster(
    url: string,
    x: number,
    y: number,
    z: number,
    rotY: number,
    normalX: number,
    normalZ: number,
  ): void {
    const frameMat = new MeshStandardMaterial({
      color: 0x18160f,
      roughness: 0.85,
      metalness: 0.05,
    });
    const frame = new Mesh(
      new BoxGeometry(POSTER_W + FRAME_MARGIN * 2, POSTER_H + FRAME_MARGIN * 2, 0.04),
      frameMat,
    );
    // Own Quaternion, NOT the shared `_q` temp: the texture callback below
    // fires asynchronously, by which point a second mountPoster() call would
    // have already overwritten `_q` with ITS rotation — silently rotating
    // this poster's plane to face the wrong way (culled, so the plane
    // effectively vanishes and only the frame box shows).
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rotY);
    frame.position.set(x, y, z);
    frame.quaternion.copy(q);
    frame.castShadow = true;
    frame.receiveShadow = true;
    scene.add(frame);

    // Poster art loads independently of the level build — placeholder is
    // just the dark frame until the texture resolves.
    posterTexLoader.load(url, (tex) => {
      tex.colorSpace = SRGBColorSpace;
      const mat = new MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
      const plane = new Mesh(new PlaneGeometry(POSTER_W, POSTER_H), mat);
      // 0.025 proud of the frame's front face (half-thickness 0.02) — clears
      // z-fighting without a visible air gap.
      plane.position.set(x + normalX * 0.025, y, z + normalZ * 0.025);
      plane.quaternion.copy(q);
      scene.add(plane);
    });
  }

  mountPoster(
    '/assets/gen/posters/enlist-meow.png',
    ROOM_HALF - 0.03, POSTER_Y, 7,
    -Math.PI / 2, -1, 0, // east wall, facing -X into the room
  );
  mountPoster(
    '/assets/gen/posters/loose-whiskers.png',
    -ROOM_HALF + 0.03, POSTER_Y, -3,
    Math.PI / 2, 1, 0, // west wall, facing +X into the room
  );

  // ---- Sandbag cover stacks (GLB, lazy-loaded) ----
  // Bbox inspection (.tmp/gen/prop-bbox.ts): local bounds roughly
  // x[-0.949,0.948] y[-0.879,0.873] z[-0.791,0.786], near-cubic. Scale 0.84
  // → ~1.6 m wide stack per the inspection brief. Collider top is pinned to
  // 1.1 m — NOT the mesh's true scaled height (~1.47 m) — to match
  // hasLineOfSight's LOS_MIN_TOP_Y=1.0 contract (see CatProjectiles.ts) and
  // the mid-field cover walls' own top-1.1 convention above: the visual
  // stack reads taller than the physical cover box, same trade every prefab
  // cover asset in the file makes once the mesh isn't custom-built to spec.
  const SANDBAG_SCALE = 0.84;
  const SANDBAG_MIN_Y = -0.879;
  const SANDBAG_HALF_X = 0.949;
  const SANDBAG_HALF_Z = 0.789;
  const SANDBAG_COVER_TOP = 1.1;
  const sandbagDefs: { x: number; z: number; rotY: number }[] = [
    { x: -8.5, z: 3.0, rotY: 0.35 }, // SW quadrant open ground
    { x: 9.0, z: -4.0, rotY: -0.2 }, // guards the platform's south stair approach
  ];
  for (const d of sandbagDefs) {
    state.level.staticColliders.push({
      x: d.x, y: SANDBAG_COVER_TOP / 2, z: d.z,
      hx: SANDBAG_HALF_X * SANDBAG_SCALE,
      hy: SANDBAG_COVER_TOP / 2,
      hz: SANDBAG_HALF_Z * SANDBAG_SCALE,
      rotY: d.rotY,
    });
  }
  loadModel('sandbags')
    .then((gltf) => {
      for (const d of sandbagDefs) {
        const inst = gltf.scene.clone(true);
        inst.traverse((obj) => {
          if (obj instanceof Mesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });
        inst.scale.setScalar(SANDBAG_SCALE);
        // -minY*scale lifts the mesh so its lowest vertex sits on y=0.
        inst.position.set(d.x, -SANDBAG_MIN_Y * SANDBAG_SCALE, d.z);
        inst.rotation.y = d.rotY;
        scene.add(inst);
      }
    })
    .catch((err: unknown) => {
      console.error('[GreyBoxRoom] failed to load sandbags.glb', err);
    });

  // ---- Ammo crate props (GLB, lazy-loaded) ----
  // Bbox inspection (.tmp/gen/prop-bbox.ts): local bounds roughly
  // x[-0.949,0.947] y[-0.558,0.555] z[-0.483,0.481]. Scale 0.47 → ~0.9 m
  // crate per the inspection brief. Collider matches the full scaled mesh
  // (unlike the sandbags, no LOS-height override needed — these are scatter
  // props, not cover).
  const CRATE_PROP_SCALE = 0.47;
  const CRATE_PROP_MIN_Y = -0.558;
  const CRATE_PROP_HALF_X = 0.948;
  const CRATE_PROP_HALF_Y = 0.556;
  const CRATE_PROP_HALF_Z = 0.482;
  const cratePropDefs: { x: number; z: number; rotY: number; groundY: number }[] = [
    { x: -3.3, z: -2.5, rotY: 0.4, groundY: 0 }, // scatter beside cover cluster A
    { x: 8.8, z: -8.6, rotY: -0.6, groundY: PLATFORM_TOP }, // reward prop on the platform
  ];
  for (const d of cratePropDefs) {
    state.level.staticColliders.push({
      x: d.x, y: d.groundY + CRATE_PROP_HALF_Y * CRATE_PROP_SCALE, z: d.z,
      hx: CRATE_PROP_HALF_X * CRATE_PROP_SCALE,
      hy: CRATE_PROP_HALF_Y * CRATE_PROP_SCALE,
      hz: CRATE_PROP_HALF_Z * CRATE_PROP_SCALE,
      rotY: d.rotY,
    });
  }
  loadModel('crate')
    .then((gltf) => {
      for (const d of cratePropDefs) {
        const inst = gltf.scene.clone(true);
        inst.traverse((obj) => {
          if (obj instanceof Mesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });
        inst.scale.setScalar(CRATE_PROP_SCALE);
        inst.position.set(d.x, d.groundY - CRATE_PROP_MIN_Y * CRATE_PROP_SCALE, d.z);
        inst.rotation.y = d.rotY;
        scene.add(inst);
      }
    })
    .catch((err: unknown) => {
      console.error('[GreyBoxRoom] failed to load crate.glb', err);
    });

  bus.emit('level:built', { csmMaterials, bloomMeshes, dynamicCrateMesh: dynamicCrates });
}
