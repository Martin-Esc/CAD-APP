import * as THREE from 'three';
import { DynamicMesh, applySnapshot } from './dynamesh';

/**
 * Meshmixer-style sculpt brushes with optional dynamic remeshing.
 *
 * The Sculptor owns a DynamicMesh copy of the object's geometry. During a
 * stroke the geometry is bound to the live buffers (`begin` / `flush`); at
 * the end it gets exact-size arrays again (`end`), so export, repair and
 * booleans always see a clean mesh.
 *
 * All coordinates are in the mesh's local space: callers convert the brush
 * centre with the inverse of the object's world matrix.
 */
export type BrushKind = 'draw' | 'remove' | 'inflate' | 'smooth' | 'flatten' | 'grab' | 'refine';

export const BRUSH_LABELS: Record<BrushKind, string> = {
  draw: 'Draw',
  remove: 'Remove',
  inflate: 'Inflate',
  smooth: 'Smooth',
  flatten: 'Flatten',
  grab: 'Grab',
  refine: 'Refine',
};

export interface BrushSettings {
  /** brush radius (mm) */
  radius: number;
  /** 0 … 1 */
  strength: number;
}

export interface RemeshSettings {
  /** target edge length under the brush (mm) */
  detail: number;
  /** split long edges (add detail) */
  refine: boolean;
  /** collapse short edges (remove detail) */
  reduce: boolean;
}

interface Selection {
  ids: number[];
  weights: number[];
}

/** Smooth falloff: 1 at the centre, 0 at the rim, flat derivative at both ends. */
function falloff(d: number, r: number): number {
  const x = 1 - (d * d) / (r * r);
  return x <= 0 ? 0 : x * x;
}

export class Sculptor {
  readonly mesh: DynamicMesh;
  private grab: { sel: Selection; origin: Float32Array; center: THREE.Vector3; radius: number; delta: THREE.Vector3 } | null = null;

  constructor(readonly geometry: THREE.BufferGeometry) {
    this.mesh = new DynamicMesh(geometry);
  }

  /** Current positions (live view; re-read after topology changes). */
  get positions(): Float32Array {
    return this.mesh.pos.subarray(0, this.mesh.vCount * 3);
  }

  get vertexCount(): number {
    return this.mesh.vCount;
  }

  get triangleCount(): number {
    return this.mesh.fCount;
  }

  select(center: THREE.Vector3, radius: number): Selection {
    const ids = this.mesh.within(center, radius);
    const p = this.mesh.pos;
    const weights = ids.map((v) => falloff(Math.hypot(p[v * 3] - center.x, p[v * 3 + 1] - center.y, p[v * 3 + 2] - center.z), radius));
    return { ids, weights };
  }

  private areaNormal(sel: Selection): THREE.Vector3 {
    const n = new THREE.Vector3();
    const nrm = this.mesh.nrm;
    sel.ids.forEach((v, k) => {
      n.x += nrm[v * 3] * sel.weights[k];
      n.y += nrm[v * 3 + 1] * sel.weights[k];
      n.z += nrm[v * 3 + 2] * sel.weights[k];
    });
    return n.lengthSq() > 0 ? n.normalize() : n.set(0, 0, 1);
  }

  private centroid(sel: Selection): THREE.Vector3 {
    const c = new THREE.Vector3();
    const p = this.mesh.pos;
    let sw = 0;
    sel.ids.forEach((v, k) => {
      c.x += p[v * 3] * sel.weights[k];
      c.y += p[v * 3 + 1] * sel.weights[k];
      c.z += p[v * 3 + 2] * sel.weights[k];
      sw += sel.weights[k];
    });
    return sw > 0 ? c.divideScalar(sw) : c;
  }

  /**
   * One brush dab at `center`. With `remesh`, the region is re-triangulated
   * to the target edge length first, so the brush always works on even
   * triangles. Returns the number of affected vertices.
   */
  dab(kind: Exclude<BrushKind, 'grab'>, center: THREE.Vector3, brush: BrushSettings, remesh?: RemeshSettings | null): number {
    if (kind === 'refine') {
      // remesh only: even out the triangles without changing the shape
      const r = remesh ?? { detail: brush.radius / 10, refine: true, reduce: true };
      this.mesh.remesh(center, brush.radius, this.detailFor(brush, r), { ...r, passes: 2 });
      return 1;
    }
    if (remesh) this.mesh.remesh(center, brush.radius * 1.15, this.detailFor(brush, remesh), { ...remesh, passes: 1 });
    const sel = this.select(center, brush.radius);
    if (!sel.ids.length) return 0;
    const p = this.mesh.pos;
    const nrm = this.mesh.nrm;
    const s = THREE.MathUtils.clamp(brush.strength, 0, 1);
    if (kind === 'draw' || kind === 'remove') {
      const n = this.areaNormal(sel);
      const amount = (kind === 'draw' ? 1 : -1) * s * brush.radius * 0.18;
      sel.ids.forEach((v, k) => {
        const d = amount * sel.weights[k];
        p[v * 3] += n.x * d;
        p[v * 3 + 1] += n.y * d;
        p[v * 3 + 2] += n.z * d;
      });
    } else if (kind === 'inflate') {
      const amount = s * brush.radius * 0.12;
      sel.ids.forEach((v, k) => {
        const d = amount * sel.weights[k];
        p[v * 3] += nrm[v * 3] * d;
        p[v * 3 + 1] += nrm[v * 3 + 1] * d;
        p[v * 3 + 2] += nrm[v * 3 + 2] * d;
      });
    } else if (kind === 'smooth') {
      this.smoothSelection(sel, Math.min(1, s * 1.2), 2);
    } else if (kind === 'flatten') {
      const n = this.areaNormal(sel);
      const c = this.centroid(sel);
      sel.ids.forEach((v, k) => {
        const dist = (p[v * 3] - c.x) * n.x + (p[v * 3 + 1] - c.y) * n.y + (p[v * 3 + 2] - c.z) * n.z;
        const d = dist * s * 0.5 * sel.weights[k];
        p[v * 3] -= n.x * d;
        p[v * 3 + 1] -= n.y * d;
        p[v * 3 + 2] -= n.z * d;
      });
    }
    this.mesh.touch(sel.ids);
    this.mesh.updateNormals(sel.ids);
    return sel.ids.length;
  }

