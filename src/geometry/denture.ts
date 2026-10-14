import * as THREE from 'three';
import { MeshBuilder } from './MeshBuilder';
import { sweepAlongArch, palateSlab } from './sweep';
import { buildSolidTooth, buildPrepStump, shapeFromTooth, DEFAULT_PREP, type PrepParams } from './toothShape';
import { archCurve, placeTeeth, type ArchDefinition } from '../core/arch';
import { archOrder, getTooth } from '../core/teeth';

export interface DentureParams {
  /** buccal flange depth from the gum line (mm) */
  flangeDepth: number;
  /** lingual flange depth (mandibular) (mm) */
  lingualFlangeDepth: number;
  /** include a full palate (maxillary complete denture) */
  palate: boolean;
  /** palatal plate thickness (mm) */
  palateThickness: number;
  /** scale of the denture teeth relative to average anatomy */
  toothScale: number;
  /** set second molars (7s) */
  includeSecondMolars: boolean;
}

export const DEFAULT_DENTURE: DentureParams = {
  flangeDepth: 9,
  lingualFlangeDepth: 7,
  palate: true,
  palateThickness: 2.2,
  toothScale: 1,
  includeSecondMolars: true,
};

export interface PlacedPart {
  fdi: number;
  /** geometry in the tooth's local frame */
  mesh: MeshBuilder;
  matrix: THREE.Matrix4;
  height: number;
}

function cylinder(radius: number, h0: number, h1: number, segments = 32): MeshBuilder {
  const mb = new MeshBuilder();
  const ring = (z: number) =>
    mb.addRing(
      Array.from({ length: segments }, (_, i) => {
        const t = (i / segments) * Math.PI * 2;
        return new THREE.Vector3(radius * Math.cos(t), radius * Math.sin(t), z);
      }),
    );
  const a = ring(h0);
  const b = ring(h1);
  mb.stitchRings(a, b);
  mb.fan(mb.addVertex(0, 0, h0), a, true);
  mb.fan(mb.addVertex(0, 0, h1), b);
  return mb;
}

/** Closed outline inside the arch at a given lingual offset/height (for palate slabs). */
function palatalRim(arch: ArchDefinition, lingualOffset: number, h: number): THREE.Vector3[] {
  const curve = archCurve(arch);
  const centroid = arch.points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(arch.points.length);
  const pts: THREE.Vector3[] = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u).setZ(0).normalize();
    let normal = new THREE.Vector3(t.y, -t.x, 0);
    if (normal.dot(p.clone().sub(centroid).setZ(0)) < 0) normal.negate();
    pts.push(p.addScaledVector(normal, -lingualOffset).setZ(arch.marginZ + arch.occlusalDir * h));
  }
  // posterior palatal border: straight line from the left end back to the right
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < 12; i++) pts.push(last.clone().lerp(first, i / 12));
  return pts;
}

export function buildDentureBase(arch: ArchDefinition, p: DentureParams = DEFAULT_DENTURE): MeshBuilder {
  const D = p.flangeDepth;
  const L = arch.jaw === 'lower' ? p.lingualFlangeDepth : Math.min(p.lingualFlangeDepth, 6);
  const profile: [number, number][] = [
    [3.8, 1.2],
    [5.8, -2.0],
    [6.0, -D + 1.2],
    [5.2, -D],
    [3.6, -D + 0.4],
    [2.2, -4.5],
    [0, -3.6],
    [-2.2, -4.5],
    [-3.4, -L + 0.4],
    [-4.8, -L],
    [-5.4, -L + 1.0],
    [-5.2, -1.5],
    [-3.6, 1.2],
  ];
  const base = sweepAlongArch(arch, () => profile, { extend: 4 });
  if (arch.jaw === 'upper' && p.palate) {
    const rim = palatalRim(arch, 4.6, -3);
    base.append(palateSlab(arch, rim, 7, p.palateThickness));
  }
  return base;
}

export function buildDentureTeeth(arch: ArchDefinition, p: DentureParams = DEFAULT_DENTURE): PlacedPart[] {
  const placements = placeTeeth(arch, p.toothScale);
  const parts: PlacedPart[] = [];
  for (const fdi of archOrder(arch.jaw)) {
    const pos = fdi % 10;
    if (pos === 8 || (pos === 7 && !p.includeSecondMolars)) continue;
    const info = getTooth(fdi);
    const shape = shapeFromTooth(info, p.toothScale);
    parts.push({ fdi, mesh: buildSolidTooth(shape, 2.5), matrix: placements.get(fdi)!.matrix.clone(), height: shape.height });
  }
  return parts;
}

export interface ModelOptions {
  /** prepared teeth (shown as dies) */
  preps?: number[];
  /** missing teeth (edentulous span / pontic sites) */
  missing?: number[];
  /** implant sites (shown with a scan body) */
  implants?: number[];
  prep?: PrepParams;
}

/**
 * Procedural "scan" of a dental model, so every workflow can be tried
 * without intraoral scan data. Returned in world space as one mesh made of
 * overlapping closed shells (gingiva, teeth, palate).
 */
export function buildDemoModel(arch: ArchDefinition, opts: ModelOptions = {}): MeshBuilder {
  const preps = new Set(opts.preps ?? []);
  const missing = new Set(opts.missing ?? []);
  const implants = new Set(opts.implants ?? []);
  // gingiva rolling over the alveolar ridge, on a trimmed model base
  const gum: [number, number][] = [
    [4.0, 1.0],
    [5.4, -0.6],
    [6.2, -2.8],
    [6.6, -6.0],
    [7.6, -8.0],
    [7.6, -14],
    [-6.6, -14],
    [-6.6, -8.0],
    [-5.8, -6.0],
    [-5.6, -2.8],
    [-5.0, -0.6],
    [-4.0, 1.0],
  ];
  const model = sweepAlongArch(arch, () => gum, { extend: 4 });
  if (arch.jaw === 'upper') {
    model.append(palateSlab(arch, palatalRim(arch, 5.0, -2.5), 7, 5));
  }
  const placements = placeTeeth(arch);
  for (const fdi of archOrder(arch.jaw)) {
    if (fdi % 10 === 8 || missing.has(fdi)) continue;
    const m = placements.get(fdi)!.matrix;
    const shape = shapeFromTooth(getTooth(fdi));
    let part: MeshBuilder;
    if (implants.has(fdi)) part = cylinder(2.4, -1.5, 7);
    else if (preps.has(fdi)) part = buildPrepStump(shape, opts.prep ?? DEFAULT_PREP, 4);
    else part = buildSolidTooth(shape, 4);
    model.append(part.transform(m));
  }
  return model;
}
