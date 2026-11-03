import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { checkMesh, MeshBuilder } from '../src/geometry/MeshBuilder';
import { buildDemoModel } from '../src/geometry/denture';
import { buildPrepStump, shapeFromTooth, DEFAULT_PREP, prepRings, ToothSurface, buildSolidTooth } from '../src/geometry/toothShape';
import { buildDieCrown } from '../src/geometry/dieCrown';
import { detectMargin } from '../src/geometry/margin';
import { estimateInsertionAxis, analyseAxis, undercutOverlay } from '../src/geometry/insertion';
import { adaptToObstacles, makeObstacleGeometry, thicknessValues, contactValues, signedDistance } from '../src/geometry/contacts';
import { defaultArch, placeTeeth } from '../src/core/arch';
import { getTooth } from '../src/core/teeth';
import { MATERIALS, minimumConnectorArea, isAnteriorConnector } from '../src/core/materials';

const Z = new THREE.Vector3(0, 0, 1);

/** A parametric die (local frame) and its margin ring. */
function parametricDie(fdi = 36) {
  const shape = shapeFromTooth(getTooth(fdi));
  const die = buildPrepStump(shape, DEFAULT_PREP, 3).toGeometry();
  const margin = prepRings(new ToothSurface(shape), DEFAULT_PREP, 0).rings[0];
  return { shape, die, margin };
}

describe('insertion axis', () => {
  it('keeps the occlusal axis for a tapered die without undercuts', () => {
    const { die, margin } = parametricDie();
    const r = estimateInsertionAxis(die, margin, Z);
    expect(r.undercut).toBeLessThan(0.05);
    expect(r.tilt).toBeLessThan(1);
  });

  it('finds the true axis of a tilted die', () => {
    const { die, margin } = parametricDie();
    const tilt = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(15));
    const tiltedDie = die.clone().applyMatrix4(tilt);
    const tiltedMargin = margin.map((p) => p.clone().applyMatrix4(tilt));
    const trueAxis = Z.clone().applyMatrix4(tilt).normalize();
    const atOcclusal = analyseAxis(tiltedDie, tiltedMargin, Z, Z);
    const found = estimateInsertionAxis(tiltedDie, tiltedMargin, Z);
    expect(atOcclusal.undercut).toBeGreaterThan(1); // the occlusal direction sees undercuts
    // every axis inside the 6° wall taper of the true axis is undercut-free; the search
    // returns the one closest to the occlusal direction
    expect(found.undercut).toBeLessThan(0.05);
    expect(found.axis.angleTo(trueAxis)).toBeLessThan(THREE.MathUtils.degToRad(6 + 2));
    expect(found.tilt).toBeLessThan(15);
    expect(undercutOverlay(tiltedDie, tiltedMargin, Z).getAttribute('position').count).toBeGreaterThan(0);
  });
});

describe('cement gap and block-out', () => {
  it('blocks out an undercut die so the crown can seat along the axis', () => {
    const { shape, die, margin } = parametricDie();
    // bulge the die outward above the margin -> undercut for a vertical insertion
    const pos = die.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z > 1 && z < 3) {
        const k = 1 + 0.25 * Math.sin(((z - 1) / 2) * Math.PI);
        pos.setXY(i, pos.getX(i) * k, pos.getY(i) * k);
      }
    }
    const blocked = buildDieCrown(die, margin, new THREE.Matrix4(), shape, { ...DEFAULT_PREP, blockOut: true });
    const raw = buildDieCrown(die, margin, new THREE.Matrix4(), shape, { ...DEFAULT_PREP, blockOut: false });
    expect(blocked.blockedOut).toBeGreaterThan(0.2);
    expect(raw.blockedOut).toBe(0);
    expect(checkMesh(blocked.mesh.toGeometry()).watertight).toBe(true);
    // the blocked-out intaglio never widens going up: its radius profile is monotone
    const pts = blocked.cavity.positions;
    let violations = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const r = Math.hypot(pts[i], pts[i + 1]);
      const z = pts[i + 2];
      if (z > 0.5 && r > 4.6) violations++;
    }
    expect(violations).toBe(0);
  });

  it('applies the cement gap with transition and extra spacing', () => {
    const { shape, die, margin } = parametricDie();
    const thin = buildDieCrown(die, margin, new THREE.Matrix4(), shape, { ...DEFAULT_PREP, cementGap: 0.05, extraSpacing: 0 });
    const thick = buildDieCrown(die, margin, new THREE.Matrix4(), shape, { ...DEFAULT_PREP, cementGap: 0.05, extraSpacing: 0.1 });
    // more spacing -> less crown material
    expect(checkMesh(thick.mesh.toGeometry()).volume).toBeLessThan(checkMesh(thin.mesh.toGeometry()).volume - 1);
  });
});

