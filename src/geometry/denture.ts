import * as THREE from 'three';
import { MeshBuilder } from './MeshBuilder';
import { subtract, union } from './csg';
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
  /** two-piece: teeth printed / milled separately and bonded into sockets in the base */
  twoPiece: boolean;
  /** how far each tooth extends below its cervical line into the base (mm) */
  socketDepth: number;
  /** clearance between tooth and socket wall for material / printer tolerance (mm) */
  tolerance: number;
}

export const DEFAULT_DENTURE: DentureParams = {
  flangeDepth: 9,
  lingualFlangeDepth: 7,
  palate: true,
  palateThickness: 2.2,
  toothScale: 1,
  includeSecondMolars: true,
  twoPiece: false,
  socketDepth: 2.0,
  tolerance: 0.1,
};

/** Tissue-side crest of the base profile (mm below the cervical line). */
const BASE_CREST_DEPTH = 3.6;
/** Base material that must remain under a socket (mm). */
const MIN_BASE_UNDER_SOCKET = 1.0;

export function validateDenture(p: DentureParams): string[] {
  const issues: string[] = [];
  if (p.twoPiece && p.socketDepth + p.tolerance > BASE_CREST_DEPTH - MIN_BASE_UNDER_SOCKET) {
    issues.push(
      `Sockets ${(p.socketDepth + p.tolerance).toFixed(1)} mm deep leave less than ${MIN_BASE_UNDER_SOCKET} mm of base over the ridge – reduce the socket depth.`,
    );
  }
  if (p.twoPiece && p.tolerance > 0.4) issues.push('Tolerance above 0.4 mm – the teeth will be loose in their sockets.');
  return issues;
}

export interface PlacedPart {
  fdi: number;
  /** geometry in the tooth's local frame */
  mesh: MeshBuilder;
  matrix: THREE.Matrix4;
  height: number;
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

/** The base as separate closed shells (ridge sweep, palate), ready for booleans. */
export function buildDentureBaseParts(arch: ArchDefinition, p: DentureParams = DEFAULT_DENTURE): MeshBuilder[] {
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
  const parts = [sweepAlongArch(arch, () => profile, { extend: 4 })];
  if (arch.jaw === 'upper' && p.palate) {
    const rim = palatalRim(arch, 4.6, -3);
    parts.push(palateSlab(arch, rim, 7, p.palateThickness));
  }
  return parts;
}

/** The base as one mesh of overlapping shells (fast preview, no booleans). */
export function buildDentureBase(arch: ArchDefinition, p: DentureParams = DEFAULT_DENTURE): MeshBuilder {
  const parts = buildDentureBaseParts(arch, p);
  for (const extra of parts.slice(1)) parts[0].append(extra);
  return parts[0];
}

/**
 * Two-piece base: the base solid with a socket for every tooth. Each socket is
 * the tooth grown by `tolerance` along its normals, so the printed tooth
 * slides in with an even cement / bonding gap.
 *
 * @param teeth  denture teeth in world space
 */
export function buildSocketedBase(baseParts: MeshBuilder[], teeth: MeshBuilder[], tolerance: number): Promise<MeshBuilder> {
  return subtract(baseParts, teeth.map((t) => t.offset(tolerance)));
}

/** One-piece denture: base and teeth fused into a single solid. */
export function buildMergedDenture(baseParts: MeshBuilder[], teeth: MeshBuilder[]): Promise<MeshBuilder> {
  return union([...baseParts, ...teeth]);
}

/**
 * Supplies the closed solid of a tooth in its local frame (cervical line on
 * z = 0) extending `rootDepth` below it. Defaults to the procedural teeth;
 * the app passes scanned library teeth (see library/provider.ts).
 */
export type ToothSolidFn = (fdi: number, scale: number, rootDepth: number) => MeshBuilder;

export const proceduralSolid: ToothSolidFn = (fdi, scale, rootDepth) => buildSolidTooth(shapeFromTooth(getTooth(fdi), scale), rootDepth);

export function buildDentureTeeth(arch: ArchDefinition, p: DentureParams = DEFAULT_DENTURE, solid: ToothSolidFn = proceduralSolid): PlacedPart[] {
  const placements = placeTeeth(arch, p.toothScale);
  const parts: PlacedPart[] = [];
  for (const fdi of archOrder(arch.jaw)) {
    const pos = fdi % 10;
    if (pos === 8 || (pos === 7 && !p.includeSecondMolars)) continue;
    const info = getTooth(fdi);
    const shape = shapeFromTooth(info, p.toothScale);
    parts.push({ fdi, mesh: solid(fdi, p.toothScale, p.socketDepth), matrix: placements.get(fdi)!.matrix.clone(), height: shape.height });
  }
  return parts;
}

export interface ModelOptions {
  /** prepared teeth (shown as dies) */
  preps?: number[];
  /** missing teeth (edentulous span / pontic sites) */
  missing?: number[];
  prep?: PrepParams;
  /** natural teeth (default: procedural) */
  solid?: ToothSolidFn;
}

/**
 * Procedural "scan" of a dental model, so every workflow can be tried
 * without intraoral scan data. Returned in world space as one mesh made of
 * overlapping closed shells (gingiva, teeth, palate).
 */
export function buildDemoModel(arch: ArchDefinition, opts: ModelOptions = {}): MeshBuilder {
  const preps = new Set(opts.preps ?? []);
  const missing = new Set(opts.missing ?? []);
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
  const placements = placeTeeth(arch);
  // Trim the gingiva around prepared teeth (like a ditched die) so their
  // margins are exposed and can be detected.
  const length = archCurve(arch).getLength();
  const trims = [...preps]
    .filter((fdi) => placements.has(fdi))
    .map((fdi) => ({ u: placements.get(fdi)!.u, half: getTooth(fdi).mesiodistal / 2 / length }));
  const trimAt = (u: number) =>
    trims.reduce((w, t) => {
      const d = Math.abs(u - t.u);
      const inner = t.half * 1.05;
      const outer = t.half * 1.9;
      return Math.max(w, d <= inner ? 1 : d >= outer ? 0 : 1 - (d - inner) / (outer - inner));
    }, 0);
  const drop = [2.6, 2.2, 1.0, 0, 0, 0, 0, 0, 0, 1.0, 2.2, 2.6];
  const model = sweepAlongArch(arch, (u) => {
    const w = trimAt(u);
    return gum.map(([n, h], i) => [n, h - drop[i] * w] as [number, number]);
  }, { extend: 4, samples: 160 });
  if (arch.jaw === 'upper') {
    model.append(palateSlab(arch, palatalRim(arch, 5.0, -2.5), 7, 5));
  }
  for (const fdi of archOrder(arch.jaw)) {
    if (fdi % 10 === 8 || missing.has(fdi)) continue;
    const m = placements.get(fdi)!.matrix;
    const shape = shapeFromTooth(getTooth(fdi));
    let part: MeshBuilder;
    if (preps.has(fdi)) part = buildPrepStump(shape, opts.prep ?? DEFAULT_PREP, 4);
    else part = (opts.solid ?? proceduralSolid)(fdi, 1, 4);
    model.append(part.transform(m));
  }
  return model;
}
