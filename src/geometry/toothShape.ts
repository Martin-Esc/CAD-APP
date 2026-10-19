import * as THREE from 'three';
import { MeshBuilder } from './MeshBuilder';
import type { ToothInfo, ToothKind } from '../core/teeth';

/**
 * Procedural tooth library.
 *
 * Every tooth is built in a local frame:
 *   +x  mesiodistal (along the arch)
 *   +y  buccal / labial
 *   +z  occlusal / incisal
 * with the margin (cemento-enamel junction) on the z = 0 plane.
 *
 * The crown is a loft of superellipse cross-sections (the axial walls,
 * bulging at the height of contour) capped by an occlusal height field with
 * Gaussian cusps. It is not a scanned anatomical library, but it is
 * parametric, watertight and close enough to real anatomy to drive the
 * design workflows. A scanned library can replace it later (see ROADMAP).
 */

export interface ToothShape {
  kind: ToothKind;
  jaw: 'upper' | 'lower';
  /** mesiodistal width at height of contour (mm) */
  mesiodistal: number;
  /** buccolingual width at height of contour (mm) */
  buccolingual: number;
  /** total crown height from margin to cusp tip (mm) */
  height: number;
}

export interface PrepParams {
  /** crown thickness at the margin (mm) – chamfer depth */
  marginThickness: number;
  /** minimum axial wall thickness (mm) */
  axialThickness: number;
  /** minimum occlusal thickness (mm) */
  occlusalThickness: number;
  /** total occlusal convergence angle of the preparation (degrees) */
  taper: number;
  /** cement spacer (mm) */
  cementGap: number;
  /** height from the margin over which no cement gap is applied (mm) */
  marginSeal: number;
}

export const DEFAULT_PREP: PrepParams = {
  marginThickness: 0.6,
  axialThickness: 1.0,
  occlusalThickness: 1.5,
  taper: 12,
  cementGap: 0.05,
  marginSeal: 1.0,
};

export function shapeFromTooth(info: ToothInfo, scale = 1): ToothShape {
  return {
    kind: info.kind,
    jaw: info.jaw,
    mesiodistal: info.mesiodistal * scale,
    buccolingual: info.buccolingual * scale,
    height: info.crownHeight * scale,
  };
}

const SEGMENTS = 48;
const WALL_RINGS = 12;
const CAP_RINGS = 10;

interface KindProfile {
  /** superellipse exponent (2 = ellipse, larger = boxier) */
  exponent: number;
  /** cervical width ratios (x, y) */
  cervical: [number, number];
  /** height of the occlusal relief (mm) */
  capHeight: number;
  /** scale factors of the cross-section along the wall, t in [0,1] */
  wallScale(t: number): [number, number];
  /** normalised occlusal relief at (u, v) in the unit cross-section, 0..~1 */
  relief(u: number, v: number, jaw: 'upper' | 'lower'): number;
}

function gauss(u: number, v: number, cu: number, cv: number, su: number, sv = su): number {
  const du = (u - cu) / su;
  const dv = (v - cv) / sv;
  return Math.exp(-(du * du + dv * dv));
}

function bulge(t: number, cervical: number, taper: number): number {
  // Rises from the cervical width to full width at the height of contour
  // (~40% of wall height), then converges toward the occlusal table.
  if (t <= 0.4) return cervical + (1 - cervical) * Math.sin((Math.PI / 2) * (t / 0.4));
  const k = (t - 0.4) / 0.6;
  return 1 - taper * k * k;
}