describe('contacts', () => {
  it('pushes a crown out of the antagonist to the requested clearance', () => {
    const { shape, die, margin } = parametricDie();
    const crown = buildDieCrown(die, margin, new THREE.Matrix4(), shape, DEFAULT_PREP);
    const g = crown.mesh.toGeometry();
    g.computeBoundingBox();
    const top = g.boundingBox!.max.z;
    // an antagonist slab whose lower face cuts 0.5 mm into the crown
    const slab = new THREE.BoxGeometry(30, 30, 4).translate(0, 0, top - 0.5 + 2);
    const ob = makeObstacleGeometry(slab);
    const obstacle = { ...ob, clearance: 0.1 };
    const weight = new Float32Array(crown.mesh.vertexCount);
    for (let i = crown.marginVertexCount; i < crown.outerVertexCount; i++) weight[i] = 1;
    const before = Math.min(...Array.from(contactValues(g, new THREE.Matrix4(), [obstacle])));
    expect(before).toBeLessThan(-0.3);
    const marginBefore = crown.mesh.positions.slice(0, crown.marginVertexCount * 3);
    const r = adaptToObstacles(crown.mesh, weight, [obstacle]);
    expect(r.moved).toBeGreaterThan(0);
    const after = crown.mesh.toGeometry();
    const minDist = Math.min(...Array.from(contactValues(after, new THREE.Matrix4(), [obstacle])));
    expect(minDist).toBeGreaterThan(0.1 - 0.02);
    expect(checkMesh(after).watertight).toBe(true);
    // the margin did not move
    expect(crown.mesh.positions.slice(0, crown.marginVertexCount * 3)).toEqual(marginBefore);
  });

  it('measures signed distance with the sign of the obstacle side', () => {
    const ob = { ...makeObstacleGeometry(new THREE.BoxGeometry(2, 2, 2)), clearance: 0 };
    expect(signedDistance(ob, new THREE.Vector3(0, 0, 1.5), 2)!.d).toBeCloseTo(0.5, 3);
    expect(signedDistance(ob, new THREE.Vector3(0, 0, 0.7), 2)!.d).toBeCloseTo(-0.3, 3);
  });

  it('adapts a crown on the demo model against the antagonist scan', () => {
    const lower = defaultArch('lower');
    const upper = defaultArch('upper');
    const scan = buildDemoModel(lower, { preps: [36] }).toGeometry();
    const antagonist = buildDemoModel(upper).toGeometry();
    const p = placeTeeth(lower).get(36)!;
    const crown = buildDieCrown(scan, detectMargin(scan, p.center, Z), new THREE.Matrix4().extractRotation(p.matrix), shapeFromTooth(getTooth(36)), DEFAULT_PREP);
    const weight = new Float32Array(crown.mesh.vertexCount);
    for (let i = crown.marginVertexCount; i < crown.outerVertexCount; i++) weight[i] = 1;
    const obstacle = { ...makeObstacleGeometry(antagonist), clearance: 0.05 };
    adaptToObstacles(crown.mesh, weight, [obstacle]);
    const d = contactValues(crown.mesh.toGeometry(), new THREE.Matrix4(), [obstacle]);
    expect(Math.min(...Array.from(d))).toBeGreaterThan(0.05 - 0.03);
  });
});

describe('thickness map', () => {
  it('reports the wall thickness of a shell', () => {
    // 1 mm thick spherical shell
    const outer = MeshBuilder.fromGeometry(new THREE.SphereGeometry(5, 48, 32));
    const inner = MeshBuilder.fromGeometry(new THREE.SphereGeometry(4, 48, 32)).flipWinding();
    outer.append(inner);
    const g = outer.toGeometry();
    const t = thicknessValues(g);
    const finite = Array.from(t).filter(Number.isFinite);
    expect(finite.length).toBeGreaterThan(t.length - 8); // a few degenerate pole vertices of the test sphere
    const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
    expect(mean).toBeGreaterThan(0.95);
    expect(mean).toBeLessThan(1.1);
  });

  it('finds a thin spot on a crown', () => {
    const shape = shapeFromTooth(getTooth(46));
    const solid = buildSolidTooth(shape).toGeometry();
    const t = thicknessValues(solid);
    expect(Math.min(...Array.from(t))).toBeGreaterThan(0.1);
  });
});

describe('materials', () => {
  it('uses larger connectors posteriorly and for long spans', () => {
    const zr = MATERIALS.find((m) => m.id === 'zirconia')!;
    expect(isAnteriorConnector(12, 11)).toBe(true);
    expect(isAnteriorConnector(14, 15)).toBe(false);
    expect(minimumConnectorArea(zr, 35, 36, false)).toBeGreaterThan(minimumConnectorArea(zr, 12, 11, false));
    expect(minimumConnectorArea(zr, 35, 36, true)).toBeGreaterThan(minimumConnectorArea(zr, 35, 36, false));
  });
});

describe('minimum thickness', () => {
  it('holds the minimum wall thickness measured perpendicular to the surface', () => {
    const arch = defaultArch('lower');
    const scan = buildDemoModel(arch, { preps: [36] }).toGeometry();
    const p = placeTeeth(arch).get(36)!;
    const prep = { ...DEFAULT_PREP, axialThickness: 0.8, occlusalThickness: 1.0, extraSpacing: 0.02, cementGap: 0.06 };
    const r = buildDieCrown(scan, detectMargin(scan, p.center, new THREE.Vector3(0, 0, 1)), new THREE.Matrix4().extractRotation(p.matrix), shapeFromTooth(getTooth(36)), prep);
    const g = r.mesh.toGeometry();
    const t = thicknessValues(g);
    const toLocal = r.frame.clone().invert();
    const pos = g.getAttribute('position');
    let min = Infinity;
    for (let i = 0; i < r.outerVertexCount; i++) {
      const q = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toLocal);
      if (q.z > 1.5 && Number.isFinite(t[i])) min = Math.min(min, t[i]);
    }
    expect(min).toBeGreaterThan(0.8 - 0.06);
  });
});
