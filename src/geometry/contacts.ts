import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { MeshBuilder } from './MeshBuilder';

/**
 * Occlusal and proximal contact control (cf. exocad's antagonist / approximal
 * contact settings): crown vertices that come closer to an obstacle (the
 * antagonist scan, neighbouring teeth) than the requested clearance are moved
 * back, and the correction is spread smoothly over the surrounding surface so
 * the crown gets a contact area instead of a dent.
 */

export interface Obstacle {
  bvh: MeshBVH;
  geometry: THREE.BufferGeometry;
  /** target distance from the obstacle (mm): > 0 clearance, 0 touching, < 0 tight contact */
  clearance: number;
  /** skip closest points for which this returns true (e.g. the crown's own die) */
  ignore?: (closest: THREE.Vector3) => boolean;
}

/** BVH over a world-space copy of a scan (built once per design run). */
export function makeObstacleGeometry(geometry: THREE.BufferGeometry): { bvh: MeshBVH; geometry: THREE.BufferGeometry } {
  const g = geometry.index ? geometry : geometry.clone();
  // `indirect` keeps the index buffer untouched (the scan is displayed with it)
  const bvh = new MeshBVH(g, { indirect: true });
  return { bvh, geometry: g };
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

function faceNormal(g: THREE.BufferGeometry, face: number, out: THREE.Vector3): THREE.Vector3 {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const i0 = idx ? idx.getX(face * 3) : face * 3;
  const i1 = idx ? idx.getX(face * 3 + 1) : face * 3 + 1;
  const i2 = idx ? idx.getX(face * 3 + 2) : face * 3 + 2;
  tmpA.fromBufferAttribute(pos, i0);
  tmpB.fromBufferAttribute(pos, i1).sub(tmpA);
  tmpC.fromBufferAttribute(pos, i2).sub(tmpA);
  return out.crossVectors(tmpB, tmpC).normalize();
}

/**
 * Signed distance from p to the obstacle surface (positive outside, using the
 * obstacle's outward face normals) and the direction to push p outward.
 */
export function signedDistance(o: Obstacle, p: THREE.Vector3, maxDistance: number): { d: number; normal: THREE.Vector3 } | null {
  const hit = o.bvh.closestPointToPoint(p, { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }, 0, maxDistance);
  if (!hit) return null;
  if (o.ignore?.(hit.point)) return null;
  const n = faceNormal(o.geometry, hit.faceIndex, new THREE.Vector3());
  const toP = p.clone().sub(hit.point);
  const d = toP.length();
  const sign = toP.dot(n) >= 0 ? 1 : -1;
  // push along the face normal (robust also when p is deep inside)
  return { d: sign * d, normal: n };
}

export interface AdaptResult {
  /** vertices moved */
  moved: number;
  /** largest correction applied (mm) */
  maxCorrection: number;
  /** remaining worst violation after adaptation (mm, ≤ 0 means none) */
  remaining: number;
}

/**
 * Move vertices of `mb` (world space) out of the obstacles' clearance zones.
 * `weight(v)` ∈ [0,1] says how freely each vertex may move: 0 keeps it fixed
 * (margin, intaglio), 1 moves it fully.
 */
export function adaptToObstacles(mb: MeshBuilder, weight: Float32Array, obstacles: Obstacle[], rounds = 4): AdaptResult {
  const n = mb.vertexCount;
  const p = mb.positions;
  // vertex adjacency for smoothing the correction field
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < mb.indices.length; i += 3) {
    const a = mb.indices[i], b = mb.indices[i + 1], c = mb.indices[i + 2];
    nb[a].push(b, c);
    nb[b].push(a, c);
    nb[c].push(a, b);
  }
  let moved = 0;
  let maxCorrection = 0;
  const v = new THREE.Vector3();
  const raw = new Float32Array(n * 3);
  const violation = (vi: number): THREE.Vector3 | null => {
    v.set(p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]);
    let worst: THREE.Vector3 | null = null;
    let worstLen = 0;
    for (const o of obstacles) {
      const s = signedDistance(o, v, Math.max(0.5, o.clearance + 0.5));
      if (!s || s.d >= o.clearance) continue;
      const need = o.clearance - s.d;
      if (need > worstLen) {
        worstLen = need;
        worst = s.normal.clone().multiplyScalar(need);
      }
    }
    return worst;
  };
  for (let round = 0; round < rounds; round++) {
    raw.fill(0);
    let any = false;
    for (let vi = 0; vi < n; vi++) {
      if (weight[vi] <= 0) continue;
      const d = violation(vi);
      if (!d) continue;
      raw[vi * 3] = d.x;
      raw[vi * 3 + 1] = d.y;
      raw[vi * 3 + 2] = d.z;
      any = true;
    }
    if (!any) break;
    // spread: each vertex takes the larger of its own correction and a share of its neighbours'
    let field = raw;
    for (let it = 0; it < 6; it++) {
      const next = new Float32Array(field);
      for (let vi = 0; vi < n; vi++) {
        if (weight[vi] <= 0 || !nb[vi].length) continue;
        let x = 0, y = 0, z = 0;
        for (const u of nb[vi]) {
          x += field[u * 3];
          y += field[u * 3 + 1];
          z += field[u * 3 + 2];
        }
        const k = 0.8 / nb[vi].length;
        x *= k;
        y *= k;
        z *= k;
        const own = field[vi * 3] ** 2 + field[vi * 3 + 1] ** 2 + field[vi * 3 + 2] ** 2;
        if (x * x + y * y + z * z > own) {
          next[vi * 3] = x;
          next[vi * 3 + 1] = y;
          next[vi * 3 + 2] = z;
        }
      }
      field = next;
    }
    for (let vi = 0; vi < n; vi++) {
      const w = weight[vi];
      if (w <= 0) continue;
      const dx = field[vi * 3] * w, dy = field[vi * 3 + 1] * w, dz = field[vi * 3 + 2] * w;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      p[vi * 3] += dx;
      p[vi * 3 + 1] += dy;
      p[vi * 3 + 2] += dz;
      if (round === 0) moved++;
      maxCorrection = Math.max(maxCorrection, len);
    }
  }
  let remaining = 0;
  for (let vi = 0; vi < n; vi++) {
    if (weight[vi] <= 0) continue;
    const d = violation(vi);
    if (d) remaining = Math.max(remaining, d.length());
  }
  return { moved, maxCorrection, remaining };
}

