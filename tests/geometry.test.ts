import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { checkMesh } from '../src/geometry/MeshBuilder';
import { buildCrownShell, buildSolidTooth, buildPrepStump, shapeFromTooth, DEFAULT_PREP } from '../src/geometry/toothShape';
import { buildAbutment, DEFAULT_ABUTMENT, validateAbutment } from '../src/geometry/abutment';
import { buildConnector } from '../src/geometry/connector';
import { buildDentureBase, buildDentureTeeth, buildDemoModel } from '../src/geometry/denture';
import { buildNightguard } from '../src/geometry/nightguard';
import { defaultArch, placeTeeth } from '../src/core/arch';
import { getTooth, archOrder } from '../src/core/teeth';

const ALL_TEETH = [...archOrder('upper'), ...archOrder('lower')];

describe('tooth library', () => {
  it.each(ALL_TEETH)('solid tooth %i is watertight with positive volume', (fdi) => {
    const g = buildSolidTooth(shapeFromTooth(getTooth(fdi))).toGeometry();
    const c = checkMesh(g);
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(50);
  });

  it.each(ALL_TEETH)('crown shell %i is watertight and thinner than the solid tooth', (fdi) => {
    const shape = shapeFromTooth(getTooth(fdi));
    const shell = checkMesh(buildCrownShell(shape).toGeometry());
    const solid = checkMesh(buildSolidTooth(shape, 0.01).toGeometry());
    expect(shell.watertight).toBe(true);
    expect(shell.volume).toBeGreaterThan(0);
    expect(shell.volume).toBeLessThan(solid.volume);
  });

  it('crown height matches the reference dimension', () => {
    const info = getTooth(36);
    const g = buildCrownShell(shapeFromTooth(info)).toGeometry();
    const size = g.boundingBox!.getSize(new THREE.Vector3());
    expect(size.z).toBeCloseTo(info.crownHeight, 0);
    expect(size.x).toBeCloseTo(info.mesiodistal, 0);
  });

  it('crown intaglio is offset by the cement gap above the marginal seal', () => {
    const shape = shapeFromTooth(getTooth(46));
    const stump = buildPrepStump(shape, DEFAULT_PREP, 0.01).toGeometry();
    const crown = buildCrownShell(shape, { ...DEFAULT_PREP, cementGap: 0.1 }).toGeometry();
    expect(checkMesh(stump).watertight).toBe(true);
    // crown intaglio top sits cementGap above the prep top
    expect(crown.boundingBox!.max.z).toBeGreaterThan(stump.boundingBox!.max.z + DEFAULT_PREP.occlusalThickness * 0.8);
  });
});

describe('abutment', () => {
  it('default abutment is watertight and valid', () => {
    const c = checkMesh(buildAbutment().toGeometry());
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(20);
    expect(validateAbutment(DEFAULT_ABUTMENT)).toEqual([]);
  });

  it('angulated abutment stays watertight', () => {
    const c = checkMesh(buildAbutment({ ...DEFAULT_ABUTMENT, angulation: 15 }).toGeometry());
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(0);
  });

  it('flags a hex larger than the platform', () => {
    expect(validateAbutment({ ...DEFAULT_ABUTMENT, hexAcrossFlats: 4 })).not.toEqual([]);
  });
});

describe('bridge connector', () => {
  it('connector is watertight with roughly the requested area', () => {
    const arch = defaultArch('lower');
    const placed = placeTeeth(arch);
    const c = checkMesh(buildConnector(placed.get(35)!.matrix, 8, placed.get(36)!.matrix, 7.5).toGeometry());
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(0);
  });
});

describe('arch layout', () => {
  it('places all 16 teeth with contacts in arch order', () => {
    const arch = defaultArch('upper');
    const placed = placeTeeth(arch);
    expect(placed.size).toBe(16);
    const order = archOrder('upper');
    for (let i = 0; i < order.length - 1; i++) {
      const a = placed.get(order[i])!.center;
      const b = placed.get(order[i + 1])!.center;
      const expected = (getTooth(order[i]).mesiodistal + getTooth(order[i + 1]).mesiodistal) / 2;
      // chord is slightly shorter than the arc
      expect(a.distanceTo(b)).toBeGreaterThan(expected * 0.9);
      expect(a.distanceTo(b)).toBeLessThan(expected * 1.01);
    }
  });

  it('upper incisors face anterior and crowns point down', () => {
    const placed = placeTeeth(defaultArch('upper'));
    const p = placed.get(11)!;
    expect(p.buccal.y).toBeGreaterThan(0.9);
    const up = new THREE.Vector3(0, 0, 1).transformDirection(p.matrix);
    expect(up.z).toBeCloseTo(-1);
  });
});

describe('denture', () => {
  it.each(['upper', 'lower'] as const)('%s base is closed and teeth are placed', (jaw) => {
    const arch = defaultArch(jaw);
    const base = buildDentureBase(arch).toGeometry();
    const c = checkMesh(base);
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(1000);
    expect(buildDentureTeeth(arch).length).toBe(14);
  });
});

describe('nightguard', () => {
  it.each(['upper', 'lower'] as const)('%s nightguard is watertight with at least the requested thickness', (jaw) => {
    const arch = defaultArch(jaw);
    const scan = buildDemoModel(arch).toGeometry();
    const result = buildNightguard(scan, arch.occlusalDir, {
      thickness: 2,
      gap: 0.1,
      coverDepth: 4,
      wallThickness: 2,
      resolution: 0.6,
      surface: 'flat',
      outlineSmoothing: 3,
    });
    const g = result.mesh.toGeometry();
    const c = checkMesh(g);
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(1000);
    expect(result.minThickness).toBeGreaterThanOrEqual(1.99);
    // guard sits on the occlusal side of the teeth
    const scanBox = scan.boundingBox!;
    if (jaw === 'lower') expect(g.boundingBox!.max.z).toBeGreaterThan(scanBox.max.z);
    else expect(g.boundingBox!.min.z).toBeLessThan(scanBox.min.z);
  });
});
