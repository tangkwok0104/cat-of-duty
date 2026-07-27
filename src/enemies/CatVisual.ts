import {
  CapsuleGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  BoxGeometry,
} from 'three';

const FUR_COLORS = [0x8a8378, 0xb08d57, 0x5c5650, 0xc9924f, 0x9b8f9d];

export interface CatVisual {
  group: Group;
  furMats: MeshStandardMaterial[];
  eyeMat: MeshStandardMaterial;
}

/** Placeholder tactical cat: capsule torso, ball head, cone ears, box tail.
 *  Must read as "cat-shaped thing" at 20m — ears and tail do that work.
 *  Replaced by a rigged Quaternius model the moment /assets has one. */
export function buildCatVisual(id: number): CatVisual {
  const fur = new MeshStandardMaterial({
    color: FUR_COLORS[id % FUR_COLORS.length],
    roughness: 0.9,
    metalness: 0,
  });
  const furDark = new MeshStandardMaterial({
    color: 0x3d3a35,
    roughness: 0.9,
    metalness: 0,
  });
  const eyeMat = new MeshStandardMaterial({
    color: 0x000000,
    emissive: 0x9ee493,
    emissiveIntensity: 2.5,
    roughness: 1,
  });

  const group = new Group();

  const torso = new Mesh(new CapsuleGeometry(0.22, 0.44, 6, 12), fur);
  torso.position.y = 0.44;
  torso.castShadow = true;

  const head = new Mesh(new SphereGeometry(0.16, 12, 10), fur);
  head.position.y = 0.95;
  head.castShadow = true;

  const earL = new Mesh(new ConeGeometry(0.055, 0.12, 4), furDark);
  earL.position.set(-0.08, 1.1, 0);
  const earR = new Mesh(new ConeGeometry(0.055, 0.12, 4), furDark);
  earR.position.set(0.08, 1.1, 0);

  const eyeL = new Mesh(new SphereGeometry(0.024, 6, 6), eyeMat);
  eyeL.position.set(-0.055, 0.97, -0.13);
  const eyeR = new Mesh(new SphereGeometry(0.024, 6, 6), eyeMat);
  eyeR.position.set(0.055, 0.97, -0.13);

  const tail = new Mesh(new BoxGeometry(0.05, 0.05, 0.34), furDark);
  tail.position.set(0, 0.5, 0.32);
  tail.rotation.x = -0.5;

  // Tactical detail: a vest band that fully wraps the torso capsule
  // (diameter 0.44) — an undersized box z-fights through the fur as
  // broken dark patches.
  const vest = new Mesh(new BoxGeometry(0.5, 0.15, 0.5), furDark);
  vest.position.y = 0.48;

  group.add(torso, head, earL, earR, eyeL, eyeR, tail, vest);
  return { group, furMats: [fur, furDark], eyeMat };
}
