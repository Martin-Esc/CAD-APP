/**
 * Tooth reference data and numbering systems.
 *
 * Dimensions are average crown measurements in millimetres (Wheeler's Dental
 * Anatomy averages, rounded). They seed the procedural tooth library and the
 * arch layout; every value can be overridden per design.
 */

export type Jaw = 'upper' | 'lower';
export type ToothClass = 'central' | 'lateral' | 'canine' | 'premolar1' | 'premolar2' | 'molar1' | 'molar2' | 'molar3';
export type ToothKind = 'incisor' | 'canine' | 'premolar' | 'molar';

export interface ToothInfo {
  /** FDI two-digit number, e.g. 36 */
  fdi: number;
  /** Universal (ADA) number 1-32 */
  universal: number;
  jaw: Jaw;
  /** 'right' / 'left' from the patient's point of view */
  side: 'right' | 'left';
  /** position from the midline, 1 (central) .. 8 (third molar) */
  position: number;
  toothClass: ToothClass;
  kind: ToothKind;
  /** mesiodistal crown width at the height of contour */
  mesiodistal: number;
  /** buccolingual (labiolingual) crown width */
  buccolingual: number;
  /** cervical-to-incisal/occlusal crown height */
  crownHeight: number;
  name: string;
}

const CLASSES: ToothClass[] = ['central', 'lateral', 'canine', 'premolar1', 'premolar2', 'molar1', 'molar2', 'molar3'];

const KIND: Record<ToothClass, ToothKind> = {
  central: 'incisor',
  lateral: 'incisor',
  canine: 'canine',
  premolar1: 'premolar',
  premolar2: 'premolar',
  molar1: 'molar',
  molar2: 'molar',
  molar3: 'molar',
};

const NAMES: Record<ToothClass, string> = {
  central: 'Central incisor',
  lateral: 'Lateral incisor',
  canine: 'Canine',
  premolar1: 'First premolar',
  premolar2: 'Second premolar',
  molar1: 'First molar',
  molar2: 'Second molar',
  molar3: 'Third molar',
};

/** [mesiodistal, buccolingual, crownHeight] */
const DIMENSIONS: Record<Jaw, [number, number, number][]> = {
  upper: [
    [8.5, 7.0, 10.5],
    [6.5, 6.0, 9.0],
    [7.5, 8.0, 10.0],
    [7.0, 9.0, 8.5],
    [6.5, 9.0, 8.5],
    [10.0, 11.0, 7.5],
    [9.0, 11.0, 7.0],
    [8.5, 10.0, 6.5],
  ],
  lower: [
    [5.0, 6.0, 9.0],
    [5.5, 6.5, 9.5],
    [7.0, 7.5, 11.0],
    [7.0, 7.5, 8.5],
    [7.0, 8.0, 8.0],
    [11.0, 10.5, 7.5],
    [10.5, 10.0, 7.0],
    [10.0, 9.5, 7.0],
  ],
};

function quadrantOf(fdi: number): number {
  return Math.floor(fdi / 10);
}

export function isValidFdi(fdi: number): boolean {
  const q = quadrantOf(fdi);
  const p = fdi % 10;
  return Number.isInteger(fdi) && q >= 1 && q <= 4 && p >= 1 && p <= 8;
}

export function fdiToUniversal(fdi: number): number {
  const q = quadrantOf(fdi);
  const p = fdi % 10;
  switch (q) {
    case 1: return 9 - p;       // UR8 = 1 ... UR1 = 8
    case 2: return 8 + p;       // UL1 = 9 ... UL8 = 16
    case 3: return 25 - p;      // LL8 = 17 ... LL1 = 24
    case 4: return 24 + p;      // LR1 = 25 ... LR8 = 32
    default: throw new Error(`Invalid FDI number ${fdi}`);
  }
}

export function universalToFdi(universal: number): number {
  if (universal >= 1 && universal <= 8) return 10 + (9 - universal);
  if (universal >= 9 && universal <= 16) return 20 + (universal - 8);
  if (universal >= 17 && universal <= 24) return 30 + (25 - universal);
  if (universal >= 25 && universal <= 32) return 40 + (universal - 24);
  throw new Error(`Invalid Universal number ${universal}`);
}

export function getTooth(fdi: number): ToothInfo {
  if (!isValidFdi(fdi)) throw new Error(`Invalid FDI number ${fdi}`);
  const q = quadrantOf(fdi);
  const position = fdi % 10;
  const jaw: Jaw = q <= 2 ? 'upper' : 'lower';
  const side = q === 1 || q === 4 ? 'right' : 'left';
  const toothClass = CLASSES[position - 1];
  const [mesiodistal, buccolingual, crownHeight] = DIMENSIONS[jaw][position - 1];
  return {
    fdi,
    universal: fdiToUniversal(fdi),
    jaw,
    side,
    position,
    toothClass,
    kind: KIND[toothClass],
    mesiodistal,
    buccolingual,
    crownHeight,
    name: `${jaw === 'upper' ? 'Maxillary' : 'Mandibular'} ${side} ${NAMES[toothClass].toLowerCase()}`,
  };
}

/** All FDI numbers of a jaw, ordered along the arch from the patient's right to left. */
export function archOrder(jaw: Jaw): number[] {
  const [right, left] = jaw === 'upper' ? [1, 2] : [4, 3];
  const r = [8, 7, 6, 5, 4, 3, 2, 1].map((p) => right * 10 + p);
  const l = [1, 2, 3, 4, 5, 6, 7, 8].map((p) => left * 10 + p);
  return [...r, ...l];
}

export function jawOf(fdi: number): Jaw {
  return quadrantOf(fdi) <= 2 ? 'upper' : 'lower';
}

/**
 * Are two teeth adjacent in the arch (neighbours, including across the midline)?
 */
export function areAdjacent(a: number, b: number): boolean {
  if (jawOf(a) !== jawOf(b)) return false;
  const order = archOrder(jawOf(a));
  return Math.abs(order.indexOf(a) - order.indexOf(b)) === 1;
}

/**
 * Split a set of teeth into contiguous runs along the arch.
 * Used to group bridge units: [14,15,16,21] -> [[16,15,14],[21]] (arch order).
 */
export function contiguousRuns(teeth: number[]): number[][] {
  const runs: number[][] = [];
  for (const jaw of ['upper', 'lower'] as Jaw[]) {
    let current: number[] = [];
    for (const fdi of archOrder(jaw)) {
      if (teeth.includes(fdi)) {
        current.push(fdi);
      } else if (current.length) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length) runs.push(current);
  }
  return runs;
}
