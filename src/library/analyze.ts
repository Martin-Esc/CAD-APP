import * as THREE from 'three';
import { fdiToUniversal, universalToFdi } from '../core/teeth';

/**
 * Turns a tooth library delivered as an arranged set-up (all teeth in their
 * positions in one coordinate system, one closed mesh per tooth) into
 * per-tooth meshes in the app's local tooth frame:
 *
 *   +x mesiodistal (x = buccal × occlusal, as in core/arch placeTeeth)
 *   +y buccal
 *   +z occlusal, with the cervical line on z = 0
 *
 * Teeth are identified by their POSITION in the set-up, not by file name, so
 * duplicated or mis-numbered files are detected and reported.
 */

export interface LibraryEntry {
  /** source file name, e.g. "UNN14.stl" */
  name: string;
  geometry: THREE.BufferGeometry;
}

export interface ProcessedTooth {
  fdi: number;
  universal: number;
  source: string;
  /** closed mesh in the local tooth frame */
  geometry: THREE.BufferGeometry;
  /** star-shaped outer-surface samples, see SURFACE_ALPHA / SURFACE_STEPS */
  surface: Float32Array;
  mesiodistal: number;
  buccolingual: number;
  /** cervical line to cusp tip / incisal edge */
  height: number;
  /** depth of the closed cervical end below the cervical line (positive) */
  bottom: number;
}

export interface LibraryReport {
  teeth: ProcessedTooth[];
  notes: string[];
}

/** Outer surface samples: SURFACE_ALPHA directions around the axis × SURFACE_STEPS from cervical (s=0) to the top (s=1). */
export const SURFACE_ALPHA = 72;
export const SURFACE_STEPS = 41;

function fileNumber(name: string): number | null {
  const m = name.match(/(\d+)(?=\D*$)/);
  return m ? Number(m[1]) : null;
}

function signature(g: THREE.BufferGeometry): string {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const pos = g.getAttribute('position');
  return [pos.count, ...b.min.toArray(), ...b.max.toArray()].map((v) => Math.round(v * 1000)).join(',');
}

function center(g: THREE.BufferGeometry): THREE.Vector3 {
  g.computeBoundingBox();
  return g.boundingBox!.getCenter(new THREE.Vector3());
}

/** Normal of the best-fit plane through points (smallest principal axis), by power iteration. */
function planeNormal(points: THREE.Vector3[]): THREE.Vector3 {
  const m = points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(points.length);
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const d = p.clone().sub(m).toArray();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i * 3 + j] += d[i] * d[j];
  }
  // smallest eigenvector = largest eigenvector of (trace·I − C)
  const tr = c[0] + c[4] + c[8];
  const shifted = new THREE.Matrix3().fromArray([tr - c[0], -c[1], -c[2], -c[3], tr - c[4], -c[5], -c[6], -c[7], tr - c[8]]);
  let v = new THREE.Vector3(0.3, 0.2, 1).normalize();
  for (let i = 0; i < 200; i++) v = v.applyMatrix3(shifted).normalize();
  return v;
}

/** Order a jaw's teeth along the arch, starting after the posterior opening. */
function archSequence(centers: THREE.Vector3[], n: THREE.Vector3): number[] {
  const m = centers.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(centers.length);
  const e1 = new THREE.Vector3(1, 0, 0).sub(n.clone().multiplyScalar(n.x)).normalize();
  if (e1.lengthSq() < 0.5) e1.set(0, 1, 0).sub(n.clone().multiplyScalar(n.y)).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  const ang = centers.map((p, i) => {
    const d = p.clone().sub(m);
    return { i, a: Math.atan2(d.dot(e2), d.dot(e1)) };
  });
  ang.sort((x, y) => x.a - y.a);
  let gapAt = 0;
  let gap = -1;
  for (let k = 0; k < ang.length; k++) {
    const next = k + 1 < ang.length ? ang[k + 1].a : ang[0].a + Math.PI * 2;
    if (next - ang[k].a > gap) {
      gap = next - ang[k].a;
      gapAt = k;
    }
  }
  return Array.from({ length: ang.length }, (_, k) => ang[(gapAt + 1 + k) % ang.length].i);
}

/**
 * Sample the outer surface of a crown as a star-shaped function seen from a
 * point on its axis: for each direction alpha around the axis, rays sweep
 * from the cervical line (s = 0) up to the top (s = 1); the outermost hit is
 * stored. Used to wrap library crowns onto margins (see LibrarySurface).
 */