const PROFILES: Record<ToothKind, KindProfile> = {
  molar: {
    exponent: 2.8,
    cervical: [0.78, 0.85],
    capHeight: 2.0,
    wallScale: (t) => [bulge(t, 0.78, 0.1), bulge(t, 0.85, 0.16)],
    relief: (u, v) => {
      const cusps =
        gauss(u, v, -0.42, 0.42, 0.34) +
        gauss(u, v, 0.42, 0.42, 0.34) * 0.95 +
        gauss(u, v, -0.42, -0.42, 0.34) * 0.9 +
        gauss(u, v, 0.42, -0.42, 0.34) * 0.8;
      const ridge = 0.35 * Math.pow(Math.min(1, u * u + v * v), 2);
      return Math.min(1, cusps + ridge) - 0.15;
    },
  },
  premolar: {
    exponent: 2.4,
    cervical: [0.72, 0.85],
    capHeight: 2.4,
    wallScale: (t) => [bulge(t, 0.72, 0.12), bulge(t, 0.85, 0.2)],
    relief: (u, v, jaw) => {
      const lingual = jaw === 'upper' ? 0.85 : 0.55;
      const cusps = gauss(u, v, 0, 0.45, 0.42, 0.32) + gauss(u, v, 0, -0.45, 0.42, 0.32) * lingual;
      const ridge = 0.3 * Math.pow(Math.min(1, u * u), 2);
      return Math.min(1, cusps + ridge) - 0.1;
    },
  },
  canine: {
    exponent: 2.1,
    cervical: [0.7, 0.85],
    capHeight: 3.0,
    wallScale: (t) => [bulge(t, 0.7, 0.25), bulge(t, 0.85, 0.1) * (1 - 0.5 * Math.pow(t, 1.5))],
    relief: (u, v) => gauss(u, v, 0, 0.1, 0.55, 0.9) - 0.05,
  },
  incisor: {
    exponent: 2.3,
    cervical: [0.7, 0.88],
    capHeight: 0.8,
    wallScale: (t) => [
      0.7 + 0.3 * Math.sin((Math.PI / 2) * Math.min(1, t / 0.7)),
      bulge(t, 0.88, 0) * (1 - 0.72 * Math.pow(t, 1.4)),
    ],
    relief: (u) => 1 - 0.6 * u * u,
  },
};

/** Unit superellipse direction for angle theta. */
function superDir(theta: number, n: number): [number, number] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const e = 2 / n;
  return [Math.sign(c) * Math.pow(Math.abs(c), e), Math.sign(s) * Math.pow(Math.abs(s), e)];
}

/**
 * Outer crown surface in the local tooth frame (cervical line on z = 0),
 * sampled by polar direction alpha around the long axis. Implemented by the
 * procedural ToothSurface and by scanned library teeth (LibrarySurface), so
 * crown construction works the same with either.
 */
export interface OuterSurface {
  /** cross-section semi-axes (x, y) at normalised wall height t */
  semiAxes(t: number): [number, number];
  /** axial wall, t = 0 cervical line … 1 rim of the occlusal table */
  wallPointAt(alpha: number, t: number): THREE.Vector3;
  /** occlusal table, r = 1 rim … 0 centre */
  capPointAt(alpha: number, r: number): THREE.Vector3;
  /** centre of the occlusal table / incisal edge */
  topPoint(): THREE.Vector3;
  /** cervical line to the highest point */
  readonly height: number;
  /** copy scaled in x (mesiodistal) and y (buccolingual) */
  scaled(sx: number, sy: number): OuterSurface;
}

/**
 * Evaluates the outer surface of a tooth crown. Exposed so that the crown
 * shell can make its intaglio respect the minimum wall thickness.
 */
export class ToothSurface implements OuterSurface {
  readonly profile: KindProfile;
  readonly a: number;
  readonly b: number;
  readonly wallHeight: number;
  readonly capHeight: number;

  constructor(readonly shape: ToothShape) {
    this.profile = PROFILES[shape.kind];
    this.a = shape.mesiodistal / 2;
    this.b = shape.buccolingual / 2;
    const peak = this.reliefMax();
    this.capHeight = Math.min(this.profile.capHeight, shape.height * 0.45);
    this.wallHeight = shape.height - this.capHeight * peak;
  }

  private reliefMax(): number {
    let max = 0;
    for (let i = -10; i <= 10; i++) {
      for (let j = -10; j <= 10; j++) {
        const u = i / 10;
        const v = j / 10;
        if (u * u + v * v <= 1) max = Math.max(max, this.profile.relief(u, v, this.shape.jaw));
      }
    }
    return max;
  }

  relief(u: number, v: number): number {
    return this.capHeight * this.profile.relief(u, v, this.shape.jaw);
  }

