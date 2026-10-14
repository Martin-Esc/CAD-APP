import * as THREE from 'three';

/**
 * Margin (finish line) tools for scanned preparations.
 *
 * All functions take the scan in world coordinates plus a tooth frame:
 *   origin  a point on the tooth's long axis (the arch placement)
 *   axis    insertion / occlusal direction
 */

export const MARGIN_SAMPLES = 72;

/** Orthonormal basis (u, v, axis) for polar angles around the axis. */
export function axisBasis(axis: THREE.Vector3, hint = new THREE.Vector3(1, 0, 0)): [THREE.Vector3, THREE.Vector3] {
  const u = hint.clone().sub(axis.clone().multiplyScalar(hint.dot(axis)));
  if (u.lengthSq() < 1e-6) u.set(0, 1, 0).sub(axis.clone().multiplyScalar(axis.y));
  u.normalize();
  const v = new THREE.Vector3().crossVectors(axis, u);
  return [u, v];
}

export interface Region {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  /** vertex adjacency */
  neighbours: number[][];
}

/**
 * Copy the part of the scan inside a cylinder around the tooth axis, as an
 * indexed mesh with vertex normals and adjacency. Keeps margin detection and
 * die ray casting fast on full-arch scans with hundreds of thousands of
 * triangles.
 */
export function extractRegion(
  scan: THREE.BufferGeometry,
  origin: THREE.Vector3,
  axis: THREE.Vector3,
  radius: number,
  hMin: number,
  hMax: number,
): Region {
  const pos = scan.getAttribute('position');
  const index = scan.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const inside = new Int8Array(pos.count); // 0 unknown, 1 in, -1 out
  const p = new THREE.Vector3();
  const test = (v: number) => {
    if (inside[v] === 0) {
      p.fromBufferAttribute(pos, v).sub(origin);
      const h = p.dot(axis);
      const r2 = p.lengthSq() - h * h;
      inside[v] = h >= hMin && h <= hMax && r2 <= radius * radius ? 1 : -1;
    }
    return inside[v] === 1;
  };
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
    if (!(test(a) && test(b) && test(c))) continue;
    for (const v of [a, b, c]) {
      let id = remap.get(v);
      if (id === undefined) {
        id = positions.length / 3;
        remap.set(v, id);
        positions.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      }
      indices.push(id);
    }
  }
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  const neighbourSets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const wx = positions[c * 3] - positions[a * 3], wy = positions[c * 3 + 1] - positions[a * 3 + 1], wz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const v of [a, b, c]) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
    }
    neighbourSets[a].add(b).add(c);
    neighbourSets[b].add(a).add(c);
    neighbourSets[c].add(a).add(b);
  }
  for (let i = 0; i < n; i++) {
    const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    normals[i * 3] /= len;
    normals[i * 3 + 1] /= len;
    normals[i * 3 + 2] /= len;
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals,
    neighbours: neighbourSets.map((s) => [...s]),
  };
}

export interface DetectOptions {
  /** search radius around the axis (mm) */
  radius?: number;
  /** max crease angle crossed while growing over the die (degrees) */
  creaseAngle?: number;
  /** the seed is the highest vertex within this distance of the axis (mm) */
  seedRadius?: number;
}

/**
 * Automatic margin detection.
 *
 * 1. Seed on the occlusal top of the prep (highest point near the axis).
 * 2. Grow a region over the die. Growth stops at sharp creases, at surfaces
 *    facing back toward the tooth (gingival sulcus) and at strongly
 *    downward-facing surfaces (ditch / root below the finish line).
 * 3. In each of 72 angular sectors the margin is the region's outermost
 *    point: the die is widest at its finish line, because the walls
 *    converge occlusally and the die narrows again below the margin.
 * 4. Fill empty sectors and smooth the loop.
 *
 * Works on ditched dies and on most full-arch scans with visible margins.
 * Subgingival or blood-obscured margins need manual drawing / editing.
 */
