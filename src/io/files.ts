import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Load an STL / PLY / OBJ scan into an indexed, welded geometry. */
export async function loadMeshFile(file: File): Promise<THREE.BufferGeometry> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  let geometry: THREE.BufferGeometry;
  if (ext === 'stl') {
    geometry = new STLLoader().parse(await file.arrayBuffer());
  } else if (ext === 'ply') {
    geometry = new PLYLoader().parse(await file.arrayBuffer());
  } else if (ext === 'obj') {
    const group = new OBJLoader().parse(await file.text());
    const parts: THREE.BufferGeometry[] = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const g = (o as THREE.Mesh).geometry.clone();
        g.deleteAttribute('uv');
        g.deleteAttribute('normal');
        parts.push(g);
      }
    });
    const merged = mergeGeometries(parts);
    if (!merged) throw new Error('OBJ contains no meshes');
    geometry = merged;
  } else {
    throw new Error(`Unsupported file type .${ext} (use STL, PLY or OBJ)`);
  }
  for (const name of Object.keys(geometry.attributes)) if (name !== 'position') geometry.deleteAttribute(name);
  const welded = mergeVertices(geometry, 1e-4);
  welded.computeVertexNormals();
  welded.computeBoundingBox();
  return welded;
}

/** Bake each mesh's world transform and merge into one binary STL. */
export function exportStl(meshes: THREE.Mesh[]): Blob {
  const group = new THREE.Group();
  for (const m of meshes) {
    m.updateMatrixWorld(true);
    const clone = new THREE.Mesh(m.geometry.clone().applyMatrix4(m.matrixWorld));
    group.add(clone);
  }
  const data = new STLExporter().parse(group, { binary: true }) as DataView;
  return new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
