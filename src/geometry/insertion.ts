import * as THREE from 'three';
import { extractRegion, type Region } from './margin';

/**
 * Insertion axis (path of insertion) tools for prepared teeth.
 *
 * A die face is "undercut" for an insertion axis when its normal points away
 * from the axis: seen from the occlusal side along the axis it is hidden, so a
 * rigid crown sliding along the axis could not follow it. Commercial CAD
 * shows these areas in colour and blocks them out in the intaglio.
 */

interface DieFaces {
  /** face centroids, normals and areas (world space) */
  normals: THREE.Vector3[];
  areas: number[];
  region: Region;
  faces: number[];
}

/** The die surface above the margin (within the margin outline, grown a little). */
function dieFaces(scan: THREE.BufferGeometry, margin: THREE.Vector3[], axis: THREE.Vector3): DieFaces {
  const center = margin.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(margin.length);
  const radius = Math.max(...margin.map((p) => {
    const d = p.clone().sub(center);
    return Math.sqrt(Math.max(0, d.lengthSq() - d.dot(axis) ** 2));
  }));
  const minH = Math.min(...margin.map((p) => p.clone().sub(center).dot(axis)));
  const region = extractRegion(scan, center, axis, radius + 0.15, minH + 0.15, 15);
  // margin height per angular sector: only faces above the margin at their own
  // angle belong to the die (the root / gingiva below a tilted margin does not)
  const u = new THREE.Vector3(1, 0, 0).sub(axis.clone().multiplyScalar(axis.x));
  if (u.lengthSq() < 1e-6) u.set(0, 1, 0).sub(axis.clone().multiplyScalar(axis.y));
  u.normalize();
  const w = new THREE.Vector3().crossVectors(axis, u);
  const SECTORS = 72;
  const sectorH = new Float64Array(SECTORS).fill(NaN);
  const angleOf = (d: THREE.Vector3) => Math.floor(((Math.atan2(d.dot(w), d.dot(u)) / (2 * Math.PI)) + 1) % 1 * SECTORS) % SECTORS;
  for (const p of margin) {
    const d = p.clone().sub(center);
    const s = angleOf(d);
    const h = d.dot(axis);
    sectorH[s] = Number.isNaN(sectorH[s]) ? h : Math.max(sectorH[s], h);
  }
  for (let s = 0; s < SECTORS; s++) {
    if (!Number.isNaN(sectorH[s])) continue;
    let a = s, b = s;
    while (Number.isNaN(sectorH[a])) a = (a + SECTORS - 1) % SECTORS;
    while (Number.isNaN(sectorH[b])) b = (b + 1) % SECTORS;
    sectorH[s] = Math.max(sectorH[a], sectorH[b]);
  }
  const P = region.positions;
  const normals: THREE.Vector3[] = [];
  const areas: number[] = [];
  const faces: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < region.indices.length / 3; t++) {
    a.fromArray(P, region.indices[t * 3] * 3);
    b.fromArray(P, region.indices[t * 3 + 1] * 3);
    c.fromArray(P, region.indices[t * 3 + 2] * 3);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    const area = n.length() / 2;
    if (area < 1e-9) continue;
    const centroid = a.clone().add(b).add(c).divideScalar(3).sub(center);
    if (centroid.dot(axis) < sectorH[angleOf(centroid)] + 0.1) continue;
    normals.push(n.normalize());
    areas.push(area);
    faces.push(t);
  }
  return { normals, areas, region, faces };
}

/** Undercut area (mm²) of the die for an insertion axis. */
function undercutArea(d: DieFaces, axis: THREE.Vector3): number {
  let sum = 0;
  for (let i = 0; i < d.normals.length; i++) if (d.normals[i].dot(axis) < -0.02) sum += d.areas[i];
  return sum;
}

export interface AxisAnalysis {
  axis: THREE.Vector3;
  /** undercut area for this axis (mm²) */
  undercut: number;
  /** tilt from the reference (occlusal) direction, degrees */
  tilt: number;
}