  /** Remesh around a stroke segment once per pointer move (cheaper than per dab). */
  remeshSegment(from: THREE.Vector3, to: THREE.Vector3, brush: BrushSettings, remesh: RemeshSettings): void {
    const center = from.clone().add(to).multiplyScalar(0.5);
    const radius = brush.radius * 1.15 + from.distanceTo(to) / 2;
    this.mesh.remesh(center, radius, this.detailFor(brush, remesh), { ...remesh, passes: 1 });
  }

  /** Target edge length: the requested detail, but never so fine that one dab creates thousands of triangles. */
  private detailFor(brush: BrushSettings, remesh: RemeshSettings): number {
    return Math.max(remesh.detail, brush.radius / 25);
  }

  /** Laplacian smoothing of the selected vertices toward their neighbours. */
  smoothSelection(sel: Selection, amount: number, iterations = 1): void {
    const p = this.mesh.pos;
    for (let it = 0; it < iterations; it++) {
      const next = sel.ids.map((v, k) => {
        const nb = this.mesh.neighbours(v);
        let x = 0, y = 0, z = 0;
        for (const u of nb) {
          x += p[u * 3];
          y += p[u * 3 + 1];
          z += p[u * 3 + 2];
        }
        const cnt = nb.length || 1;
        const t = amount * sel.weights[k];
        return [p[v * 3] + (x / cnt - p[v * 3]) * t, p[v * 3 + 1] + (y / cnt - p[v * 3 + 1]) * t, p[v * 3 + 2] + (z / cnt - p[v * 3 + 2]) * t];
      });
      sel.ids.forEach((v, k) => {
        p[v * 3] = next[k][0];
        p[v * 3 + 1] = next[k][1];
        p[v * 3 + 2] = next[k][2];
      });
    }
  }

  /** Start a Grab stroke: remembers the region and its original positions. */
  beginGrab(center: THREE.Vector3, brush: BrushSettings, remesh?: RemeshSettings | null): void {
    if (remesh) this.mesh.remesh(center, brush.radius * 1.15, this.detailFor(brush, remesh), { ...remesh, passes: 1 });
    const sel = this.select(center, brush.radius);
    const origin = new Float32Array(sel.ids.length * 3);
    sel.ids.forEach((v, k) => origin.set(this.mesh.pos.subarray(v * 3, v * 3 + 3), k * 3));
    this.grab = { sel, origin, center: center.clone(), radius: brush.radius, delta: new THREE.Vector3() };
  }

  /** Move the grabbed region by `delta` (from the stroke start), weighted by falloff. */
  grabTo(delta: THREE.Vector3, strength: number): number {
    if (!this.grab) return 0;
    const { sel, origin } = this.grab;
    const p = this.mesh.pos;
    const s = THREE.MathUtils.clamp(strength, 0, 1) * 0.5 + 0.5;
    sel.ids.forEach((v, k) => {
      const w = sel.weights[k] * s;
      p[v * 3] = origin[k * 3] + delta.x * w;
      p[v * 3 + 1] = origin[k * 3 + 1] + delta.y * w;
      p[v * 3 + 2] = origin[k * 3 + 2] + delta.z * w;
    });
    this.grab.delta.copy(delta);
    this.mesh.updateNormals(sel.ids);
    return sel.ids.length;
  }

  /** End a Grab stroke; with remeshing, the stretched region is re-triangulated. */
  endGrab(remesh?: RemeshSettings | null): void {
    const g = this.grab;
    this.grab = null;
    if (!g || !remesh) return;
    const len = g.delta.length();
    const center = g.center.clone().addScaledVector(g.delta, 0.5);
    const detail = this.detailFor({ radius: g.radius, strength: 1 }, remesh);
    this.mesh.remesh(center, g.radius * 1.2 + len * 0.6, detail, { ...remesh, passes: 3, maxOps: 20000 });
  }

  /** Remesh a region without changing its shape (Meshmixer's "Refine"). */
  remeshAt(center: THREE.Vector3, radius: number, remesh: RemeshSettings): void {
    this.mesh.remesh(center, radius, this.detailFor({ radius, strength: 1 }, remesh), { ...remesh, passes: 3, maxOps: 50000 });
  }

  /** Bind the geometry to the live buffers for the duration of a stroke. */
  begin(): void {
    this.mesh.attach(this.geometry);
  }

  /** Upload the latest changes (call once per pointer event). */
  flush(): void {
    this.mesh.flush(this.geometry);
  }

  /** Finish a stroke: the geometry gets exact-size arrays (also usable for undo). */
  end(): { position: Float32Array; normal: Float32Array; index: Uint32Array } {
    const snap = this.mesh.snapshot();
    applySnapshot(this.geometry, snap);
    return snap;
  }

  /** Back-compat for callers that edit without a live stroke (tests). */
  commit(): void {
    this.end();
  }
}
