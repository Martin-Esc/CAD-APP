import * as THREE from 'three';
import { MeshBuilder } from './MeshBuilder';

/**
 * Parametric custom implant abutment.
 *
 * Built in the implant frame: +z along the implant axis, the implant
 * platform on z = 0, +y buccal. The anti-rotation hex sits below the
 * platform; a straight screw channel runs through the whole part.
 */
export interface AbutmentParams {
  /** implant platform diameter (mm) */
  platformDiameter: number;
  /** anti-rotation hex across flats (mm) */
  hexAcrossFlats: number;
  /** hex engagement length below the platform (mm) */
  hexHeight: number;
  /** screw access channel diameter (mm) */
  screwChannel: number;
  /** platform to margin height – transmucosal/gingival height (mm) */
  gingivalHeight: number;
  /** margin size mesiodistal / buccolingual (anatomic emergence) */
  marginMD: number;
  marginBL: number;
  /** -1 concave … 0 straight … +1 convex emergence profile */
  emergence: number;
  /** shoulder / chamfer width at the margin (mm) */
  shoulder: number;
  /** post height above the margin (mm) */
  postHeight: number;
  /** taper per wall (degrees) */
  taper: number;
  /** post angulation toward buccal (degrees, sheared) */
  angulation: number;
}

export const DEFAULT_ABUTMENT: AbutmentParams = {
  platformDiameter: 4.1,
  hexAcrossFlats: 2.7,
  hexHeight: 1.2,
  screwChannel: 2.0,
  gingivalHeight: 2.5,
  marginMD: 6.5,
  marginBL: 6.0,
  emergence: 0.3,
  shoulder: 0.5,
  postHeight: 5.0,
  taper: 6,
  angulation: 0,
};

const SEGMENTS = 48; // divisible by 6 so the hex corners are sampled exactly

type RingFn = (theta: number) => [number, number];

function circle(r: number): RingFn {
  return (t) => [r * Math.cos(t), r * Math.sin(t)];
}

function ellipse(a: number, b: number): RingFn {
  return (t) => [a * Math.cos(t), b * Math.sin(t)];
}

function hexagon(acrossFlats: number): RingFn {
  const apothem = acrossFlats / 2;
  return (t) => {
    const sector = Math.PI / 3;
    const local = ((t % sector) + sector) % sector - sector / 2;
    const r = apothem / Math.cos(local);
    return [r * Math.cos(t), r * Math.sin(t)];
  };
}

export function validateAbutment(p: AbutmentParams): string[] {
  const issues: string[] = [];
  const hexCorner = p.hexAcrossFlats / Math.sqrt(3);
  if (hexCorner >= p.platformDiameter / 2) issues.push('Hex corners exceed the platform diameter');
  if (p.screwChannel / 2 >= p.hexAcrossFlats / 2 - 0.2) issues.push('Screw channel leaves < 0.2 mm wall in the hex');
  const postTop = Math.min(p.marginMD, p.marginBL) / 2 - p.shoulder - p.postHeight * Math.tan((p.taper * Math.PI) / 180);
  if (postTop - p.screwChannel / 2 < 0.5) issues.push('Post wall around the screw channel is thinner than 0.5 mm');
  if (p.gingivalHeight < 0.5) issues.push('Gingival height below 0.5 mm');
  if (p.angulation > 20) issues.push('Angulation > 20° – consider an angled screw channel or cement-retained design');
  return issues;
}

export function buildAbutment(p: AbutmentParams = DEFAULT_ABUTMENT): MeshBuilder {
  const mb = new MeshBuilder();
  const rings: number[][] = [];
  const shear = Math.tan((p.angulation * Math.PI) / 180);
  const marginZ = p.gingivalHeight;

  const addRing = (fn: RingFn, z: number, sheared = false) => {
    const pts: THREE.Vector3[] = [];
    const dy = sheared ? (z - marginZ) * shear : 0;
    for (let i = 0; i < SEGMENTS; i++) {
      const t = (i / SEGMENTS) * Math.PI * 2;
      const [x, y] = fn(t);
      pts.push(new THREE.Vector3(x, y + dy, z));
    }
    rings.push(mb.addRing(pts));
  };

  const rp = p.platformDiameter / 2;
  const rs = p.screwChannel / 2;
  // hex connection
  addRing(hexagon(p.hexAcrossFlats), -p.hexHeight);
  addRing(hexagon(p.hexAcrossFlats), 0);
  // platform seat
  addRing(circle(rp), 0);
  // emergence profile: platform circle -> anatomic margin ellipse
  const steps = 8;
  const power = Math.exp(-p.emergence * 0.9);
  for (let k = 1; k <= steps; k++) {
    const s = k / steps;
    const f = Math.pow(s, power);
    const a = rp + (p.marginMD / 2 - rp) * f;
    const b = rp + (p.marginBL / 2 - rp) * f;
    addRing(ellipse(a, b), s * marginZ);
  }
  // shoulder / chamfer
  const pa = p.marginMD / 2 - p.shoulder;
  const pb = p.marginBL / 2 - p.shoulder;
  addRing(ellipse(pa, pb), marginZ + 0.25, true);
  // tapered post
  const tan = Math.tan((p.taper * Math.PI) / 180);
  const round = Math.min(0.8, p.postHeight * 0.2);
  const wallTop = marginZ + p.postHeight - round;
  const postSteps = 5;
  for (let k = 1; k <= postSteps; k++) {
    const z = marginZ + 0.25 + (k / postSteps) * (wallTop - marginZ - 0.25);
    const d = (z - marginZ) * tan;
    addRing(ellipse(pa - d, pb - d), z, true);
  }
  // rounded occlusal edge
  const dTop = (wallTop - marginZ) * tan;
  for (let k = 1; k <= 3; k++) {
    const phi = (k / 3) * (Math.PI / 2);
    const inset = round * (1 - Math.cos(phi));
    addRing(ellipse(pa - dTop - inset, pb - dTop - inset), wallTop + round * Math.sin(phi), true);
  }
  const topZ = marginZ + p.postHeight;
  // top face to the screw channel, then down the channel
  addRing(circle(rs), topZ);
  addRing(circle(rs), -p.hexHeight);

  for (let i = 0; i < rings.length; i++) {
    mb.stitchRings(rings[i], rings[(i + 1) % rings.length]);
  }
  return mb.ensureOutward();
}