export function sampleSurface(geometry: THREE.BufferGeometry, height: number): Float32Array {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  geometry.computeBoundingSphere();
  const ray = new THREE.Raycaster();
  const out = new Float32Array(SURFACE_ALPHA * SURFACE_STEPS * 3);
  const outermost = (origin: THREE.Vector3, dir: THREE.Vector3) => {
    ray.set(origin, dir);
    ray.far = 50;
    const hits = ray.intersectObject(mesh, false);
    return hits.length ? hits[hits.length - 1].point : null;
  };
  // Crown long axis: from the centre of the cervical line to the centre of the
  // occlusal table / incisal edge. Incisors lean labially, so this is not the
  // occlusal direction of the arch.
  const pos = geometry.getAttribute('position');
  const top = new THREE.Vector3();
  let nTop = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > height - 0.6) {
      top.x += pos.getX(i);
      top.y += pos.getY(i);
      top.z += pos.getZ(i);
      nTop++;
    }
  }
  top.divideScalar(Math.max(1, nTop)).setZ(height);
  const cervical = Array.from({ length: SURFACE_ALPHA }, (_, j) => {
    const a = (j / SURFACE_ALPHA) * Math.PI * 2;
    return outermost(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a), Math.sin(a), 0)) ?? new THREE.Vector3(2 * Math.cos(a), 2 * Math.sin(a), 0);
  });
  const base = cervical.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(SURFACE_ALPHA).setZ(0);
  const up = top.clone().sub(base).normalize();
  const C = base.clone().lerp(top, 0.4);
  for (let j = 0; j < SURFACE_ALPHA; j++) {
    const cerv = cervical[j];
    const d0 = cerv.clone().sub(C).normalize();
    const angle = Math.acos(THREE.MathUtils.clamp(d0.dot(up), -1, 1));
    const side = d0.clone().sub(up.clone().multiplyScalar(d0.dot(up))).normalize();
    let prev = cerv;
    for (let k = 0; k < SURFACE_STEPS; k++) {
      const s = k / (SURFACE_STEPS - 1);
      const phi = angle * (1 - s);
      const dir = up.clone().multiplyScalar(Math.cos(phi)).addScaledVector(side, Math.sin(phi));
      const p = k === 0 ? cerv : outermost(C, dir) ?? prev;
      out.set([p.x, p.y, p.z], (j * SURFACE_STEPS + k) * 3);
      prev = p;
    }
  }
  return out;
}