export function detectMargin(
  scan: THREE.BufferGeometry,
  origin: THREE.Vector3,
  axis: THREE.Vector3,
  opts: DetectOptions = {},
): THREE.Vector3[] {
  const radius = opts.radius ?? 7;
  const crease = Math.cos(THREE.MathUtils.degToRad(opts.creaseAngle ?? 55));
  const seedRadius = opts.seedRadius ?? 2.5;
  const region = extractRegion(scan, origin, axis, radius, -8, 14);
  const n = region.positions.length / 3;
  if (!n) throw new Error('No scan surface near this tooth');
  const P = (i: number) => new THREE.Vector3(region.positions[i * 3], region.positions[i * 3 + 1], region.positions[i * 3 + 2]);
  const N = (i: number) => new THREE.Vector3(region.normals[i * 3], region.normals[i * 3 + 1], region.normals[i * 3 + 2]);
  const heightOf = (i: number) => P(i).sub(origin).dot(axis);
  const radialDir = (i: number) => {
    const d = P(i).sub(origin);
    d.sub(axis.clone().multiplyScalar(d.dot(axis)));
    return d.lengthSq() > 1e-9 ? d.normalize() : d;
  };

  let seed = -1;
  let best = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = P(i).sub(origin);
    const h = d.dot(axis);
    const r = Math.sqrt(Math.max(0, d.lengthSq() - h * h));
    if (r <= seedRadius && h > best) {
      best = h;
      seed = i;
    }
  }
  if (seed < 0) throw new Error('Could not find the preparation near the tooth axis');

  const inRegion = new Uint8Array(n);
  inRegion[seed] = 1;
  const queue = [seed];
  while (queue.length) {
    const a = queue.pop()!;
    const na = N(a);
    for (const b of region.neighbours[a]) {
      if (inRegion[b]) continue;
      const nb = N(b);
      if (na.dot(nb) < crease) continue; // sharp crease
      if (nb.dot(axis) < -0.55) continue; // facing down: below the finish line
      if (nb.dot(radialDir(b)) < -0.2) continue; // facing the tooth: sulcus / adjacent gingiva
      inRegion[b] = 1;
      queue.push(b);
    }
  }

  const [u, v] = axisBasis(axis);
  const sectors: (THREE.Vector3 | null)[] = new Array(MARGIN_SAMPLES).fill(null);
  const sectorR = new Array(MARGIN_SAMPLES).fill(-Infinity);
  const top = heightOf(seed);
  for (let i = 0; i < n; i++) {
    if (!inRegion[i]) continue;
    const d = P(i).sub(origin);
    const h = d.dot(axis);
    if (h > top - 1) continue; // ignore the occlusal table
    const x = d.dot(u);
    const y = d.dot(v);
    const r = Math.hypot(x, y);
    const s = Math.floor(((Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI)) / ((2 * Math.PI) / MARGIN_SAMPLES)) % MARGIN_SAMPLES;
    // prefer the outermost point; break near-ties toward the lower point
    const score = r - 0.05 * h;
    if (score > sectorR[s]) {
      sectorR[s] = score;
      sectors[s] = P(i);
    }
  }
  const filled = sectors.filter((p) => p !== null).length;
  if (filled < MARGIN_SAMPLES / 3) throw new Error('Margin not found – draw it manually');
  // fill empty sectors by interpolating between the nearest filled ones
  const pts: THREE.Vector3[] = sectors.map((p, s) => {
    if (p) return p;
    let a = s, b = s, da = 0, db = 0;
    while (!sectors[a]) { a = (a - 1 + MARGIN_SAMPLES) % MARGIN_SAMPLES; da++; }
    while (!sectors[b]) { b = (b + 1) % MARGIN_SAMPLES; db++; }
    return sectors[a]!.clone().lerp(sectors[b]!, da / (da + db));
  });
  return smoothLoop(pts, 2);
}

/** Circular moving-average smoothing of a closed loop. */
export function smoothLoop(points: THREE.Vector3[], passes = 1): THREE.Vector3[] {
  let pts = points.map((p) => p.clone());
  const n = pts.length;
  for (let k = 0; k < passes; k++) {
    pts = pts.map((_, i) => {
      const acc = new THREE.Vector3();
      for (let d = -2; d <= 2; d++) acc.add(pts[(i + d + n) % n]);
      return acc.divideScalar(5);
    });
  }
  return pts;
}

/**
 * Resample any closed margin loop (detected, drawn or edited) to
 * MARGIN_SAMPLES points at regular polar angles around the axis, ordered
 * counter-clockwise when seen from the occlusal side.
 */
export function resampleByAngle(points: THREE.Vector3[], origin: THREE.Vector3, axis: THREE.Vector3, count = MARGIN_SAMPLES): THREE.Vector3[] {
  if (points.length < 3) throw new Error('A margin needs at least 3 points');
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  const dense = curve.getSpacedPoints(count * 12).slice(0, -1);
  const center = dense.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(dense.length);
  const c = center.clone().sub(axis.clone().multiplyScalar(center.clone().sub(origin).dot(axis)));
  const [u, v] = axisBasis(axis);
  const angleOf = (p: THREE.Vector3) => {
    const d = p.clone().sub(c);
    return (Math.atan2(d.dot(v), d.dot(u)) + 2 * Math.PI) % (2 * Math.PI);
  };
  const angles = dense.map(angleOf);
  const out: THREE.Vector3[] = [];
  for (let j = 0; j < count; j++) {
    const target = (j / count) * Math.PI * 2;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < dense.length; i++) {
      let d = Math.abs(angles[i] - target);
      d = Math.min(d, 2 * Math.PI - d);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    out.push(dense[bestI].clone());
  }
  return out;
}

/** Evenly spaced control points of a margin loop, for editing. */
export function controlPoints(margin: THREE.Vector3[], count = 24): THREE.Vector3[] {
  const step = margin.length / count;
  return Array.from({ length: count }, (_, i) => margin[Math.floor(i * step)].clone());
}
