import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { closedAfterStl } from './stl';
import { checkMesh } from '../src/geometry/MeshBuilder';
import { ToothLibrary } from '../src/library/toothLibrary';
import { setActiveLibrary, prepareTeeth, outerSurface, solidTooth, solidParts, mergeParts } from '../src/library/provider';
import { buildDieCrown } from '../src/geometry/dieCrown';
import { detectMargin } from '../src/geometry/margin';
import { subtract } from '../src/geometry/csg';
import { buildDemoModel, buildDentureBaseParts, buildDentureTeeth, buildSocketedBase, DEFAULT_DENTURE } from '../src/geometry/denture';
import { buildPrepStump, prepRings, shapeFromTooth, ToothSurface, DEFAULT_PREP } from '../src/geometry/toothShape';
import { defaultArch, placeTeeth } from '../src/core/arch';
import { archOrder, getTooth } from '../src/core/teeth';

const DIR = join(__dirname, '..', 'public', 'library', 'teeth');
const fetcher = async (path: string) => {
  const b = readFileSync(join(DIR, path));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const stlSafe = closedAfterStl;

let library: ToothLibrary;
const ALL = [...archOrder('upper'), ...archOrder('lower')];

beforeAll(async () => {
  library = await ToothLibrary.load(fetcher);
  setActiveLibrary(library);
  await prepareTeeth(ALL);
}, 60_000);
afterAll(() => setActiveLibrary(null));

describe('scanned tooth library', () => {
  it('has all 32 teeth, each once', () => {
    const fdis = library.manifest.teeth.map((t) => t.fdi).sort((a, b) => a - b);
    expect(fdis).toEqual([...ALL].sort((a, b) => a - b));
  });

  it('measures anatomically ordered widths', () => {
    const md = (f: number) => library.info(f)!.mesiodistal;
    expect(md(11)).toBeGreaterThan(md(12)); // upper central > lateral
    expect(md(16)).toBeGreaterThan(md(15)); // molar > premolar
    expect(md(31)).toBeLessThan(md(11)); // lower central < upper central
    expect(md(36)).toBeGreaterThan(10);
  });

  it('drives the arch layout with the measured widths', () => {
    expect(getTooth(36).mesiodistal).toBeCloseTo(library.info(36)!.mesiodistal, 3);
  });

  it.each(ALL)('tooth %i is a closed solid in its local frame', (fdi) => {
    const t = library.loadedTooth(fdi)!;
    const c = checkMesh(t.geometry);
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(100);
    const bb = t.geometry.boundingBox!;
    expect(bb.max.z).toBeCloseTo(t.info.height, 1); // crown points +z
    expect(bb.min.z).toBeLessThan(0); // closed cervical end just below the cervical line
    expect(bb.min.z).toBeGreaterThan(-3);
    // the sampled outer surface agrees with the mesh
    const s = t.surface;
    expect(s.topPoint().z).toBeGreaterThan(t.info.height * 0.7);
    const [a] = s.semiAxes(0.6);
    expect(a * 2).toBeGreaterThan(t.info.mesiodistal * 0.75);
    expect(a * 2).toBeLessThan(t.info.mesiodistal * 1.05);
  });

  it('fuses a crown with its root stub for denture sockets', { timeout: 60_000 }, async () => {
    const parts = solidParts(46, 1, 2.5);
    expect(parts.length).toBe(2);
    const solid = await solidTooth(46, 1, 2.5);
    expect(checkMesh(solid.toGeometry()).watertight).toBe(true);
    expect(stlSafe(solid).watertight).toBe(true);
    expect(solid.toGeometry().boundingBox!.min.z).toBeCloseTo(-2.5, 1);
  });
});

describe('library crowns', () => {
  it('fits a library crown onto a scanned die', () => {
    const arch = defaultArch('lower');
    const p = placeTeeth(arch).get(36)!;
    const scan = buildDemoModel(arch, { preps: [36] }).toGeometry();
    const margin = detectMargin(scan, p.center, new THREE.Vector3(0, 0, 1));
    const r = buildDieCrown(scan, margin, new THREE.Matrix4().extractRotation(p.matrix), outerSurface(36), DEFAULT_PREP);
    expect(checkMesh(r.mesh.toGeometry()).watertight).toBe(true);
    expect(stlSafe(r.mesh).watertight).toBe(true);
    expect(r.minThickness).toBeGreaterThanOrEqual(DEFAULT_PREP.axialThickness - 0.05);
  });

  it('builds a library crown on the parametric prep (no scan)', () => {
    const shape = shapeFromTooth(getTooth(11));
    const die = buildPrepStump(shape, DEFAULT_PREP, 3).toGeometry();
    const margin = prepRings(new ToothSurface(shape), DEFAULT_PREP, 0).rings[0];
    const r = buildDieCrown(die, margin, new THREE.Matrix4(), outerSurface(11), DEFAULT_PREP);
    expect(checkMesh(r.mesh.toGeometry()).watertight).toBe(true);
    expect(r.height).toBeGreaterThan(7);
  });
});

describe('library dentures', () => {
  it('cuts sockets for library teeth into the base', async () => {
    const arch = defaultArch('lower');
    const p = { ...DEFAULT_DENTURE, twoPiece: true };
    const fdis = archOrder('lower').filter((f) => f % 10 !== 8);
    const solids = new Map(await Promise.all(fdis.map(async (f) => [f, await solidTooth(f, 1, p.socketDepth)] as const)));
    const teeth = buildDentureTeeth(arch, p, (f) => solids.get(f)!.clone()).map((t) => t.mesh.clone().transform(t.matrix));
    const base = await buildSocketedBase(buildDentureBaseParts(arch, p), teeth, p.tolerance);
    expect(stlSafe(base).watertight).toBe(true);
    // teeth do not overlap the socketed base
    const overlap = await subtract(teeth.slice(0, 3), [base]);
    const teethVolume = teeth.slice(0, 3).reduce((s, t) => s + checkMesh(t.toGeometry()).volume, 0);
    expect(checkMesh(overlap.toGeometry()).volume).toBeGreaterThan(teethVolume - 0.5);
  }, 120_000);

  it('places library teeth in a demo model', () => {
    const arch = defaultArch('upper');
    const model = buildDemoModel(arch, { solid: (f, s, d) => mergeParts(solidParts(f, s, d)) });
    expect(model.toGeometry().boundingBox!.getSize(new THREE.Vector3()).x).toBeGreaterThan(40);
  });
});
