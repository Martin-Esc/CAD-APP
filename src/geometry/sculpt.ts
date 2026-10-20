import * as THREE from 'three';

/**
 * Meshmixer-style sculpt brushes working directly on an indexed
 * BufferGeometry (positions edited in place, normals updated locally).
 *
 * All coordinates are in the mesh's local space: callers convert the brush
 * centre with the inverse of the object's world matrix.
 */
export type BrushKind = 'draw' | 'remove' | 'inflate' | 'smooth' | 'flatten' | 'grab';

export const BRUSH_LABELS: Record<BrushKind, string> = {
  draw: 'Draw',
  remove: 'Remove',
  inflate: 'Inflate',
  smooth: 'Smooth',
  flatten: 'Flatten',
  grab: 'Grab',
};

export interface BrushSettings {
  /** brush radius (mm) */
  radius: number;
  /** 0 … 1 */
  strength: number;
}

interface Selection {
  ids: Int32Array;
  weights: Float32Array;
}

/** Smooth falloff: 1 at the centre, 0 at the rim, flat derivative at both ends. */
function falloff(d: number, r: number): number {
  const x = 1 - (d * d) / (r * r);
  return x <= 0 ? 0 : x * x;
}

export class Sculptor {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  private readonly index: ArrayLike<number>;
  /** vertex -> neighbouring vertices (CSR) */
  private readonly nbStart: Int32Array;
  private readonly nbList: Int32Array;
  /** vertex -> incident faces (CSR) */
  private readonly vfStart: Int32Array;
  private readonly vfList: Int32Array;
  private grab: { sel: Selection; origin: Float32Array } | null = null;

  constructor(readonly geometry: THREE.BufferGeometry) {
    if (!geometry.index) throw new Error('Sculpting needs an indexed mesh – run "Weld & clean" first');
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    this.positions = geometry.getAttribute('position').array as Float32Array;
    this.normals = geometry.getAttribute('normal').array as Float32Array;
    this.index = geometry.index.array;
    const n = this.positions.length / 3;
    const triCount = this.index.length / 3;

    // vertex -> faces
    const vfCount = new Int32Array(n + 1);
    for (let i = 0; i < this.index.length; i++) vfCount[this.index[i] + 1]++;
    for (let i = 0; i < n; i++) vfCount[i + 1] += vfCount[i];
    this.vfStart = vfCount;
    this.vfList = new Int32Array(this.index.length);
    const fill = vfCount.slice(0, n);
    for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) this.vfList[fill[this.index[t * 3 + k]]++] = t;

    // vertex -> neighbours (unique)
    const sets: number[][] = Array.from({ length: n }, () => []);
    for (let t = 0; t < triCount; t++) {
      const a = this.index[t * 3], b = this.index[t * 3 + 1], c = this.index[t * 3 + 2];
      sets[a].push(b, c);
      sets[b].push(a, c);
      sets[c].push(a, b);
    }
    this.nbStart = new Int32Array(n + 1);
    const flat: number[] = [];
    for (let v = 0; v < n; v++) {
      const uniq = [...new Set(sets[v])];
      this.nbStart[v] = flat.length;
      flat.push(...uniq);
    }
    this.nbStart[n] = flat.length;
    this.nbList = new Int32Array(flat);
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Vertices within `radius` of `center`, with falloff weights. */
  select(center: THREE.Vector3, radius: number): Selection {
    const p = this.positions;
    const r2 = radius * radius;
    const ids: number[] = [];
    const w: number[] = [];
    for (let v = 0, i = 0; i < p.length; v++, i += 3) {
      const dx = p[i] - center.x;
      if (dx > radius || dx < -radius) continue;
      const dy = p[i + 1] - center.y;
      if (dy > radius || dy < -radius) continue;
      const dz = p[i + 2] - center.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      ids.push(v);
      w.push(falloff(Math.sqrt(d2), radius));
    }
    return { ids: Int32Array.from(ids), weights: Float32Array.from(w) };
  }

  private areaNormal(sel: Selection): THREE.Vector3 {
    const n = new THREE.Vector3();
    for (let k = 0; k < sel.ids.length; k++) {
      const i = sel.ids[k] * 3;
      n.x += this.normals[i] * sel.weights[k];
      n.y += this.normals[i + 1] * sel.weights[k];
      n.z += this.normals[i + 2] * sel.weights[k];
    }
    return n.lengthSq() > 0 ? n.normalize() : n.set(0, 0, 1);
  }

  private centroid(sel: Selection): THREE.Vector3 {
    const c = new THREE.Vector3();
    let sw = 0;
    for (let k = 0; k < sel.ids.length; k++) {
      const i = sel.ids[k] * 3;
      c.x += this.positions[i] * sel.weights[k];
      c.y += this.positions[i + 1] * sel.weights[k];
      c.z += this.positions[i + 2] * sel.weights[k];
      sw += sel.weights[k];
    }
    return sw > 0 ? c.divideScalar(sw) : c;
  }

