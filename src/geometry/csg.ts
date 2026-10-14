import * as THREE from 'three';
import Module from 'manifold-3d';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { MeshBuilder } from './MeshBuilder';

/**
 * Solid modelling (boolean union / difference) backed by manifold-3d, a
 * robust WASM mesh-boolean kernel. Inputs must be closed, consistently wound
 * meshes – every generator in this project produces those.
 *
 * Every function here is async because the WASM module loads on first use.
 */

let kernel: Promise<ManifoldToplevel> | null = null;

export function loadKernel(): Promise<ManifoldToplevel> {
  if (!kernel) {
    kernel = (async () => {
      let wasm: ManifoldToplevel;
      if (typeof document !== 'undefined') {
        // In the browser, let Vite serve the .wasm file. Node (tests) resolves it next to manifold.js.
        const wasmUrl = (await import('manifold-3d/manifold.wasm?url')).default;
        wasm = await Module({ locateFile: () => wasmUrl });
      } else {
        wasm = await Module();
      }
      wasm.setup();
      return wasm;
    })();
  }
  return kernel;
}

/** Geometric tolerance for post-boolean cleanup (mm). Far below milling / printing accuracy. */
const SIMPLIFY_TOLERANCE = 2e-4;

export type SolidInput = MeshBuilder | THREE.BufferGeometry;

function toArrays(input: SolidInput): { positions: Float32Array; indices: Uint32Array } {
  if (input instanceof MeshBuilder) {
    return { positions: new Float32Array(input.positions), indices: new Uint32Array(input.indices) };
  }
  const pos = input.getAttribute('position');
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i);
    positions[i * 3 + 1] = pos.getY(i);
    positions[i * 3 + 2] = pos.getZ(i);
  }
  const index = input.getIndex();
  const indices = index ? new Uint32Array(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { positions, indices };
}

function toManifold(wasm: ManifoldToplevel, input: SolidInput): Manifold {
  const { positions, indices } = toArrays(input);
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices });
  // weld coincident vertices (e.g. the seams of non-indexed STL input)
  mesh.merge();
  const solid = new wasm.Manifold(mesh);
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new Error(`Mesh is not a closed solid (${status})`);
  }
  return solid;
}

function fromManifold(solid: Manifold): MeshBuilder {
  const mesh = solid.getMesh();
  const mb = new MeshBuilder();
  const np = mesh.numProp;
  for (let i = 0; i < mesh.vertProperties.length; i += np) {
    mb.addVertex(mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]);
  }
  for (let i = 0; i < mesh.triVerts.length; i++) mb.indices.push(mesh.triVerts[i]);
  return mb;
}

/** Run `fn` with manifolds created from the inputs, freeing all WASM memory afterwards. */
async function withSolids(groups: SolidInput[][], fn: (wasm: ManifoldToplevel, solids: Manifold[][]) => Manifold): Promise<MeshBuilder> {
  const wasm = await loadKernel();
  const created: Manifold[] = [];
  try {
    const solids = groups.map((g) =>
      g.map((input) => {
        const m = toManifold(wasm, input);
        created.push(m);
        return m;
      }),
    );
    const raw = fn(wasm, solids);
    created.push(raw);
    // Collapse sliver triangles / near-duplicate vertices (< 1 µm·10) that
    // booleans leave at intersections; they would weld into non-manifold
    // edges once coordinates are rounded to float32 in the STL.
    const result = raw.simplify(SIMPLIFY_TOLERANCE);
    created.push(result);
    return fromManifold(result);
  } finally {
    for (const m of created) m.delete();
  }
}

/** Union of several closed solids into one. */
export function union(parts: SolidInput[]): Promise<MeshBuilder> {
  if (!parts.length) throw new Error('Nothing to merge');
  return withSolids([parts], (wasm, [solids]) => wasm.Manifold.union(solids));
}

/** `base` minus the union of `tools`. */
export function subtract(base: SolidInput[], tools: SolidInput[]): Promise<MeshBuilder> {
  return withSolids([base, tools], (wasm, [b, t]) => {
    const solid = wasm.Manifold.union(b);
    if (!t.length) return solid;
    const cutter = wasm.Manifold.union(t);
    const out = solid.subtract(cutter);
    solid.delete();
    cutter.delete();
    return out;
  });
}

/** Bake a mesh's world transform into a copy of its geometry. */
export function worldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  mesh.updateMatrixWorld(true);
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  const index = g.getIndex();
  if (index && mesh.matrixWorld.determinant() < 0) {
    // a mirroring transform turns the mesh inside out – restore outward winding
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
  }
  return g;
}
