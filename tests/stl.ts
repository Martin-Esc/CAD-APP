import { checkMesh, type MeshCheck } from '../src/geometry/MeshBuilder';
import type { MeshBuilder } from '../src/geometry/MeshBuilder';
import * as THREE from 'three';

/**
 * Topology after an STL round trip: coordinates rounded to float32 and
 * vertices welded where they are exactly equal, as STL readers and slicers
 * do. A mesh that passes is read back as the same closed solid.
 */
export function closedAfterStl(mb: MeshBuilder): MeshCheck {
  const f = new Float32Array(mb.positions);
  const ids = new Map<string, number>();
  const remap: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < f.length / 3; i++) {
    const key = `${f[i * 3]},${f[i * 3 + 1]},${f[i * 3 + 2]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      ids.set(key, id);
      positions.push(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
    }
    remap.push(id);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(mb.indices.map((i) => remap[i]));
  return checkMesh(g);
}
