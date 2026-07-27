import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
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

function pbrMaterial(maps: PbrMaps, roughnessBias = 0): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    aoMap: maps.aoMap,
    roughness: 1 - roughnessBias,
    metalness: 0.0,
  });
  mat.aoMapIntensity = 1.0;
  return mat;
}

/** Grey-box arena: PBR floor/walls, four pillars, static crate clusters
 *  (instanced), six dynamic crates (instanced, driven by physics), amber
 *  emissive strips + one red objective panel for the selective bloom pass.
 *  Also writes collider specs into GameState.level for the physics system. */
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
  state.level.staticColliders.push({ x: 0, y: -0.1, z: 0, hx: ROOM_HALF, hy: 0.1, hz: ROOM_HALF });

  // ---- Walls (4 instances of one box) ----
  const wallMat = pbrMaterial(tex.wall);
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
    const hx = w.rotY === 0 ? ROOM_HALF + WALL_T : WALL_T / 2;
    const hz = w.rotY === 0 ? WALL_T / 2 : ROOM_HALF + WALL_T;
    state.level.staticColliders.push({ x: w.x, y: WALL_H / 2, z: w.z, hx, hy: WALL_H / 2, hz });
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
    state.level.staticColliders.push({ x, y: WALL_H / 2, z, hx: 0.35, hy: WALL_H / 2, hz: 0.35 });
  });
  pillars.castShadow = true;
  pillars.receiveShadow = true;
  scene.add(pillars);

  // ---- Static crate clusters (instanced) ----
  const crateMat = pbrMaterial(tex.crate);
  const crateGeo = new BoxGeometry(CRATE_HALF * 2, CRATE_HALF * 2, CRATE_HALF * 2);
  const staticDefs: { x: number; y: number; z: number; rotY: number }[] = [
    // cover cluster A (stack of 3 + 1)
    { x: -2.2, y: CRATE_HALF, z: -1.8, rotY: 0.1 },
    { x: -1.25, y: CRATE_HALF, z: -1.95, rotY: -0.15 },
    { x: -1.7, y: CRATE_HALF * 3, z: -1.85, rotY: 0.35 },
    { x: -2.3, y: CRATE_HALF, z: -0.85, rotY: 0.55 },
    // cover cluster B (L-shape)
    { x: 3.4, y: CRATE_HALF, z: 2.6, rotY: -0.2 },
    { x: 4.35, y: CRATE_HALF, z: 2.5, rotY: 0.08 },
    { x: 3.5, y: CRATE_HALF, z: 3.55, rotY: 0.3 },
    { x: 3.45, y: CRATE_HALF * 3, z: 2.55, rotY: -0.4 },
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
      x: d.x, y: d.y, z: d.z, hx: CRATE_HALF, hy: CRATE_HALF, hz: CRATE_HALF,
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
  scene.add(dynamicCrates);

  // ---- Emissive accents (selective bloom targets) ----
  // Amber strips on the inner faces of the four pillars.
  const stripGeo = new BoxGeometry(0.1, 1.4, 0.04);
  const stripMat = new MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xffb02e,
    emissiveIntensity: 4.5,
    roughness: 1,
  });
  const strips = new InstancedMesh(stripGeo, stripMat, 4);
  pillarPos.forEach(([x, z], i) => {
    // Offset toward room centre, on the pillar face.
    const ox = x > 0 ? -0.38 : 0.38;
    const oz = z > 0 ? -0.38 : 0.38;
    _q.setFromAxisAngle(new Vector3(0, 1, 0), Math.abs(x) > Math.abs(z) ? Math.PI / 2 : 0);
    _m.compose(_p.set(x + ox, 1.6, z + oz), _q, _s);
    strips.setMatrixAt(i, _m);
  });
  scene.add(strips);
  bloomMeshes.push(strips);

  // Red objective panel on the north wall.
  const panelMat = new MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xff2210,
    emissiveIntensity: 3.0,
    roughness: 1,
  });
  const panel = new Mesh(new BoxGeometry(1.2, 0.55, 0.05), panelMat);
  panel.position.set(0, 2.1, -ROOM_HALF - WALL_T / 2 + 0.2);
  scene.add(panel);
  bloomMeshes.push(panel);

  bus.emit('level:built', { csmMaterials, bloomMeshes, dynamicCrateMesh: dynamicCrates });
}
