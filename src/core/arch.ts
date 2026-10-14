import * as THREE from 'three';
import { archOrder, getTooth, type Jaw } from './teeth';

/**
 * Dental arch model.
 *
 * World frame (Z-up):  +x patient's left, +y anterior, +z up.
 * The lower arch's margins sit on z = 0 with crowns pointing +z; the upper
 * arch's margins sit on z = UPPER_MARGIN_Z with crowns pointing -z, so the
 * two dentitions meet around the occlusal plane.
 */
export const UPPER_MARGIN_Z = 17;

export interface ArchDefinition {
  jaw: Jaw;
  /** control points from the patient's right distal end to the left distal end */
  points: THREE.Vector3[];
  /** z of the margin plane (or occlusal level when fitted to a scan) */
  marginZ: number;
  /** direction of the crowns along z: +1 lower, -1 upper */
  occlusalDir: 1 | -1;
}

export interface ToothPlacement {
  fdi: number;
  /** local tooth frame -> world */
  matrix: THREE.Matrix4;
  center: THREE.Vector3;
  tangent: THREE.Vector3;
  buccal: THREE.Vector3;
}

/** Half arch length needed for all 8 teeth of a quadrant plus contact allowance. */
function halfArchLength(jaw: Jaw): number {
  let sum = 0;
  for (let p = 1; p <= 8; p++) sum += getTooth((jaw === 'upper' ? 10 : 40) + p).mesiodistal;
  return sum;
}

/**
 * Default arch form: a blend of a parabola anteriorly and straighter
 * posterior segments (a rough Bonwill-Hawley shape), scaled so that the arc
 * length fits the average tooth widths of the jaw.
 */
export function defaultArch(jaw: Jaw): ArchDefinition {
  const width = jaw === 'upper' ? 27 : 25;
  const depth = jaw === 'upper' ? 44 : 40;
  const base: THREE.Vector3[] = [];
  const n = 11;
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * 2 - 1; // -1 (right) .. 1 (left)
    const x = width * Math.sin((s * Math.PI) / 2.15);
    const y = depth * (1 - Math.pow(Math.abs(s), 1.7)) - depth * 0.55;
    base.push(new THREE.Vector3(x, y, 0));
  }
  // scale to the required arch length
  const target = halfArchLength(jaw) * 2 + 1;
  const curve = new THREE.CatmullRomCurve3(base, false, 'centripetal');
  const k = target / curve.getLength();
  const points = base.map((p) => p.clone().multiplyScalar(k));
  return {
    jaw,
    points,
    marginZ: jaw === 'upper' ? UPPER_MARGIN_Z : 0,
    occlusalDir: jaw === 'upper' ? -1 : 1,
  };
}

export function archCurve(arch: ArchDefinition): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(arch.points, false, 'centripetal');
}

/** Arc-length parameter (0..1) of the arch midline (x = 0 crossing). */
function midlineU(curve: THREE.CatmullRomCurve3): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (curve.getPointAt(mid).x < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Place teeth along the arch. Each tooth gets a local -> world matrix
 * mapping local +x to the arch tangent, +y to buccal and +z to occlusal.
 * `widthScale` lets callers compress or expand the setup.
 */
export function placeTeeth(arch: ArchDefinition, widthScale = 1): Map<number, ToothPlacement> {
  const curve = archCurve(arch);
  const length = curve.getLength();
  const u0 = midlineU(curve);
  const order = archOrder(arch.jaw);
  const centroid = arch.points.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(arch.points.length);
  const result = new Map<number, ToothPlacement>();

  const place = (fdi: number, dist: number) => {
    const u = THREE.MathUtils.clamp(u0 + dist / length, 0, 1);
    const p = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u).setZ(0).normalize();
    let buccal = new THREE.Vector3(tangent.y, -tangent.x, 0);
    if (buccal.dot(p.clone().sub(centroid).setZ(0)) < 0) buccal.negate();
    const up = new THREE.Vector3(0, 0, arch.occlusalDir);
    let xAxis = tangent.clone();
    if (new THREE.Vector3().crossVectors(xAxis, buccal).dot(up) < 0) xAxis.negate();
    const center = new THREE.Vector3(p.x, p.y, arch.marginZ);
    const matrix = new THREE.Matrix4().makeBasis(xAxis, buccal, up).setPosition(center);
    result.set(fdi, { fdi, matrix, center, tangent, buccal });
  };

  const mid = order.length / 2;
  // right side, walking distally from the midline (negative direction)
  let dist = 0;
  for (let i = mid - 1; i >= 0; i--) {
    const w = getTooth(order[i]).mesiodistal * widthScale;
    place(order[i], -(dist + w / 2));
    dist += w;
  }
  dist = 0;
  for (let i = mid; i < order.length; i++) {
    const w = getTooth(order[i]).mesiodistal * widthScale;
    place(order[i], dist + w / 2);
    dist += w;
  }
  return result;
}

/** Build an arch definition from points picked on a scan (right -> left). */
export function archFromPicks(jaw: Jaw, picks: THREE.Vector3[], occlusalDir: 1 | -1, crownHeight = 8): ArchDefinition {
  if (picks.length < 3) throw new Error('Pick at least 3 points along the arch');
  const sorted = [...picks];
  if (sorted[0].x > sorted[sorted.length - 1].x) sorted.reverse();
  const z = sorted.reduce((s, p) => s + p.z, 0) / sorted.length;
  return {
    jaw,
    points: sorted.map((p) => new THREE.Vector3(p.x, p.y, 0)),
    // picks are made on cusp tips; margins are a crown height away
    marginZ: z - occlusalDir * crownHeight,
    occlusalDir,
  };
}
