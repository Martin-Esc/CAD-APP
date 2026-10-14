import * as THREE from 'three';
import { MeshBuilder } from './MeshBuilder';

/**
 * Occlusal splint / nightguard from an arch scan.
 *
 * The scan is rasterised into a height field along the insertion axis (z).
 * Working along a single axis gives undercut block-out for free: the
 * intaglio can only follow what is visible from the occlusal direction, so
 * the appliance always seats along the path of insertion.
 *
 *   q = z · occlusalDir     (q grows toward the opposing arch)
 *   Q(x,y)                  occlusal-most scan surface
 *   intaglio  q_in  = max(Q, Qcut) + gap
 *   occlusal  q_out = flat plane, or smoothed anatomy, ≥ q_in + thickness
 *
 * where Qcut = max(Q) − coverDepth limits how far the guard wraps down the
 * teeth. The covered region is dilated by the wall thickness so the guard
 * extends past the buccal and lingual surfaces.
 */
export interface NightguardParams {
  /** minimum occlusal thickness (mm) */
  thickness: number;
  /** clearance between teeth and intaglio (mm) */
  gap: number;
  /** how far the guard wraps from the cusp tips toward the gingiva (mm) */
  coverDepth: number;
  /** buccal / lingual wall thickness beyond the teeth (mm) */
  wallThickness: number;
  /** height-field resolution (mm per cell) */
  resolution: number;
  /** 'flat' bite plane or 'anatomic' smoothed occlusal surface */
  surface: 'flat' | 'anatomic';
  /** smoothing passes for the outline */
  outlineSmoothing: number;
}

export const DEFAULT_NIGHTGUARD: NightguardParams = {
  thickness: 2.0,
  gap: 0.1,
  coverDepth: 4.5,
  wallThickness: 2.0,
  resolution: 0.4,
  surface: 'flat',
  outlineSmoothing: 4,
};

interface Grid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  res: number;
  q: Float32Array; // -Infinity = no data
}

function rasterize(geometry: THREE.BufferGeometry, dir: 1 | -1, res: number, margin: number): Grid {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  const x0 = bb.min.x - margin;
  const y0 = bb.min.y - margin;
  const nx = Math.ceil((bb.max.x - bb.min.x + 2 * margin) / res);
  const ny = Math.ceil((bb.max.y - bb.min.y + 2 * margin) / res);
  const q = new Float32Array(nx * ny).fill(-Infinity);
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const ax = [0, 0, 0];
  const ay = [0, 0, 0];
  const aq = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = vi(t, k);
      ax[k] = pos.getX(v);
      ay[k] = pos.getY(v);
      aq[k] = pos.getZ(v) * dir;
    }
    const minI = Math.max(0, Math.floor((Math.min(ax[0], ax[1], ax[2]) - x0) / res - 0.5));
    const maxI = Math.min(nx - 1, Math.ceil((Math.max(ax[0], ax[1], ax[2]) - x0) / res - 0.5));
    const minJ = Math.max(0, Math.floor((Math.min(ay[0], ay[1], ay[2]) - y0) / res - 0.5));
    const maxJ = Math.min(ny - 1, Math.ceil((Math.max(ay[0], ay[1], ay[2]) - y0) / res - 0.5));
    const det = (ay[1] - ay[2]) * (ax[0] - ax[2]) + (ax[2] - ax[1]) * (ay[0] - ay[2]);
    if (Math.abs(det) < 1e-12) continue;
    for (let j = minJ; j <= maxJ; j++) {
      const py = y0 + (j + 0.5) * res;
      for (let i = minI; i <= maxI; i++) {
        const px = x0 + (i + 0.5) * res;
        const l0 = ((ay[1] - ay[2]) * (px - ax[2]) + (ax[2] - ax[1]) * (py - ay[2])) / det;
        const l1 = ((ay[2] - ay[0]) * (px - ax[2]) + (ax[0] - ax[2]) * (py - ay[2])) / det;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const value = l0 * aq[0] + l1 * aq[1] + l2 * aq[2];
        const idx = j * nx + i;
        if (value > q[idx]) q[idx] = value;
      }
    }
  }
  return { nx, ny, x0, y0, res, q };
}