  /** Lowest point of the occlusal table inside radius r (used for prep height). */
  reliefMin(rMax = 0.75): number {
    let min = Infinity;
    for (let i = -10; i <= 10; i++) {
      for (let j = -10; j <= 10; j++) {
        const u = (i / 10) * rMax;
        const v = (j / 10) * rMax;
        if (u * u + v * v <= rMax * rMax) min = Math.min(min, this.relief(u, v));
      }
    }
    return min;
  }

  /** Semi-axes of the cross-section at normalised wall height t. */
  semiAxes(t: number): [number, number] {
    const [sx, sy] = this.profile.wallScale(Math.max(0, Math.min(1, t)));
    return [this.a * sx, this.b * sy];
  }

  /** Outer point on the axial wall at angle theta, normalised height t. */
  wallPoint(theta: number, t: number): THREE.Vector3 {
    const [dx, dy] = superDir(theta, this.profile.exponent);
    const [ax, by] = this.semiAxes(t);
    const topZ = this.wallHeight + this.relief(dx, dy);
    return new THREE.Vector3(ax * dx, by * dy, t * topZ);
  }

  /** Outer point on the occlusal table at angle theta, radius r (1 = rim). */
  capPoint(theta: number, r: number): THREE.Vector3 {
    const [dx, dy] = superDir(theta, this.profile.exponent);
    const [ax, by] = this.semiAxes(1);
    const u = dx * r;
    const v = dy * r;
    return new THREE.Vector3(ax * u, by * v, this.wallHeight + this.relief(u, v));
  }

  /** Radius of the superellipse cross-section (unit semi-axes) in polar direction alpha. */
  private polarUnit(alpha: number, a: number, b: number): number {
    const n = this.profile.exponent;
    return 1 / Math.pow(Math.pow(Math.abs(Math.cos(alpha) / a), n) + Math.pow(Math.abs(Math.sin(alpha) / b), n), 1 / n);
  }

  /**
   * Wall point in polar direction alpha (a true geometric angle, unlike
   * wallPoint's superellipse parameter). Used to wrap the library tooth onto
   * a scanned margin sampled at regular angles.
   */
  wallPointAt(alpha: number, t: number): THREE.Vector3 {
    const [ax, by] = this.semiAxes(t);
    const [a1, b1] = this.semiAxes(1);
    const rho = this.polarUnit(alpha, ax, by);
    const rimRho = this.polarUnit(alpha, a1, b1);
    const u = (rimRho * Math.cos(alpha)) / a1;
    const v = (rimRho * Math.sin(alpha)) / b1;
    const topZ = this.wallHeight + this.relief(u, v);
    return new THREE.Vector3(rho * Math.cos(alpha), rho * Math.sin(alpha), t * topZ);
  }

  /** Occlusal point in polar direction alpha at relative radius r (1 = rim). */
  capPointAt(alpha: number, r: number): THREE.Vector3 {
    const [a1, b1] = this.semiAxes(1);
    const rho = this.polarUnit(alpha, a1, b1) * r;
    const x = rho * Math.cos(alpha);
    const y = rho * Math.sin(alpha);
    return new THREE.Vector3(x, y, this.wallHeight + this.relief(x / a1, y / b1));
  }

  get height(): number {
    return this.shape.height;
  }

  topPoint(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, this.wallHeight + this.relief(0, 0));
  }

  scaled(sx: number, sy: number): ToothSurface {
    return new ToothSurface({ ...this.shape, mesiodistal: this.shape.mesiodistal * sx, buccolingual: this.shape.buccolingual * sy });
  }

  /** Outer surface as rings from the margin to the occlusal centre. */
  outerRings(segments = SEGMENTS): { rings: THREE.Vector3[][]; center: THREE.Vector3 } {
    const rings: THREE.Vector3[][] = [];
    const thetas = Array.from({ length: segments }, (_, i) => (i / segments) * Math.PI * 2);
    for (let k = 0; k <= WALL_RINGS; k++) {
      const t = k / WALL_RINGS;
      rings.push(thetas.map((th) => this.wallPoint(th, t)));
    }
    for (let k = 1; k < CAP_RINGS; k++) {
      const r = 1 - k / CAP_RINGS;
      rings.push(thetas.map((th) => this.capPoint(th, r)));
    }
    const center = new THREE.Vector3(0, 0, this.wallHeight + this.relief(0, 0));
    return { rings, center };
  }
}