/** Mean radius of the horizontal cross-section at height z (ray casting from the axis). */
function ringRadius(mesh: THREE.Mesh, z: number): number {
  const ray = new THREE.Raycaster();
  let sum = 0;
  let n = 0;
  for (let j = 0; j < 24; j++) {
    const a = (j / 24) * Math.PI * 2;
    ray.set(new THREE.Vector3(0, 0, z), new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
    const hits = ray.intersectObject(mesh, false);
    if (hits.length) {
      sum += hits[hits.length - 1].distance;
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function processLibrary(entries: LibraryEntry[]): LibraryReport {
  const notes: string[] = [];
  // 1. drop exact duplicates
  const seen = new Map<string, string>();
  const unique: LibraryEntry[] = [];
  for (const e of entries) {
    const sig = signature(e.geometry);
    if (seen.has(sig)) {
      notes.push(`${e.name} is an exact duplicate of ${seen.get(sig)} – ignored`);
      continue;
    }
    seen.set(sig, e.name);
    unique.push(e);
  }
  const centers = unique.map((e) => center(e.geometry));
  const n = planeNormal(centers);

  // 2. split into the two jaws along the plane normal (largest gap)
  const q = centers.map((c) => c.dot(n));
  const order = q.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  let split = 1;
  let best = -1;
  for (let k = 1; k < order.length; k++) {
    if (order[k].v - order[k - 1].v > best) {
      best = order[k].v - order[k - 1].v;
      split = k;
    }
  }
  let jawA = order.slice(0, split).map((o) => o.i);
  let jawB = order.slice(split).map((o) => o.i);
  // the maxilla is the group whose files are numbered 1–16 (Universal); fall back to the wider arch
  const upperVotes = (ids: number[]) => ids.filter((i) => (fileNumber(unique[i].name) ?? 99) <= 16).length;
  const spread = (ids: number[]) => {
    const xs = ids.map((i) => centers[i]);
    let d = 0;
    for (const a of xs) for (const b of xs) d = Math.max(d, a.distanceTo(b));
    return d;
  };
  const aIsUpper = upperVotes(jawA) !== upperVotes(jawB) ? upperVotes(jawA) > upperVotes(jawB) : spread(jawA) > spread(jawB);
  if (!aIsUpper) [jawA, jawB] = [jawB, jawA];
  const upperIds = jawA;
  const lowerIds = jawB;
  const mean = (ids: number[]) => ids.reduce((a, i) => a.add(centers[i]), new THREE.Vector3()).divideScalar(ids.length);
  const towardLower = n.clone().multiplyScalar(Math.sign(mean(lowerIds).sub(mean(upperIds)).dot(n)) || 1);

  const teeth: ProcessedTooth[] = [];
  for (const [jaw, ids] of [['upper', upperIds], ['lower', lowerIds]] as const) {
    if (ids.length !== 16) notes.push(`${jaw} jaw has ${ids.length} teeth (expected 16) – numbered from the patient's right along the arch; check the result`);
    const seq = archSequence(ids.map((i) => centers[i]), n).map((k) => ids[k]);
    // anterior: from the midpoint of the two arch ends toward the middle of the arch
    const ends = centers[seq[0]].clone().add(centers[seq[seq.length - 1]]).multiplyScalar(0.5);
    const mid = centers[seq[Math.floor(seq.length / 2)]].clone().add(centers[seq[Math.floor((seq.length - 1) / 2)]]).multiplyScalar(0.5);
    const anterior = mid.sub(ends);
    anterior.sub(n.clone().multiplyScalar(anterior.dot(n))).normalize();
    const headUp = towardLower.clone().negate();
    const right = new THREE.Vector3().crossVectors(anterior, headUp);
    // Universal numbering: upper 1→16 runs right→left, lower 17→32 runs left→right
    const startsRight = centers[seq[0]].clone().sub(centers[seq[seq.length - 1]]).dot(right) > 0;
    const wantRightFirst = jaw === 'upper';
    if (startsRight !== wantRightFirst) seq.reverse();
    const firstUniversal = jaw === 'upper' ? 1 : 17;
    const occlusal = jaw === 'upper' ? towardLower.clone() : towardLower.clone().negate();
    const jawCenter = mean(ids);

    seq.forEach((id, k) => {
      if (k > 15) return;
      const fdi = universalToFdi(firstUniversal + k);
      const file = unique[id];
      const num = fileNumber(file.name);
      if (num !== null && num !== fdiToUniversal(fdi)) notes.push(`${file.name} sits at Universal #${fdiToUniversal(fdi)} (FDI ${fdi}) – numbered by position`);

      // local frame
      const prev = centers[seq[Math.max(0, k - 1)]];
      const next = centers[seq[Math.min(seq.length - 1, k + 1)]];
      const tangent = next.clone().sub(prev);
      tangent.sub(occlusal.clone().multiplyScalar(tangent.dot(occlusal))).normalize();
      let buccal = new THREE.Vector3().crossVectors(occlusal, tangent).normalize();
      if (buccal.dot(centers[id].clone().sub(jawCenter)) < 0) buccal.negate();
      const xAxis = new THREE.Vector3().crossVectors(buccal, occlusal).normalize();
      buccal = new THREE.Vector3().crossVectors(occlusal, xAxis).normalize();
      const rot = new THREE.Matrix4().makeBasis(xAxis, buccal, occlusal);
      const toLocal = rot.clone().transpose().multiply(new THREE.Matrix4().makeTranslation(-centers[id].x, -centers[id].y, -centers[id].z));
      const g = file.geometry.clone().applyMatrix4(toLocal);
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      // re-centre on the bounding box (x, y) and the bottom (z)
      g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
      g.computeBoundingBox();
      const total = g.boundingBox!.max.z;
      // cervical line: lowest height where the cross-section reaches 75 % of its maximum below mid-crown
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      const radii: { z: number; r: number }[] = [];
      for (let z = 0.05; z < total * 0.6; z += total / 60) radii.push({ z, r: ringRadius(mesh, z) });
      const rMax = Math.max(...radii.map((x) => x.r));
      const zc = radii.find((x) => x.r >= 0.75 * rMax)?.z ?? total * 0.1;
      g.translate(0, 0, -zc);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const size = g.boundingBox!.getSize(new THREE.Vector3());
      const height = g.boundingBox!.max.z;
      teeth.push({
        fdi,
        universal: fdiToUniversal(fdi),
        source: file.name,
        geometry: g,
        surface: sampleSurface(g, height),
        mesiodistal: size.x,
        buccolingual: size.y,
        height,
        bottom: zc,
      });
    });
  }
  teeth.sort((a, b) => a.universal - b.universal);
  return { teeth, notes };
}