function dilate(mask: Uint8Array, nx: number, ny: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const r2 = radius * radius;
  const offsets: [number, number][] = [];
  for (let dj = -Math.ceil(radius); dj <= Math.ceil(radius); dj++)
    for (let di = -Math.ceil(radius); di <= Math.ceil(radius); di++) if (di * di + dj * dj <= r2) offsets.push([di, dj]);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!mask[j * nx + i]) continue;
      for (const [di, dj] of offsets) {
        const a = i + di;
        const b = j + dj;
        if (a >= 0 && b >= 0 && a < nx && b < ny) out[b * nx + a] = 1;
      }
    }
  return out;
}

function erode(mask: Uint8Array, nx: number, ny: number, radius: number): Uint8Array {
  const inv = mask.map((v) => (v ? 0 : 1));
  return dilate(inv, nx, ny, radius).map((v) => (v ? 0 : 1));
}

/** Keep only the largest 4-connected component (drops specks). */
function largestComponent(mask: Uint8Array, nx: number, ny: number): Uint8Array {
  const label = new Int32Array(mask.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  let current = 0;
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    let size = 0;
    stack.push(s);
    label[s] = current;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const i = c % nx;
      const j = (c - i) / nx;
      const nbrs = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
      for (const n of nbrs) {
        if (n >= 0 && mask[n] && label[n] < 0) {
          label[n] = current;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = current;
    }
    current++;
  }
  return mask.map((_, k) => (label[k] === best ? 1 : 0));
}

function blur(values: Float32Array, mask: Uint8Array, nx: number, ny: number, passes: number): Float32Array {
  let src = values;
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(src);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!mask[k]) continue;
        let sum = 0;
        let n = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const a = i + di;
            const b = j + dj;
            if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
            const kk = b * nx + a;
            if (!mask[kk]) continue;
            sum += src[kk];
            n++;
          }
        dst[k] = sum / n;
      }
    src = dst;
  }
  return src;
}

export interface NightguardResult {
  mesh: MeshBuilder;
  /** min / max thickness actually achieved (mm) */
  minThickness: number;
  maxThickness: number;
}

/**
 * @param scan  arch scan in world coordinates (apply the object's matrix first)
 * @param occlusalDir  +1 if the teeth point +z (mandibular), -1 for maxillary
 */