/**
 * Preparation (die) surface rings: a tapered stump with a rounded top.
 * `offset` grows the surface outward (used for the cement spacer), except
 * inside the marginal seal zone.
 */
export function prepRings(
  surface: ToothSurface,
  prep: PrepParams,
  offset = 0,
  segments = SEGMENTS,
): { rings: THREE.Vector3[][]; center: THREE.Vector3 } {
  const n = surface.profile.exponent;
  const [a0, b0] = surface.semiAxes(0);
  const marginA = Math.max(0.5, a0 - prep.marginThickness);
  const marginB = Math.max(0.5, b0 - prep.marginThickness);
  const height = Math.max(1.5, surface.wallHeight + surface.reliefMin() - prep.occlusalThickness);
  const tanHalf = Math.tan(((prep.taper / 2) * Math.PI) / 180);
  const shoulderRadius = Math.min(1.0, height * 0.25);
  const thetas = Array.from({ length: segments }, (_, i) => (i / segments) * Math.PI * 2);

  const axesAt = (z: number): [number, number] => {
    // tapered walls, but never thinner than the minimum axial thickness
    let ax = marginA - z * tanHalf;
    let by = marginB - z * tanHalf;
    const t = z / surface.wallHeight;
    const [oa, ob] = surface.semiAxes(t);
    if (z > prep.marginSeal) {
      ax = Math.min(ax, oa - prep.axialThickness);
      by = Math.min(by, ob - prep.axialThickness);
    }
    return [Math.max(0.6, ax), Math.max(0.6, by)];
  };

  const seal = (z: number): number => {
    if (prep.marginSeal <= 0) return 1;
    const x = Math.max(0, Math.min(1, z / prep.marginSeal));
    return x * x * (3 - 2 * x);
  };

  const rings: THREE.Vector3[][] = [];
  const wallTop = height - shoulderRadius;
  const wallSteps = 8;
  for (let k = 0; k <= wallSteps; k++) {
    const z = (k / wallSteps) * wallTop;
    const [ax, by] = axesAt(z);
    const o = offset * seal(z);
    rings.push(
      thetas.map((th) => {
        const [dx, dy] = superDir(th, n);
        return new THREE.Vector3((ax + o) * dx, (by + o) * dy, z);
      }),
    );
  }
  // rounded occlusal shoulder, then a flat-ish top converging to the centre
  const [topA, topB] = axesAt(wallTop);
  const roundSteps = 4;
  for (let k = 1; k <= roundSteps; k++) {
    const phi = (k / roundSteps) * (Math.PI / 2);
    const inset = shoulderRadius * (1 - Math.cos(phi));
    const z = wallTop + shoulderRadius * Math.sin(phi);
    rings.push(
      thetas.map((th) => {
        const [dx, dy] = superDir(th, n);
        return new THREE.Vector3((topA - inset + offset) * dx, (topB - inset + offset) * dy, z + offset);
      }),
    );
  }
  const innerA = topA - shoulderRadius;
  const innerB = topB - shoulderRadius;
  for (let k = 1; k <= 3; k++) {
    const r = 1 - k / 4;
    rings.push(
      thetas.map((th) => {
        const [dx, dy] = superDir(th, n);
        return new THREE.Vector3((innerA * r + offset) * dx, (innerB * r + offset) * dy, height + offset);
      }),
    );
  }
  return { rings, center: new THREE.Vector3(0, 0, height + offset) };
}

/** Rings for a root / ovate pontic dome below the margin ring. */
function domeBelow(margin: THREE.Vector3[], depth: number, steps = 6): { rings: THREE.Vector3[][]; center: THREE.Vector3 } {
  const rings: THREE.Vector3[][] = [];
  for (let k = 1; k < steps; k++) {
    const phi = (k / steps) * (Math.PI / 2);
    const r = Math.cos(phi);
    const z = -depth * Math.sin(phi);
    rings.push(margin.map((p) => new THREE.Vector3(p.x * r, p.y * r, z)));
  }
  return { rings, center: new THREE.Vector3(0, 0, -depth) };
}

