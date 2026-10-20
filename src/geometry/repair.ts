import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Mesh repair tools in the spirit of Meshmixer's Inspector and Edit menu.
 * Every function takes an indexed BufferGeometry and returns a new one with
 * vertex normals; the input is not modified.
 */

interface Mesh {
  p: number[];
  f: number[];
}

function read(g: THREE.BufferGeometry): Mesh {
  const pos = g.getAttribute('position');
  const p: number[] = new Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p[i * 3] = pos.getX(i);
    p[i * 3 + 1] = pos.getY(i);
    p[i * 3 + 2] = pos.getZ(i);
  }
  const idx = g.getIndex();
  const f = idx ? Array.from(idx.array as ArrayLike<number>) : Array.from({ length: pos.count }, (_, i) => i);
  return { p, f };
}

function write(m: Mesh): THREE.BufferGeometry {
  // drop unreferenced vertices
  const used = new Int32Array(m.p.length / 3).fill(-1);
  const p: number[] = [];
  const f: number[] = [];
  for (const v of m.f) {
    if (used[v] < 0) {
      used[v] = p.length / 3;
      p.push(m.p[v * 3], m.p[v * 3 + 1], m.p[v * 3 + 2]);
    }
    f.push(used[v]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex(f);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const V = (m: Mesh, i: number) => new THREE.Vector3(m.p[i * 3], m.p[i * 3 + 1], m.p[i * 3 + 2]);

/** Directed boundary edges (a → b as used by their single face), chained into loops. */
function boundaryLoopsOf(m: Mesh): number[][] {
  const count = new Map<string, number>();
  for (let t = 0; t < m.f.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = m.f[t + k], b = m.f[t + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const next = new Map<number, number[]>();
  for (let t = 0; t < m.f.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = m.f[t + k], b = m.f[t + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (count.get(key) === 1) (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    }
  }
  const loops: number[][] = [];
  const usedEdge = new Set<string>();
  for (const [start, outs] of next) {
    for (const first of outs) {
      if (usedEdge.has(`${start}>${first}`)) continue;
      const loop = [start];
      usedEdge.add(`${start}>${first}`);
      let cur = first;
      let guard = 0;
      while (cur !== start && guard++ < 1e6) {
        loop.push(cur);
        const cands = (next.get(cur) ?? []).filter((n) => !usedEdge.has(`${cur}>${n}`));
        if (!cands.length) break;
        usedEdge.add(`${cur}>${cands[0]}`);
        cur = cands[0];
      }
      if (cur === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Face shells (connected components through shared edges). */
function shellsOf(m: Mesh): number[][] {
  const nf = m.f.length / 3;
  const parent = Int32Array.from({ length: nf }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const edgeFace = new Map<string, number>();
  for (let t = 0; t < nf; t++) {
    for (let k = 0; k < 3; k++) {
      const a = m.f[t * 3 + k], b = m.f[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const other = edgeFace.get(key);
      if (other === undefined) edgeFace.set(key, t);
      else parent[find(t)] = find(other);
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < nf; t++) (groups.get(find(t)) ?? groups.set(find(t), []).get(find(t))!).push(t);
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

export interface Inspection {
  triangles: number;
  vertices: number;
  /** open boundaries (holes), each as a loop of positions */
  holes: THREE.Vector3[][];
  /** perimeter of each hole (mm) */
  holePerimeters: number[];
  nonManifoldEdges: number;
  shells: number;
  /** triangle count of each shell, largest first */
  shellSizes: number[];
  degenerate: number;
  watertight: boolean;
}

export function inspect(g: THREE.BufferGeometry): Inspection {
  const m = read(g);
  const loops = boundaryLoopsOf(m);
  const count = new Map<string, number>();
  let degenerate = 0;
  for (let t = 0; t < m.f.length; t += 3) {
    const [a, b, c] = [m.f[t], m.f[t + 1], m.f[t + 2]];
    const area = V(m, b).sub(V(m, a)).cross(V(m, c).sub(V(m, a))).length() / 2;
    if (a === b || b === c || a === c || area < 1e-10) degenerate++;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let nonManifold = 0;
  for (const c of count.values()) if (c > 2) nonManifold++;
  const shells = shellsOf(m);
  const holes = loops.map((l) => l.map((v) => V(m, v)));
  return {
    triangles: m.f.length / 3,
    vertices: m.p.length / 3,
    holes,
    holePerimeters: holes.map((h) => h.reduce((s, p, i) => s + p.distanceTo(h[(i + 1) % h.length]), 0)),
    nonManifoldEdges: nonManifold,
    shells: shells.length,
    shellSizes: shells.map((s) => s.length),
    degenerate,
    watertight: loops.length === 0 && nonManifold === 0,
  };
}

/**
 * Fill open boundaries. Each hole is closed with concentric rings and a
 * centre fan, then the new vertices are relaxed (Laplacian) into a smooth
 * membrane that meets the surrounding surface. A planar hole (e.g. a plane
 * cut) stays planar.
 *
 * @param maxPerimeter  only holes up to this perimeter (mm) are filled
 */
export function fillHoles(
  g: THREE.BufferGeometry,
  maxPerimeter = Infinity,
  filter?: (loop: THREE.Vector3[]) => boolean,
): { geometry: THREE.BufferGeometry; filled: number } {
  const m = read(g);
  const loops = boundaryLoopsOf(m);
  let filled = 0;
  for (const loop of loops) {
    const pts = loop.map((v) => V(m, v));
    const perimeter = pts.reduce((s, p, i) => s + p.distanceTo(pts[(i + 1) % pts.length]), 0);
    if (perimeter > maxPerimeter || (filter && !filter(pts))) continue;
    filled++;
    const center = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const avgEdge = perimeter / pts.length;
    const radius = pts.reduce((s, p) => s + p.distanceTo(center), 0) / pts.length;
    const ringCount = THREE.MathUtils.clamp(Math.round(radius / avgEdge) - 1, 0, 40);
    const newIds: number[] = [];
    const neighbours = new Map<number, Set<number>>();
    const link = (a: number, b: number) => {
      (neighbours.get(a) ?? neighbours.set(a, new Set()).get(a)!).add(b);
      (neighbours.get(b) ?? neighbours.set(b, new Set()).get(b)!).add(a);
    };
    const addTri = (a: number, b: number, c: number) => {
      m.f.push(a, b, c);
      link(a, b);
      link(b, c);
      link(c, a);
    };
    let outer = loop;
    for (let r = 1; r <= ringCount; r++) {
      const t = r / (ringCount + 1);
      const ring = loop.map((v) => {
        const id = m.p.length / 3;
        const q = V(m, v).lerp(center, t);
        m.p.push(q.x, q.y, q.z);
        newIds.push(id);
        return id;
      });
      // boundary edges run a→b in the existing faces, so new faces use b→a
      for (let i = 0; i < loop.length; i++) {
        const j = (i + 1) % loop.length;
        addTri(outer[j], outer[i], ring[i]);
        addTri(outer[j], ring[i], ring[j]);
      }
      outer = ring;
    }
    const c = m.p.length / 3;
    m.p.push(center.x, center.y, center.z);
    newIds.push(c);
    for (let i = 0; i < outer.length; i++) addTri(c, outer[(i + 1) % outer.length], outer[i]);
    // relax the patch: boundary vertices stay fixed
    for (let it = 0; it < 60; it++) {
      for (const v of newIds) {
        const nb = neighbours.get(v);
        if (!nb || !nb.size) continue;
        let x = 0, y = 0, z = 0;
        for (const u of nb) {
          x += m.p[u * 3];
          y += m.p[u * 3 + 1];
          z += m.p[u * 3 + 2];
        }
        m.p[v * 3] += (x / nb.size - m.p[v * 3]) * 0.6;
        m.p[v * 3 + 1] += (y / nb.size - m.p[v * 3 + 1]) * 0.6;
        m.p[v * 3 + 2] += (z / nb.size - m.p[v * 3 + 2]) * 0.6;
      }
    }
  }
  return { geometry: write(m), filled };
}

/** Remove disconnected pieces smaller than `minFraction` of the largest piece (floating scan debris). */
export function removeSmallShells(g: THREE.BufferGeometry, minFraction = 0.05): { geometry: THREE.BufferGeometry; removed: number } {
  const m = read(g);
  const shells = shellsOf(m);
  if (shells.length <= 1) return { geometry: write(m), removed: 0 };
  const min = shells[0].length * minFraction;
  const keep = shells.filter((s) => s.length >= min);
  const f: number[] = [];
  for (const s of keep) for (const t of s) f.push(m.f[t * 3], m.f[t * 3 + 1], m.f[t * 3 + 2]);
  return { geometry: write({ p: m.p, f }), removed: shells.length - keep.length };
}

/** Weld duplicate vertices and drop degenerate / duplicate triangles. */
export function weldAndClean(g: THREE.BufferGeometry, tolerance = 1e-4): { geometry: THREE.BufferGeometry; removed: number } {
  const src = g.clone();
  for (const name of Object.keys(src.attributes)) if (name !== 'position') src.deleteAttribute(name);
  const welded = mergeVertices(src.index ? src.toNonIndexed() : src, tolerance);
  const m = read(welded);
  const seen = new Set<string>();
  const f: number[] = [];
  let removed = 0;
  for (let t = 0; t < m.f.length; t += 3) {
    const [a, b, c] = [m.f[t], m.f[t + 1], m.f[t + 2]];
    const area = V(m, b).sub(V(m, a)).cross(V(m, c).sub(V(m, a))).lengthSq();
    const key = [a, b, c].sort((x, y) => x - y).join('_');
    if (a === b || b === c || a === c || area < 1e-20 || seen.has(key)) {
      removed++;
      continue;
    }
    seen.add(key);
    f.push(a, b, c);
  }
  return { geometry: write({ p: m.p, f }), removed };
}

/**
 * Make triangle winding consistent within every shell (flood fill over
 * edges), then point closed shells outward; open shells keep the
 * orientation most of their triangles had.
 */
export function fixNormals(g: THREE.BufferGeometry): { geometry: THREE.BufferGeometry; flipped: number } {
  const m = read(g);
  const nf = m.f.length / 3;
  const edgeFaces = new Map<string, number[]>();
  for (let t = 0; t < nf; t++) {
    for (let k = 0; k < 3; k++) {
      const a = m.f[t * 3 + k], b = m.f[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push(t);
    }
  }
  const hasDirected = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (m.f[t * 3 + k] === a && m.f[t * 3 + ((k + 1) % 3)] === b) return true;
    return false;
  };
  const flip = (t: number) => {
    const x = m.f[t * 3 + 1];
    m.f[t * 3 + 1] = m.f[t * 3 + 2];
    m.f[t * 3 + 2] = x;
  };
  const visited = new Uint8Array(nf);
  let flipped = 0;
  for (let seed = 0; seed < nf; seed++) {
    if (visited[seed]) continue;
    const shell: number[] = [];
    const flippedHere: number[] = [];
    const stack = [seed];
    visited[seed] = 1;
    while (stack.length) {
      const t = stack.pop()!;
      shell.push(t);
      for (let k = 0; k < 3; k++) {
        const a = m.f[t * 3 + k], b = m.f[t * 3 + ((k + 1) % 3)];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const faces = edgeFaces.get(key)!;
        if (faces.length !== 2) continue; // boundary or non-manifold: don't propagate across
        const o = faces[0] === t ? faces[1] : faces[0];
        if (visited[o]) continue;
        visited[o] = 1;
        // consistent neighbours traverse the shared edge in opposite directions
        if (hasDirected(o, a, b)) {
          flip(o);
          flippedHere.push(o);
        }
        stack.push(o);
      }
    }
    // signed volume of the shell decides the global direction for closed shells
    let vol = 0;
    for (const t of shell) {
      const a = V(m, m.f[t * 3]), b = V(m, m.f[t * 3 + 1]), c = V(m, m.f[t * 3 + 2]);
      vol += a.dot(b.cross(c));
    }
    const closed = shell.every((t) => [0, 1, 2].every((k) => {
      const a = m.f[t * 3 + k], b = m.f[t * 3 + ((k + 1) % 3)];
      return edgeFaces.get(a < b ? `${a}_${b}` : `${b}_${a}`)!.length === 2;
    }));
    const flipAll = closed ? vol < 0 : flippedHere.length > shell.length / 2;
    if (flipAll) {
      for (const t of shell) flip(t);
      flipped += shell.length - flippedHere.length;
    } else {
      flipped += flippedHere.length;
    }
  }
  return { geometry: write(m), flipped };
}

/**
 * Cut the mesh with a plane and keep the side the normal points to.
 * With `fill`, the opening along the cut is closed flat.
 */
export function planeCut(g: THREE.BufferGeometry, plane: THREE.Plane, fill = true): THREE.BufferGeometry {
  const m = read(g);
  const d = Array.from({ length: m.p.length / 3 }, (_, i) => plane.distanceToPoint(V(m, i)));
  const edgeVertex = new Map<string, number>();
  const cutVertex = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let id = edgeVertex.get(key);
    if (id === undefined) {
      const t = d[a] / (d[a] - d[b]);
      const q = V(m, a).lerp(V(m, b), t);
      id = m.p.length / 3;
      m.p.push(q.x, q.y, q.z);
      d.push(0);
      edgeVertex.set(key, id);
    }
    return id;
  };
  const f: number[] = [];
  const eps = 1e-9;
  for (let t = 0; t < m.f.length; t += 3) {
    const tri = [m.f[t], m.f[t + 1], m.f[t + 2]];
    const inside = tri.map((v) => d[v] >= -eps);
    const n = inside.filter(Boolean).length;
    if (n === 3) f.push(...tri);
    else if (n === 0) continue;
    else {
      // rotate so the polygon walk keeps the winding
      const poly: number[] = [];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        if (inside[k]) poly.push(a);
        if (inside[k] !== inside[(k + 1) % 3]) poly.push(cutVertex(a, b));
      }
      for (let k = 1; k < poly.length - 1; k++) f.push(poly[0], poly[k], poly[k + 1]);
    }
  }
  const cut = write({ p: m.p, f });
  if (!fill) return cut;
  // fill only the openings that lie on the cutting plane
  return fillHoles(cut, Infinity, (loop) => loop.every((p) => Math.abs(plane.distanceToPoint(p)) < 1e-4)).geometry;
}