export function buildNightguard(
  scan: THREE.BufferGeometry,
  occlusalDir: 1 | -1,
  params: NightguardParams = DEFAULT_NIGHTGUARD,
): NightguardResult {
  const res = params.resolution;
  const grid = rasterize(scan, occlusalDir, res, params.wallThickness + 2 * res);
  const { nx, ny, x0, y0, q } = grid;
  let qMax = -Infinity;
  for (const v of q) if (v > qMax) qMax = v;
  if (!Number.isFinite(qMax)) throw new Error('Scan is empty');
  const qCut = qMax - params.coverDepth;

  let teeth: Uint8Array = new Uint8Array(nx * ny);
  for (let k = 0; k < q.length; k++) teeth[k] = q[k] > qCut ? 1 : 0;
  teeth = largestComponent(dilate(teeth, nx, ny, 1.5 / res), nx, ny); // bridge interproximal gaps
  let region = dilate(teeth, nx, ny, params.wallThickness / res);
  region = erode(dilate(region, nx, ny, 2), nx, ny, 2); // closing: smooth small notches

  const qIn = new Float32Array(nx * ny);
  for (let k = 0; k < q.length; k++) qIn[k] = Math.max(Number.isFinite(q[k]) ? q[k] : qCut, qCut) + params.gap;

  let qOut: Float32Array;
  if (params.surface === 'flat') {
    let top = -Infinity;
    for (let k = 0; k < q.length; k++) if (region[k] && qIn[k] > top) top = qIn[k];
    qOut = new Float32Array(nx * ny).fill(top + params.thickness);
  } else {
    const smooth = blur(qIn, region, nx, ny, Math.round(3 / res));
    qOut = new Float32Array(nx * ny);
    for (let k = 0; k < q.length; k++) qOut[k] = Math.max(smooth[k], qIn[k]) + params.thickness;
  }

  // corner grid: (nx+1) x (ny+1)
  const cx = nx + 1;
  const inRegion = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && region[j * nx + i] === 1;
  const cornerTop = new Int32Array(cx * (ny + 1)).fill(-1);
  const cornerBottom = new Int32Array(cx * (ny + 1)).fill(-1);
  const cornerXY = new Float64Array(cx * (ny + 1) * 2);
  const mb = new MeshBuilder();

  // boundary-corner smoothing of the outline (keeps top/bottom pairs aligned)
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const c = j * cx + i;
      cornerXY[c * 2] = x0 + i * res;
      cornerXY[c * 2 + 1] = y0 + j * res;
    }
  const boundaryNeighbours = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    if (!boundaryNeighbours.has(a)) boundaryNeighbours.set(a, []);
    if (!boundaryNeighbours.has(b)) boundaryNeighbours.set(b, []);
    boundaryNeighbours.get(a)!.push(b);
    boundaryNeighbours.get(b)!.push(a);
  };
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!inRegion(i, j)) continue;
      if (!inRegion(i + 1, j)) link(j * cx + i + 1, (j + 1) * cx + i + 1);
      if (!inRegion(i - 1, j)) link(j * cx + i, (j + 1) * cx + i);
      if (!inRegion(i, j + 1)) link((j + 1) * cx + i, (j + 1) * cx + i + 1);
      if (!inRegion(i, j - 1)) link(j * cx + i, j * cx + i + 1);
    }
  for (let pass = 0; pass < params.outlineSmoothing; pass++) {
    const next = new Map<number, [number, number]>();
    for (const [c, nb] of boundaryNeighbours) {
      if (nb.length !== 2) continue; // pinch point – leave it
      const x = (cornerXY[c * 2] * 2 + cornerXY[nb[0] * 2] + cornerXY[nb[1] * 2]) / 4;
      const y = (cornerXY[c * 2 + 1] * 2 + cornerXY[nb[0] * 2 + 1] + cornerXY[nb[1] * 2 + 1]) / 4;
      next.set(c, [x, y]);
    }
    for (const [c, [x, y]] of next) {
      cornerXY[c * 2] = x;
      cornerXY[c * 2 + 1] = y;
    }
  }

  const corner = (i: number, j: number, top: boolean): number => {
    const c = j * cx + i;
    const store = top ? cornerTop : cornerBottom;
    if (store[c] >= 0) return store[c];
    let sum = 0;
    let n = 0;
    for (const [a, b] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]] as const) {
      if (!inRegion(a, b)) continue;
      sum += top ? qOut[b * nx + a] : qIn[b * nx + a];
      n++;
    }
    const qv = sum / n;
    store[c] = mb.addVertex(cornerXY[c * 2], cornerXY[c * 2 + 1], qv);
    return store[c];
  };

  let minT = Infinity;
  let maxT = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!inRegion(i, j)) continue;
      const k = j * nx + i;
      if (teeth[k] && q[k] > qCut) {
        const t = qOut[k] - qIn[k];
        minT = Math.min(minT, t);
        maxT = Math.max(maxT, t);
      }
      // top (occlusal) face, CCW seen from +q
      mb.addQuad(corner(i, j, true), corner(i + 1, j, true), corner(i + 1, j + 1, true), corner(i, j + 1, true));
      // bottom (intaglio) face, reversed
      mb.addQuad(corner(i, j, false), corner(i, j + 1, false), corner(i + 1, j + 1, false), corner(i + 1, j, false));
      const wall = (ai: number, aj: number, bi: number, bj: number) =>
        mb.addQuad(corner(ai, aj, false), corner(bi, bj, false), corner(bi, bj, true), corner(ai, aj, true));
      if (!inRegion(i + 1, j)) wall(i + 1, j, i + 1, j + 1);
      if (!inRegion(i - 1, j)) wall(i, j + 1, i, j);
      if (!inRegion(i, j + 1)) wall(i + 1, j + 1, i, j + 1);
      if (!inRegion(i, j - 1)) wall(i, j, i + 1, j);
    }

  // map q back to world z
  for (let v = 2; v < mb.positions.length; v += 3) mb.positions[v] *= occlusalDir;
  if (occlusalDir < 0) mb.flipWinding();
  return { mesh: mb.ensureOutward(), minThickness: minT, maxThickness: maxT };
}