function addOuter(mb: MeshBuilder, rings: THREE.Vector3[][], center: THREE.Vector3): number[] {
  const ids = rings.map((r) => mb.addRing(r));
  for (let k = 0; k < ids.length - 1; k++) mb.stitchRings(ids[k], ids[k + 1]);
  mb.fan(mb.addPoint(center), ids[ids.length - 1]);
  return ids[0];
}

function addInner(mb: MeshBuilder, rings: THREE.Vector3[][], center: THREE.Vector3): number[] {
  const ids = rings.map((r) => mb.addRing(r));
  for (let k = 0; k < ids.length - 1; k++) mb.stitchRings(ids[k + 1], ids[k]);
  mb.fan(mb.addPoint(center), ids[ids.length - 1], true);
  return ids[0];
}

function addDome(mb: MeshBuilder, marginIds: number[], margin: THREE.Vector3[], depth: number): void {
  const dome = domeBelow(margin, depth);
  let prev = marginIds;
  for (const ring of dome.rings) {
    const ids = mb.addRing(ring);
    mb.stitchRings(ids, prev);
    prev = ids;
  }
  mb.fan(mb.addPoint(dome.center), prev, true);
}

/**
 * Closed solid filling the crown's intaglio (cement space included),
 * extended below the margin. Subtracting it after a bridge union keeps the
 * intaglio clear of connector material.
 */
export function buildCrownCavity(shape: ToothShape, prep: PrepParams = DEFAULT_PREP, below = 3): MeshBuilder {
  const surface = new ToothSurface(shape);
  const mb = new MeshBuilder();
  const p = prepRings(surface, prep, prep.cementGap);
  const ids = p.rings.map((r) => mb.addRing(r));
  for (let k = 0; k < ids.length - 1; k++) mb.stitchRings(ids[k], ids[k + 1]);
  mb.fan(mb.addPoint(p.center), ids[ids.length - 1]);
  const bottom = mb.addRing(p.rings[0].map((v) => new THREE.Vector3(v.x, v.y, -below)));
  mb.stitchRings(bottom, ids[0]);
  mb.fan(mb.addVertex(0, 0, -below), bottom, true);
  // 20 µm inside the intaglio: it must clear connector material without ever
  // touching the crown surface (touching faces leave slivers in the STL)
  return mb.ensureOutward().offset(-0.02);
}

/** Full-contour crown shell with an intaglio fitted to a parametric prep. */
export function buildCrownShell(shape: ToothShape, prep: PrepParams = DEFAULT_PREP): MeshBuilder {
  const surface = new ToothSurface(shape);
  const mb = new MeshBuilder();
  const outer = surface.outerRings();
  const inner = prepRings(surface, prep, prep.cementGap);
  const outerMargin = addOuter(mb, outer.rings, outer.center);
  const innerMargin = addInner(mb, inner.rings, inner.center);
  // margin band (faces -z)
  mb.stitchRings(innerMargin, outerMargin);
  return mb;
}

/**
 * Closed full-contour tooth. `baseDepth` is the depth of the dome below the
 * margin: small for an ovate pontic, larger to embed a denture tooth or a
 * model tooth into the gingiva.
 */
export function buildSolidTooth(shape: ToothShape, baseDepth = 1.5): MeshBuilder {
  const surface = new ToothSurface(shape);
  const mb = new MeshBuilder();
  const outer = surface.outerRings();
  const margin = addOuter(mb, outer.rings, outer.center);
  addDome(mb, margin, outer.rings[0], baseDepth);
  return mb;
}

/** Prepared stump (die) for model / demo scans. */
export function buildPrepStump(shape: ToothShape, prep: PrepParams = DEFAULT_PREP, rootDepth = 4): MeshBuilder {
  const surface = new ToothSurface(shape);
  const mb = new MeshBuilder();
  const p = prepRings(surface, prep, 0);
  const margin = addOuter(mb, p.rings, p.center);
  addDome(mb, margin, p.rings[0], rootDepth);
  return mb;
}
