import * as THREE from 'three';

/**
 * Triangle mesh with mutable topology, for sculpting with dynamic remeshing.
 *
 * Storage is in growable typed arrays so it can be handed to the GPU
 * directly while a stroke is in progress (see `attach`). Faces are kept
 * contiguous (a removed face is replaced by the last one); removed vertices
 * stay in the arrays, unreferenced, until `compact`.
 */
export class DynamicMesh {
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
  alive: Uint8Array;
  vCount = 0;
  fCount = 0;
  /** vertex -> incident faces */
  vf: number[][] = [];
  /** dirty ranges since the last flush (only these spans are uploaded to the GPU) */
  private vMin = Infinity;
  private vMax = -1;
  private fMin = Infinity;
  private fMax = -1;

  /** Mark vertices whose position / normal changed. */
  touch(verts: Iterable<number>): void {
    for (const v of verts) {
      if (v < this.vMin) this.vMin = v;
      if (v > this.vMax) this.vMax = v;
    }
  }

  private touchFace(t: number): void {
    if (t < this.fMin) this.fMin = t;
    if (t > this.fMax) this.fMax = t;
  }

  constructor(geometry: THREE.BufferGeometry) {
    const p = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!index) throw new Error('Sculpting needs an indexed mesh – run "Weld & clean" first');
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const n = geometry.getAttribute('normal');
    const triCount = (geometry.drawRange.count !== Infinity ? Math.min(geometry.drawRange.count, index.count) : index.count) / 3;
    const vCap = Math.ceil(p.count * 1.5) + 1024;
    const fCap = Math.ceil(triCount * 1.5) + 2048;
    this.pos = new Float32Array(vCap * 3);
    this.nrm = new Float32Array(vCap * 3);
    this.alive = new Uint8Array(vCap);
    this.idx = new Uint32Array(fCap * 3);
    for (let i = 0; i < p.count; i++) {
      this.pos[i * 3] = p.getX(i);
      this.pos[i * 3 + 1] = p.getY(i);
      this.pos[i * 3 + 2] = p.getZ(i);
      this.nrm[i * 3] = n.getX(i);
      this.nrm[i * 3 + 1] = n.getY(i);
      this.nrm[i * 3 + 2] = n.getZ(i);
      this.alive[i] = 1;
      this.vf.push([]);
    }
    this.vCount = p.count;
    for (let t = 0; t < triCount; t++) {
      const a = index.getX(t * 3), b = index.getX(t * 3 + 1), c = index.getX(t * 3 + 2);
      this.idx[t * 3] = a;
      this.idx[t * 3 + 1] = b;
      this.idx[t * 3 + 2] = c;
      this.vf[a].push(t);
      this.vf[b].push(t);
      this.vf[c].push(t);
    }
    this.fCount = triCount;
  }

  /** True when the storage was reallocated since the last call (GPU buffers must be re-bound). */
  private grown = false;

  takeGrown(): boolean {
    const g = this.grown;
    this.grown = false;
    return g;
  }

  private ensureVertexCapacity(n: number): void {
    if (n <= this.alive.length) return;
    const cap = Math.ceil(n * 1.5);
    const pos = new Float32Array(cap * 3);
    pos.set(this.pos);
    const nrm = new Float32Array(cap * 3);
    nrm.set(this.nrm);
    const alive = new Uint8Array(cap);
    alive.set(this.alive);
    this.pos = pos;
    this.nrm = nrm;
    this.alive = alive;
    this.grown = true;
  }

  private ensureFaceCapacity(n: number): void {
    if (n * 3 <= this.idx.length) return;
    const idx = new Uint32Array(Math.ceil(n * 1.5) * 3);
    idx.set(this.idx);
    this.idx = idx;
    this.grown = true;
  }

  addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    this.ensureVertexCapacity(this.vCount + 1);
    const v = this.vCount++;
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nrm[v * 3] = nx / l;
    this.nrm[v * 3 + 1] = ny / l;
    this.nrm[v * 3 + 2] = nz / l;
    this.alive[v] = 1;
    this.vf.push([]);
    this.touch([v]);
    return v;
  }

  private addFace(a: number, b: number, c: number): number {
    this.ensureFaceCapacity(this.fCount + 1);
    const t = this.fCount++;
    this.idx[t * 3] = a;
    this.idx[t * 3 + 1] = b;
    this.idx[t * 3 + 2] = c;
    this.vf[a].push(t);
    this.vf[b].push(t);
    this.vf[c].push(t);
    this.touchFace(t);
    return t;
  }

  private static drop(list: number[], value: number): void {
    const i = list.indexOf(value);
    if (i >= 0) {
      list[i] = list[list.length - 1];
      list.pop();
    }
  }

  private static swap(list: number[], from: number, to: number): void {
    const i = list.indexOf(from);
    if (i >= 0) list[i] = to;
  }

  private removeFace(t: number): void {
    for (let k = 0; k < 3; k++) DynamicMesh.drop(this.vf[this.idx[t * 3 + k]], t);
    const last = this.fCount - 1;
    if (t !== last) {
      for (let k = 0; k < 3; k++) {
        const v = this.idx[last * 3 + k];
        this.idx[t * 3 + k] = v;
        DynamicMesh.swap(this.vf[v], last, t);
      }
      this.touchFace(t);
    }
    this.fCount--;
  }

  /** Replace vertex `from` with `to` in face t. */
  private replaceInFace(t: number, from: number, to: number): void {
    for (let k = 0; k < 3; k++) {
      if (this.idx[t * 3 + k] === from) {
        this.idx[t * 3 + k] = to;
        DynamicMesh.drop(this.vf[from], t);
        this.vf[to].push(t);
        this.touchFace(t);
        return;
      }
    }
  }

  faceHas(t: number, v: number): boolean {
    return this.idx[t * 3] === v || this.idx[t * 3 + 1] === v || this.idx[t * 3 + 2] === v;
  }

  edgeFaces(a: number, b: number): number[] {
    return this.vf[a].filter((t) => this.faceHas(t, b));
  }

  neighbours(v: number): number[] {
    const out = new Set<number>();
    for (const t of this.vf[v]) for (let k = 0; k < 3; k++) {
      const u = this.idx[t * 3 + k];
      if (u !== v) out.add(u);
    }
    return [...out];
  }

  isBoundary(v: number): boolean {
    const count = new Map<number, number>();
    for (const t of this.vf[v]) for (let k = 0; k < 3; k++) {
      const u = this.idx[t * 3 + k];
      if (u !== v) count.set(u, (count.get(u) ?? 0) + 1);
    }
    for (const c of count.values()) if (c !== 2) return true;
    return false;
  }

  dist2(a: number, b: number): number {
    const p = this.pos;
    const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  /** Split edge (a, b) at its midpoint; both adjacent faces become two. */
  split(a: number, b: number): number {
    const p = this.pos, n = this.nrm;
    const m = this.addVertex(
      (p[a * 3] + p[b * 3]) / 2, (p[a * 3 + 1] + p[b * 3 + 1]) / 2, (p[a * 3 + 2] + p[b * 3 + 2]) / 2,
      n[a * 3] + n[b * 3], n[a * 3 + 1] + n[b * 3 + 1], n[a * 3 + 2] + n[b * 3 + 2],
    );
    for (const t of this.edgeFaces(a, b)) {
      // rotate the face so it reads (u, v, c) with u→v being the edge in face order
      const f = [this.idx[t * 3], this.idx[t * 3 + 1], this.idx[t * 3 + 2]];
      let k = 0;
      while (!((f[k] === a && f[(k + 1) % 3] === b) || (f[k] === b && f[(k + 1) % 3] === a))) k++;
      const v = f[(k + 1) % 3], c = f[(k + 2) % 3];
      this.replaceInFace(t, v, m); // (u, v, c) -> (u, m, c)
      this.addFace(m, v, c);
    }
    return m;
  }

  /**
   * Collapse interior edge (a, b) into its midpoint, if that keeps the
   * surface manifold and does not fold any triangle. Returns success.
   */
  collapse(a: number, b: number, maxEdge2: number): boolean {
    if (!this.alive[a] || !this.alive[b]) return false;
    const shared = this.edgeFaces(a, b);
    if (shared.length !== 2) return false;
    if (this.isBoundary(a) || this.isBoundary(b)) return false;
    const na = this.neighbours(a);
    const nb = new Set(this.neighbours(b));
    const common = na.filter((u) => nb.has(u));
    if (common.length !== 2) return false; // link condition
    if (na.length + nb.size - 4 < 3) return false;
    const p = this.pos;
    const mx = (p[a * 3] + p[b * 3]) / 2, my = (p[a * 3 + 1] + p[b * 3 + 1]) / 2, mz = (p[a * 3 + 2] + p[b * 3 + 2]) / 2;
    // no folded triangles, no new over-long edges
    const P = (v: number) => (v === a || v === b ? [mx, my, mz] : [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
    const Q = (v: number) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
    const normal = (x: number[], y: number[], z: number[]) => {
      const ux = y[0] - x[0], uy = y[1] - x[1], uz = y[2] - x[2];
      const vx = z[0] - x[0], vy = z[1] - x[1], vz = z[2] - x[2];
      return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    for (const t of new Set([...this.vf[a], ...this.vf[b]])) {
      if (shared.includes(t)) continue;
      const f = [this.idx[t * 3], this.idx[t * 3 + 1], this.idx[t * 3 + 2]];
      const before = normal(Q(f[0]), Q(f[1]), Q(f[2]));
      const after = normal(P(f[0]), P(f[1]), P(f[2]));
      const lb = Math.hypot(...before), la = Math.hypot(...after);
      if (la < 1e-12) return false;
      if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] < 0.3 * lb * la) return false;
      for (const v of f) {
        if (v === a || v === b) continue;
        const dx = p[v * 3] - mx, dy = p[v * 3 + 1] - my, dz = p[v * 3 + 2] - mz;
        if (dx * dx + dy * dy + dz * dz > maxEdge2) return false;
      }
    }
    // remove the two faces on the edge (highest index first: removal moves the last face)
    for (const t of shared.sort((x, y) => y - x)) this.removeFace(t);
    for (const t of [...this.vf[b]]) this.replaceInFace(t, b, a);
    this.vf[b] = [];
    this.alive[b] = 0;
    p[a * 3] = mx;
    p[a * 3 + 1] = my;
    p[a * 3 + 2] = mz;
    this.touch([a]);
    return true;
  }

  /** Vertices within radius of center (brute force, skips removed vertices). */
  within(center: THREE.Vector3, radius: number): number[] {
    const p = this.pos;
    const r2 = radius * radius;
    const out: number[] = [];
    for (let v = 0; v < this.vCount; v++) {
      if (!this.alive[v]) continue;
      const dx = p[v * 3] - center.x;
      if (dx > radius || dx < -radius) continue;
      const dy = p[v * 3 + 1] - center.y;
      if (dy > radius || dy < -radius) continue;
      const dz = p[v * 3 + 2] - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(v);
    }
    return out;
  }

  /**
   * Adaptive remesh of the region around `center`: split edges longer than
   * 4/3 · target, collapse edges shorter than 4/5 · target, then relax the
   * vertices along the surface. Keeps triangles even under the brush.
   */
  remesh(center: THREE.Vector3, radius: number, target: number, opts: { refine?: boolean; reduce?: boolean; passes?: number; maxOps?: number } = {}): void {
    const refine = opts.refine ?? true;
    const reduce = opts.reduce ?? true;
    const hi2 = (target * 4 / 3) ** 2;
    const lo2 = (target * 4 / 5) ** 2;
    const maxOps = opts.maxOps ?? 4000;
    const region = this.within(center, radius);
    const inRegion = new Set(region);
    const edgesOf = () => {
      const seen = new Set<number>();
      const edges: [number, number, number][] = [];
      for (const v of inRegion) {
        if (!this.alive[v]) continue;
        for (const t of this.vf[v]) for (let k = 0; k < 3; k++) {
          const a = this.idx[t * 3 + k], b = this.idx[t * 3 + ((k + 1) % 3)];
          if (!inRegion.has(a) && !inRegion.has(b)) continue;
          const key = a < b ? a * 4194304 + b : b * 4194304 + a;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push([a, b, this.dist2(a, b)]);
        }
      }
      return edges;
    };
    for (let pass = 0; pass < (opts.passes ?? 2); pass++) {
      let ops = 0;
      if (refine) {
        const long = edgesOf().filter((e) => e[2] > hi2).sort((x, y) => y[2] - x[2]);
        for (const [a, b] of long) {
          if (ops++ > maxOps) break;
          if (!this.alive[a] || !this.alive[b] || this.dist2(a, b) <= hi2 || !this.edgeFaces(a, b).length) continue;
          const m = this.split(a, b);
          inRegion.add(m);
        }
      }
      if (reduce) {
        const short = edgesOf().filter((e) => e[2] < lo2).sort((x, y) => x[2] - y[2]);
        for (const [a, b] of short) {
          if (ops++ > maxOps) break;
          if (!this.alive[a] || !this.alive[b] || this.dist2(a, b) >= lo2) continue;
          if (this.collapse(a, b, hi2)) inRegion.delete(b);
        }
      }
      this.relax([...inRegion]);
    }
    this.updateNormals([...inRegion]);
  }

  /** Tangential smoothing: evens out vertex spacing without changing the shape. */
  relax(verts: number[], amount = 0.5): void {
    const p = this.pos, n = this.nrm;
    const moves: [number, number, number, number][] = [];
    for (const v of verts) {
      if (!this.alive[v] || this.isBoundary(v)) continue;
      const nb = this.neighbours(v);
      if (nb.length < 3) continue;
      let cx = 0, cy = 0, cz = 0;
      for (const u of nb) {
        cx += p[u * 3];
        cy += p[u * 3 + 1];
        cz += p[u * 3 + 2];
      }
      let dx = cx / nb.length - p[v * 3], dy = cy / nb.length - p[v * 3 + 1], dz = cz / nb.length - p[v * 3 + 2];
      const d = dx * n[v * 3] + dy * n[v * 3 + 1] + dz * n[v * 3 + 2];
      dx -= d * n[v * 3];
      dy -= d * n[v * 3 + 1];
      dz -= d * n[v * 3 + 2];
      moves.push([v, dx * amount, dy * amount, dz * amount]);
    }
    for (const [v, x, y, z] of moves) {
      p[v * 3] += x;
      p[v * 3 + 1] += y;
      p[v * 3 + 2] += z;
    }
    this.touch(moves.map((m) => m[0]));
  }

  /** Recompute vertex normals of the given vertices and their neighbours. */
  updateNormals(verts: Iterable<number>): void {
    const p = this.pos, n = this.nrm;
    const touched = new Set<number>();
    for (const v of verts) {
      if (!this.alive[v]) continue;
      touched.add(v);
      for (const u of this.neighbours(v)) touched.add(u);
    }
    for (const v of touched) {
      let nx = 0, ny = 0, nz = 0;
      for (const t of this.vf[v]) {
        const a = this.idx[t * 3] * 3, b = this.idx[t * 3 + 1] * 3, c = this.idx[t * 3 + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
        nx += uy * wz - uz * wy;
        ny += uz * wx - ux * wz;
        nz += ux * wy - uy * wx;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      n[v * 3] = nx / l;
      n[v * 3 + 1] = ny / l;
      n[v * 3 + 2] = nz / l;
    }
    this.touch(touched);
  }

  /**
   * Closest ray hit among the faces near `near` (local coordinates).
   * Fast during a stroke, when the cursor stays close to the last hit.
   */
  raycastNear(ray: THREE.Ray, near: THREE.Vector3, radius: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const faces = new Set<number>();
    for (const v of this.within(near, radius)) for (const t of this.vf[v]) faces.add(t);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best: { point: THREE.Vector3; normal: THREE.Vector3; d: number } | null = null;
    for (const t of faces) {
      a.fromArray(this.pos, this.idx[t * 3] * 3);
      b.fromArray(this.pos, this.idx[t * 3 + 1] * 3);
      c.fromArray(this.pos, this.idx[t * 3 + 2] * 3);
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
      const d = hit.distanceToSquared(ray.origin);
      if (!best || d < best.d) {
        const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
        if (normal.dot(ray.direction) > 0) normal.negate();
        best = { point: hit.clone(), normal, d };
      }
    }
    return best ? { point: best.point, normal: best.normal } : null;
  }

  /** Renumber vertices so only live, referenced ones remain. */
  compact(): void {
    const remap = new Int32Array(this.vCount).fill(-1);
    let next = 0;
    for (let t = 0; t < this.fCount * 3; t++) {
      const v = this.idx[t];
      if (remap[v] < 0) remap[v] = next++;
    }
    const pos = new Float32Array(Math.max(this.alive.length, next) * 3);
    const nrm = new Float32Array(pos.length);
    const alive = new Uint8Array(pos.length / 3);
    const vf: number[][] = Array.from({ length: next }, () => []);
    for (let v = 0; v < this.vCount; v++) {
      const r = remap[v];
      if (r < 0) continue;
      pos[r * 3] = this.pos[v * 3];
      pos[r * 3 + 1] = this.pos[v * 3 + 1];
      pos[r * 3 + 2] = this.pos[v * 3 + 2];
      nrm[r * 3] = this.nrm[v * 3];
      nrm[r * 3 + 1] = this.nrm[v * 3 + 1];
      nrm[r * 3 + 2] = this.nrm[v * 3 + 2];
      alive[r] = 1;
    }
    for (let t = 0; t < this.fCount; t++) {
      for (let k = 0; k < 3; k++) {
        const r = remap[this.idx[t * 3 + k]];
        this.idx[t * 3 + k] = r;
        vf[r].push(t);
      }
    }
    this.pos = pos;
    this.nrm = nrm;
    this.alive = alive;
    this.vf = vf;
    this.vCount = next;
    this.grown = true;
  }

  /** Point the geometry at the live (capacity-sized) buffers for fast updates while sculpting. */
  attach(geometry: THREE.BufferGeometry): void {
    releaseGpu(geometry);
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.array !== this.pos) geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!nrm || nrm.array !== this.nrm) geometry.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    if (!geometry.index || geometry.index.array !== this.idx) geometry.setIndex(new THREE.BufferAttribute(this.idx, 1));
    geometry.setDrawRange(0, this.fCount * 3);
  }

  /** Upload changes while attached: only the dirty spans of the buffers. */
  flush(geometry: THREE.BufferGeometry): void {
    const regrown = this.takeGrown();
    if (regrown) this.attach(geometry);
    geometry.setDrawRange(0, this.fCount * 3);
    const upload = (attr: THREE.BufferAttribute, start: number, count: number) => {
      attr.clearUpdateRanges();
      if (!regrown) attr.addUpdateRange(start, count);
      attr.needsUpdate = true;
    };
    if (this.vMax >= this.vMin) {
      upload(geometry.getAttribute('position') as THREE.BufferAttribute, this.vMin * 3, (this.vMax - this.vMin + 1) * 3);
      upload(geometry.getAttribute('normal') as THREE.BufferAttribute, this.vMin * 3, (this.vMax - this.vMin + 1) * 3);
    }
    if (this.fMax >= this.fMin) upload(geometry.index!, this.fMin * 3, (this.fMax - this.fMin + 1) * 3);
    this.vMin = this.fMin = Infinity;
    this.vMax = this.fMax = -1;
  }

  /** Exact-size copies of the current mesh (for the geometry, export and undo). */
  snapshot(): { position: Float32Array; normal: Float32Array; index: Uint32Array } {
    this.compact();
    return {
      position: this.pos.slice(0, this.vCount * 3),
      normal: this.nrm.slice(0, this.vCount * 3),
      index: this.idx.slice(0, this.fCount * 3),
    };
  }
}

/**
 * Drop the renderer's GPU copies before swapping a geometry's buffers.
 * Without this three.js keeps the old buffers (a leak per stroke) and a
 * stale wireframe index built from the previous triangles.
 */
function releaseGpu(geometry: THREE.BufferGeometry): void {
  geometry.dispatchEvent({ type: 'dispose' });
}

/** Put exact-size arrays on a geometry (ends the live, capacity-sized binding). */
export function applySnapshot(geometry: THREE.BufferGeometry, s: { position: Float32Array; normal: Float32Array; index: Uint32Array }): void {
  releaseGpu(geometry);
  geometry.setAttribute('position', new THREE.BufferAttribute(s.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(s.normal, 3));
  geometry.setIndex(new THREE.BufferAttribute(s.index, 1));
  geometry.setDrawRange(0, Infinity);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

export function snapshotOf(geometry: THREE.BufferGeometry): { position: Float32Array; normal: Float32Array; index: Uint32Array } {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return {
    position: geometry.getAttribute('position').array as Float32Array,
    normal: geometry.getAttribute('normal').array as Float32Array,
    index: Uint32Array.from(geometry.index!.array as ArrayLike<number>),
  };
}