  /**
   * One brush dab at `center`. `normalHint` is the surface normal under the
   * cursor (used when the brush area is too small to average). Returns the
   * affected vertices.
   */
  dab(kind: Exclude<BrushKind, 'grab'>, center: THREE.Vector3, brush: BrushSettings): Int32Array {
    const sel = this.select(center, brush.radius);
    if (!sel.ids.length) return sel.ids;
    const p = this.positions;
    const s = THREE.MathUtils.clamp(brush.strength, 0, 1);
    if (kind === 'draw' || kind === 'remove') {
      const n = this.areaNormal(sel);
      const amount = (kind === 'draw' ? 1 : -1) * s * brush.radius * 0.18;
      for (let k = 0; k < sel.ids.length; k++) {
        const i = sel.ids[k] * 3;
        const d = amount * sel.weights[k];
        p[i] += n.x * d;
        p[i + 1] += n.y * d;
        p[i + 2] += n.z * d;
      }
    } else if (kind === 'inflate') {
      const amount = s * brush.radius * 0.12;
      for (let k = 0; k < sel.ids.length; k++) {
        const i = sel.ids[k] * 3;
        const d = amount * sel.weights[k];
        p[i] += this.normals[i] * d;
        p[i + 1] += this.normals[i + 1] * d;
        p[i + 2] += this.normals[i + 2] * d;
      }
    } else if (kind === 'smooth') {
      this.smoothSelection(sel, Math.min(1, s * 1.2), 2);
    } else if (kind === 'flatten') {
      const n = this.areaNormal(sel);
      const c = this.centroid(sel);
      for (let k = 0; k < sel.ids.length; k++) {
        const i = sel.ids[k] * 3;
        const dist = (p[i] - c.x) * n.x + (p[i + 1] - c.y) * n.y + (p[i + 2] - c.z) * n.z;
        const d = dist * s * 0.5 * sel.weights[k];
        p[i] -= n.x * d;
        p[i + 1] -= n.y * d;
        p[i + 2] -= n.z * d;
      }
    }
    this.updateNormals(sel.ids);
    return sel.ids;
  }

  /** Laplacian smoothing of the selected vertices toward their neighbours. */
  smoothSelection(sel: Selection, amount: number, iterations = 1): void {
    const p = this.positions;
    const next = new Float32Array(sel.ids.length * 3);
    for (let it = 0; it < iterations; it++) {
      for (let k = 0; k < sel.ids.length; k++) {
        const v = sel.ids[k];
        let x = 0, y = 0, z = 0;
        const a = this.nbStart[v], b = this.nbStart[v + 1];
        for (let j = a; j < b; j++) {
          const u = this.nbList[j] * 3;
          x += p[u];
          y += p[u + 1];
          z += p[u + 2];
        }
        const cnt = b - a || 1;
        const t = amount * sel.weights[k];
        const i = v * 3;
        next[k * 3] = p[i] + (x / cnt - p[i]) * t;
        next[k * 3 + 1] = p[i + 1] + (y / cnt - p[i + 1]) * t;
        next[k * 3 + 2] = p[i + 2] + (z / cnt - p[i + 2]) * t;
      }
      for (let k = 0; k < sel.ids.length; k++) {
        const i = sel.ids[k] * 3;
        p[i] = next[k * 3];
        p[i + 1] = next[k * 3 + 1];
        p[i + 2] = next[k * 3 + 2];
      }
    }
  }

  /** Start a Grab stroke: remembers the region and its original positions. */
  beginGrab(center: THREE.Vector3, brush: BrushSettings): void {
    const sel = this.select(center, brush.radius);
    const origin = new Float32Array(sel.ids.length * 3);
    for (let k = 0; k < sel.ids.length; k++) origin.set(this.positions.subarray(sel.ids[k] * 3, sel.ids[k] * 3 + 3), k * 3);
    this.grab = { sel, origin };
  }

  /** Move the grabbed region by `delta` (from the stroke start), weighted by falloff. */
  grabTo(delta: THREE.Vector3, strength: number): Int32Array {
    if (!this.grab) return new Int32Array();
    const { sel, origin } = this.grab;
    const s = THREE.MathUtils.clamp(strength, 0, 1) * 0.5 + 0.5;
    for (let k = 0; k < sel.ids.length; k++) {
      const i = sel.ids[k] * 3;
      const w = sel.weights[k] * s;
      this.positions[i] = origin[k * 3] + delta.x * w;
      this.positions[i + 1] = origin[k * 3 + 1] + delta.y * w;
      this.positions[i + 2] = origin[k * 3 + 2] + delta.z * w;
    }
    this.updateNormals(sel.ids);
    return sel.ids;
  }

  endGrab(): void {
    this.grab = null;
  }

  /** Recompute the vertex normals of the given vertices and their neighbours. */
  updateNormals(ids: Int32Array): void {
    const p = this.positions;
    const nrm = this.normals;
    const touched = new Set<number>();
    for (const v of ids) {
      touched.add(v);
      for (let j = this.nbStart[v]; j < this.nbStart[v + 1]; j++) touched.add(this.nbList[j]);
    }
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
    for (const v of touched) {
      let nx = 0, ny = 0, nz = 0;
      for (let j = this.vfStart[v]; j < this.vfStart[v + 1]; j++) {
        const t = this.vfList[j] * 3;
        const a = this.index[t] * 3, b = this.index[t + 1] * 3, c = this.index[t + 2] * 3;
        e1.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        e2.set(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]);
        fn.crossVectors(e1, e2);
        nx += fn.x;
        ny += fn.y;
        nz += fn.z;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      nrm[v * 3] = nx / len;
      nrm[v * 3 + 1] = ny / len;
      nrm[v * 3 + 2] = nz / len;
    }
  }

  /** Flag the buffers for upload after edits. */
  commit(): void {
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('normal').needsUpdate = true;
  }
}