// ---------------------------------------------------------------------------
// colour maps

export type ColorStop = [value: number, color: number];

/** Thickness map colours: red below the minimum, yellow close to it, green above. */
export function thicknessStops(min: number): ColorStop[] {
  return [
    [min - 0.2, 0xd7263d],
    [min - 0.001, 0xd7263d],
    [min, 0xf4a261],
    [min + 0.3, 0xe9c46a],
    [min + 0.6, 0x2a9d8f],
    [min + 2, 0x264653],
  ];
}

/** Contact map colours (like occlusion paper): red = penetration, then orange, yellow, green, grey = far. */
export const CONTACT_STOPS: ColorStop[] = [
  [-0.3, 0x9b0f2a],
  [-0.05, 0xd7263d],
  [0, 0xf4722b],
  [0.05, 0xf4c430],
  [0.15, 0x7fc97f],
  [0.5, 0x6fa8dc],
  [0.51, 0xd9d4c7],
];

function sample(stops: ColorStop[], value: number, out: THREE.Color): THREE.Color {
  if (!Number.isFinite(value) || value >= stops[stops.length - 1][0]) return out.setHex(stops[stops.length - 1][1]);
  if (value <= stops[0][0]) return out.setHex(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const t = (value - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0] || 1);
      return out.setHex(stops[i - 1][1]).lerp(new THREE.Color(stops[i][1]), t);
    }
  }
  return out.setHex(stops[stops.length - 1][1]);
}

/** Write per-vertex colours for the given values onto the geometry. */
export function applyColorMap(geometry: THREE.BufferGeometry, values: Float32Array, stops: ColorStop[]): void {
  const colors = new Float32Array(values.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < values.length; i++) {
    sample(stops, values[i], c);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Wall thickness at every vertex: distance along the inward normal to the
 * opposite surface of the same closed mesh (local space).
 */
export function thicknessValues(geometry: THREE.BufferGeometry): Float32Array {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const bvh = new MeshBVH(geometry, { indirect: true });
  const out = new Float32Array(pos.count).fill(Infinity);
  const ray = new THREE.Ray();
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i).negate();
    ray.origin.copy(p).addScaledVector(n, 1e-3);
    ray.direction.copy(n);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (hit) out[i] = hit.distance + 1e-3;
  }
  return out;
}

/** Signed distance from every vertex (world space) to the nearest obstacle; Infinity when far. */
export function contactValues(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4, obstacles: Obstacle[], range = 0.6): Float32Array {
  const pos = geometry.getAttribute('position');
  const out = new Float32Array(pos.count).fill(Infinity);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(matrixWorld);
    for (const o of obstacles) {
      const s = signedDistance(o, p, range);
      if (s && s.d < out[i]) out[i] = s.d;
    }
  }
  return out;
}
