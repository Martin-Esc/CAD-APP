import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { MeshBuilder } from './MeshBuilder';
import { ToothSurface, type OuterSurface, type PrepParams, type ToothShape } from './toothShape';
import { extractRegion, resampleByAngle, MARGIN_SAMPLES } from './margin';

/**
 * Crown fitted to a scanned die.
 *
 *  - Intaglio: the die surface inside the margin line, sampled by ray casting
 *    from a point inside the die. Undercuts along the insertion axis are
 *    blocked out (the die may not widen toward occlusal), then the surface is
 *    offset along its normal by cement gap + extra spacing. As in exocad's
 *    cement gap dialog, the gap starts a set distance from the margin line
 *    and ramps up over a transition length.
 *  - Outer surface: the library tooth, scaled to the margin size and warped so
 *    that its cervical ring lands exactly on the margin line. The warp fades
 *    out by 45 % of the wall height.
 *  - Minimum thickness: every outer point is pushed outward until it is at
 *    least the axial / occlusal thickness away from the die.
 *
 * Intaglio and outer surface share the margin vertices, so the shell is
 * closed and the margin of the crown is exactly the drawn / detected line.
 */
export interface DieCrownResult {
  /** crown shell in world space */
  mesh: MeshBuilder;
  /** closed solid filling the intaglio (inset 20 µm), for bridge booleans */
  cavity: MeshBuilder;
  /** local tooth frame -> world (origin at the margin centroid) */
  frame: THREE.Matrix4;
  height: number;
  /** thinnest wall found outside the margin zone (mm) */
  minThickness: number;
  /** deepest undercut that was blocked out (mm, 0 = none) */
  blockedOut: number;
  /** number of vertices of the outer surface (they come first in `mesh`, margin ring included) */
  outerVertexCount: number;
  /** vertex count of the margin ring (the first vertices of `mesh`) */
  marginVertexCount: number;
}

const INTAGLIO_RINGS = 16;
/**
 * The bridge-boolean cavity stays this far inside the intaglio, so it never
 * touches the crown surface (touching surfaces leave sliver triangles that
 * break the mesh once rounded to float32 in an STL). It only has to clear
 * connector material, which never comes this close to the intaglio.
 */
export const CAVITY_INSET = 0.02;
const WALL_RINGS = 12;
const CAP_RINGS = 8;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * @param scan    scan in world space (only the region around the margin is used)
 * @param margin  closed margin loop in world space (any number of points)
 * @param basis   local -> world rotation of the tooth (x mesiodistal, y buccal, z occlusal)
 */