export function analyseAxis(scan: THREE.BufferGeometry, margin: THREE.Vector3[], axis: THREE.Vector3, reference: THREE.Vector3): AxisAnalysis {
  const d = dieFaces(scan, margin, axis);
  return { axis: axis.clone(), undercut: undercutArea(d, axis), tilt: THREE.MathUtils.radToDeg(axis.angleTo(reference)) };
}

/**
 * The insertion axis with the least undercut area, searched in a cone around
 * the reference (occlusal) direction. Ties are resolved toward the reference,
 * so a die without undercuts keeps the occlusal axis.
 */
export function estimateInsertionAxis(scan: THREE.BufferGeometry, margin: THREE.Vector3[], reference: THREE.Vector3, maxTilt = 25): AxisAnalysis {
  const ref = reference.clone().normalize();
  const d = dieFaces(scan, margin, ref);
  const u = new THREE.Vector3(1, 0, 0).sub(ref.clone().multiplyScalar(ref.x));
  if (u.lengthSq() < 1e-6) u.set(0, 1, 0).sub(ref.clone().multiplyScalar(ref.y));
  u.normalize();
  const v = new THREE.Vector3().crossVectors(ref, u);
  let best = { axis: ref.clone(), undercut: undercutArea(d, ref), tilt: 0 };
  const evaluate = (tiltDeg: number, azDeg: number) => {
    const t = THREE.MathUtils.degToRad(tiltDeg);
    const az = THREE.MathUtils.degToRad(azDeg);
    const axis = ref.clone().multiplyScalar(Math.cos(t))
      .addScaledVector(u, Math.sin(t) * Math.cos(az))
      .addScaledVector(v, Math.sin(t) * Math.sin(az))
      .normalize();
    const area = undercutArea(d, axis);
    // prefer smaller undercut; among equals (within 0.01 mm²) the smaller tilt
    if (area < best.undercut - 0.01 || (Math.abs(area - best.undercut) <= 0.01 && tiltDeg < best.tilt)) best = { axis, undercut: area, tilt: tiltDeg };
  };
  for (let tilt = 2.5; tilt <= maxTilt; tilt += 2.5) for (let az = 0; az < 360; az += 15) evaluate(tilt, az);
  // refine around the best direction
  const coarse = best.axis.clone();
  const tilt0 = THREE.MathUtils.radToDeg(coarse.angleTo(ref));
  const proj = coarse.clone().sub(ref.clone().multiplyScalar(coarse.dot(ref)));
  const az0 = proj.lengthSq() > 1e-9 ? THREE.MathUtils.radToDeg(Math.atan2(proj.dot(v), proj.dot(u))) : 0;
  for (let dt = -2; dt <= 2; dt += 0.5) for (let da = -10; da <= 10; da += 2.5) {
    const tilt = tilt0 + dt;
    if (tilt >= 0 && tilt <= maxTilt) evaluate(tilt, az0 + da);
  }
  return { ...best, tilt: THREE.MathUtils.radToDeg(best.axis.angleTo(ref)) };
}

/**
 * The undercut faces of the die as a world-space overlay mesh (lifted 20 µm
 * off the surface so it draws on top).
 */
export function undercutOverlay(scan: THREE.BufferGeometry, margin: THREE.Vector3[], axis: THREE.Vector3): THREE.BufferGeometry {
  const d = dieFaces(scan, margin, axis);
  const P = d.region.positions;
  const out: number[] = [];
  for (let i = 0; i < d.faces.length; i++) {
    if (d.normals[i].dot(axis) >= -0.02) continue;
    const t = d.faces[i];
    for (let k = 0; k < 3; k++) {
      const vi = d.region.indices[t * 3 + k];
      out.push(P[vi * 3] + d.normals[i].x * 0.02, P[vi * 3 + 1] + d.normals[i].y * 0.02, P[vi * 3 + 2] + d.normals[i].z * 0.02);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}