export function buildDieCrown(
  scan: THREE.BufferGeometry,
  margin: THREE.Vector3[],
  basis: THREE.Matrix4,
  /** procedural tooth shape, or any outer surface (e.g. a scanned library tooth) */
  outerSurface: ToothShape | OuterSurface,
  prep: PrepParams,
): DieCrownResult {
  const centroid = margin.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(margin.length);
  const frame = basis.clone().setPosition(centroid);
  const toLocal = frame.clone().invert();
  const axisWorld = new THREE.Vector3(0, 0, 1).transformDirection(frame);
  const Z = new THREE.Vector3(0, 0, 1);

  const m = resampleByAngle(
    margin.map((p) => p.clone().applyMatrix4(toLocal)),
    new THREE.Vector3(),
    Z,
    MARGIN_SAMPLES,
  );
  const N = m.length;
  const maxR = Math.max(...m.map((p) => Math.hypot(p.x, p.y)));
  const minZ = Math.min(...m.map((p) => p.z));
  const zm = m.reduce((s, p) => s + p.z, 0) / N;

  // the die, in the local frame, for ray casting
  const region = extractRegion(scan, centroid, axisWorld, maxR + 1.5, minZ - 1.5, 16);
  if (!region.indices.length) throw new Error('No scan surface inside the margin');
  const dieGeometry = new THREE.BufferGeometry();
  dieGeometry.setAttribute('position', new THREE.BufferAttribute(region.positions.slice(), 3));
  dieGeometry.setIndex(new THREE.BufferAttribute(region.indices, 1));
  dieGeometry.applyMatrix4(toLocal);
  dieGeometry.computeBoundingSphere();
  const die = new THREE.Mesh(dieGeometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const ray = new THREE.Raycaster();
  const cast = (origin: THREE.Vector3, dir: THREE.Vector3): { point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null => {
    ray.set(origin, dir);
    ray.far = 25;
    const hit = ray.intersectObject(die, false)[0];
    if (!hit || !hit.face) return null;
    const normal = hit.face.normal.clone();
    if (normal.dot(hit.point.clone().sub(origin)) < 0) normal.negate();
    return { point: hit.point, normal, distance: hit.distance };
  };

  const top0 = cast(new THREE.Vector3(0, 0, zm + 0.5), Z);
  if (!top0) throw new Error('No die surface above the margin – is the margin on the prep?');
  const O = new THREE.Vector3(0, 0, zm + 0.4 * (top0.point.z - zm));
  const pole = cast(O, Z) ?? top0;

  // ---- intaglio ---------------------------------------------------------
  const transition = prep.gapTransition ?? 0.5;
  const fullGap = prep.cementGap + (prep.extraSpacing ?? 0);
  const gapAt = (s: number) => fullGap * smoothstep(prep.marginSeal, prep.marginSeal + transition, s);
  const blockOut = prep.blockOut ?? true;
  const radiusLimit = m.map((p) => Math.hypot(p.x, p.y));
  let blockedOut = 0;
  const intaglio: THREE.Vector3[][] = [];
  const cavityRings: THREE.Vector3[][] = [];
  const arc = m.map(() => 0);
  let prevRing = m.map((p) => p.clone());
  for (let k = 1; k < INTAGLIO_RINGS; k++) {
    const ring: THREE.Vector3[] = [];
    const cavity: THREE.Vector3[] = [];
    for (let j = 0; j < N; j++) {
      const d0 = m[j].clone().sub(O).normalize();
      const horizontal = d0.clone().setZ(0).normalize();
      const theta = Math.acos(THREE.MathUtils.clamp(d0.z, -1, 1)) * (1 - k / INTAGLIO_RINGS);
      const dir = Z.clone().multiplyScalar(Math.cos(theta)).addScaledVector(horizontal, Math.sin(theta));
      const hit = cast(O, dir);
      const p = hit ? hit.point.clone() : O.clone().addScaledVector(dir, prevRing[j].distanceTo(O));
      let normal = hit ? hit.normal : dir;
      if (blockOut) {
        // seen along the insertion axis (+z) the die may not get wider going up
        const r = Math.hypot(p.x, p.y);
        if (r > radiusLimit[j] + 1e-6 && p.z >= prevRing[j].z - 1e-6) {
          blockedOut = Math.max(blockedOut, r - radiusLimit[j]);
          p.x *= radiusLimit[j] / r;
          p.y *= radiusLimit[j] / r;
          normal = new THREE.Vector3(p.x, p.y, 0).normalize(); // blocked wall is vertical
        } else {
          radiusLimit[j] = Math.min(radiusLimit[j], r);
        }
      }
      arc[j] += p.distanceTo(prevRing[j]);
      const g = gapAt(arc[j]);
      ring.push(p.clone().addScaledVector(normal, g));
      cavity.push(p.clone().addScaledVector(normal, g - CAVITY_INSET));
      prevRing[j] = p;
    }
    intaglio.push(ring);
    cavityRings.push(cavity);
  }
  const poleGap = gapAt(arc.reduce((a, b) => a + b, 0) / N + 1);
  const poleIn = pole.point.clone().addScaledVector(pole.normal, poleGap);

  // ---- outer surface ----------------------------------------------------
  const marginW = Math.max(...m.map((p) => p.x)) - Math.min(...m.map((p) => p.x));
  const marginB = Math.max(...m.map((p) => p.y)) - Math.min(...m.map((p) => p.y));
  const base: OuterSurface = 'kind' in outerSurface ? new ToothSurface(outerSurface) : outerSurface;
  const [a0, b0] = base.semiAxes(0);
  const sx = THREE.MathUtils.clamp((marginW / 2 + prep.marginThickness) / a0, 0.75, 1.35);
  const sy = THREE.MathUtils.clamp((marginB / 2 + prep.marginThickness) / b0, 0.75, 1.35);
  const surface = base.scaled(sx, sy);
  const lift = new THREE.Vector3(0, 0, zm);

  const outer: THREE.Vector3[][] = [];
  for (let k = 1; k <= WALL_RINGS; k++) {
    const t = k / WALL_RINGS;
    const w = smoothstep(0, 0.45, t);
    const ramp = Math.min(1, t / 0.08);
    outer.push(
      m.map((mj, j) => {
        const alpha = (j / N) * Math.PI * 2;
        const lib = surface.wallPointAt(alpha, t).add(lift);
        const lib0 = surface.wallPointAt(alpha, 0).add(lift);
        const radial = new THREE.Vector3(Math.cos(alpha), Math.sin(alpha), 0);
        return lib.addScaledVector(mj.clone().sub(lib0), 1 - w).addScaledVector(radial, prep.marginThickness * (1 - w) * ramp);
      }),
    );
  }
  for (let k = 1; k < CAP_RINGS; k++) {
    const r = 1 - k / CAP_RINGS;
    outer.push(m.map((_, j) => surface.capPointAt((j / N) * Math.PI * 2, r).add(lift)));
  }
  const outerCenter = surface.topPoint().add(lift);

  // minimum thickness: push outer points away from the die along rays from O
  let minThickness = Infinity;
  const enforce = (p: THREE.Vector3, mj: THREE.Vector3 | null) => {
    const d = p.clone().sub(O);
    const dist = d.length();
    const dir = d.divideScalar(dist);
    const hit = cast(O, dir);
    if (!hit) return;
    const occlusal = smoothstep(0.3, 0.8, dir.z);
    const fromMargin = mj ? p.distanceTo(mj) : Infinity;
    const zone = Math.min(1, fromMargin / 1.2);
    const need = (prep.axialThickness * (1 - occlusal) + prep.occlusalThickness * occlusal) * zone;
    const required = hit.distance + fullGap + need;
    if (dist < required) p.copy(O).addScaledVector(dir, required);
  };
  outer.forEach((ring, k) => ring.forEach((p, j) => enforce(p, k < WALL_RINGS ? m[j] : null)));
  enforce(outerCenter, null);

  // Second pass: wall thickness is the distance to the nearest point of the
  // actual intaglio (gap and block-out included), measured perpendicular to the
  // surface. The ray pass above can leave sloped walls too thin.
  const innerMb = new MeshBuilder();
  let innerPrev = innerMb.addRing(m);
  for (const ring of intaglio) {
    const ids = innerMb.addRing(ring);
    innerMb.stitchRings(ids, innerPrev);
    innerPrev = ids;
  }
  innerMb.fan(innerMb.addPoint(poleIn), innerPrev, true);
  const innerBvh = new MeshBVH(innerMb.toGeometry());
  const closest = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const enforceNormal = (p: THREE.Vector3, mj: THREE.Vector3 | null, record: boolean) => {
    if (!innerBvh.closestPointToPoint(p, closest)) return;
    const dir = p.clone().sub(closest.point);
    const dist = dir.length();
    if (dist < 1e-9) return;
    dir.divideScalar(dist);
    const occlusal = smoothstep(0.3, 0.8, dir.z);
    const fromMargin = mj ? p.distanceTo(mj) : Infinity;
    const zone = Math.min(1, fromMargin / 1.2);
    const need = (prep.axialThickness * (1 - occlusal) + prep.occlusalThickness * occlusal) * zone;
    if (dist < need) p.copy(closest.point).addScaledVector(dir, need);
    if (record && zone >= 1) minThickness = Math.min(minThickness, Math.max(dist, need));
  };
  for (let pass = 0; pass < 3; pass++) {
    const last = pass === 2;
    outer.forEach((ring, k) => ring.forEach((p, j) => enforceNormal(p, k < WALL_RINGS ? m[j] : null, last)));
    enforceNormal(outerCenter, null, last);
  }

  // ---- assemble -----------------------------------------------------------
  const mb = new MeshBuilder();
  const marginIds = mb.addRing(m);
  let prev = marginIds;
  for (const ring of outer) {
    const ids = mb.addRing(ring);
    mb.stitchRings(prev, ids);
    prev = ids;
  }
  mb.fan(mb.addPoint(outerCenter), prev);
  prev = marginIds;
  for (const ring of intaglio) {
    const ids = mb.addRing(ring);
    mb.stitchRings(ids, prev);
    prev = ids;
  }
  mb.fan(mb.addPoint(poleIn), prev, true);
  mb.ensureOutward().transform(frame);

  const cav = new MeshBuilder();
  const inset = (p: THREE.Vector3, z: number) => {
    const r = Math.hypot(p.x, p.y);
    const k = Math.max(0, r - 0.1) / r;
    return new THREE.Vector3(p.x * k, p.y * k, z);
  };
  const cavBottom = cav.addRing(m.map((p) => inset(p, minZ - 3)));
  const cavMargin = cav.addRing(m.map((p) => inset(p, p.z)));
  cav.stitchRings(cavBottom, cavMargin);
  prev = cavMargin;
  for (const ring of cavityRings) {
    const ids = cav.addRing(ring);
    cav.stitchRings(prev, ids);
    prev = ids;
  }
  cav.fan(cav.addPoint(pole.point.clone().addScaledVector(pole.normal, poleGap - CAVITY_INSET)), prev);
  cav.fan(cav.addVertex(0, 0, minZ - 3), cavBottom, true);
  cav.ensureOutward().transform(frame);

  dieGeometry.dispose();
  return {
    mesh: mb,
    cavity: cav,
    frame,
    height: surface.height,
    minThickness: Number.isFinite(minThickness) ? minThickness : 0,
    blockedOut,
    outerVertexCount: N * (1 + outer.length) + 1,
    marginVertexCount: N,
  };
}

/**
 * How freely each crown vertex may be moved by contact adaptation: 0 for the
 * margin, the cervical third of the wall and the intaglio; ramping to 1 on
 * the upper wall (proximal contacts) and the occlusal table.
 */
export function adaptWeights(r: DieCrownResult): Float32Array {
  const w = new Float32Array(r.mesh.vertexCount);
  const N = r.marginVertexCount;
  for (let i = N; i < r.outerVertexCount; i++) {
    const ring = Math.floor((i - N) / N);
    if (ring < WALL_RINGS) {
      const t = (ring + 1) / WALL_RINGS;
      w[i] = smoothstep(0.3, 0.6, t);
    } else {
      w[i] = 1;
    }
  }
  return w;
}
