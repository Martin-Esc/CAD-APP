import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { checkMesh, MeshBuilder } from '../src/geometry/MeshBuilder';
import { union, subtract } from '../src/geometry/csg';
import { buildCrownShell, buildCrownCavity, buildSolidTooth, shapeFromTooth, DEFAULT_PREP } from '../src/geometry/toothShape';
import { buildConnector } from '../src/geometry/connector';
import {
  buildDentureBaseParts,
  buildDentureTeeth,
  buildSocketedBase,
  buildMergedDenture,
  buildDemoModel,
  validateDenture,
  DEFAULT_DENTURE,
} from '../src/geometry/denture';
import { detectMargin, resampleByAngle, MARGIN_SAMPLES } from '../src/geometry/margin';
import { buildDieCrown } from '../src/geometry/dieCrown';
import { defaultArch, placeTeeth } from '../src/core/arch';
import { getTooth } from '../src/core/teeth';

function closed(mb: MeshBuilder) {
  return checkMesh(mb.toGeometry());
}

/** Topology after an STL round trip: float32 coordinates, welded at 10 µm. */
function closedAfterStl(mb: MeshBuilder) {
  const g = mb.toGeometry().toNonIndexed();
  g.deleteAttribute('normal');
  return checkMesh(mergeVertices(g, 1e-5));
}

/** Count connected shells via union-find over shared vertices. */
function shells(mb: MeshBuilder): number {
  const parent = Array.from({ length: mb.vertexCount }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < mb.indices.length; i += 3) {
    const a = find(mb.indices[i]);
    parent[find(mb.indices[i + 1])] = a;
    parent[find(mb.indices[i + 2])] = a;
  }
  const used = new Set(mb.indices);
  return new Set([...used].map(find)).size;
}

describe('csg (manifold-3d)', () => {
  it('unions two overlapping teeth into one closed shell', async () => {
    const a = buildSolidTooth(shapeFromTooth(getTooth(36)));
    const b = buildSolidTooth(shapeFromTooth(getTooth(36))).transform(new THREE.Matrix4().makeTranslation(6, 0, 0));
    const merged = await union([a, b]);
    const c = closed(merged);
    expect(c.watertight).toBe(true);
    expect(shells(merged)).toBe(1);
    expect(c.volume).toBeLessThan(closed(a).volume * 2);
    expect(c.volume).toBeGreaterThan(closed(a).volume);
  });

  it('subtracts a grown copy to make a shell of the offset thickness', async () => {
    const tooth = buildSolidTooth(shapeFromTooth(getTooth(46)));
    const grown = tooth.offset(0.2);
    const shell = await subtract([grown], [tooth]);
    expect(closed(shell).watertight).toBe(true);
    // volume ≈ surface area × 0.2 mm – just check it is a thin positive shell
    expect(closed(shell).volume).toBeGreaterThan(5);
    expect(closed(shell).volume).toBeLessThan(closed(tooth).volume * 0.3);
  });
});

describe('merged bridge', () => {
  it('fuses a 3-unit bridge into one solid with clear intaglios', async () => {
    const arch = defaultArch('lower');
    const placed = placeTeeth(arch);
    const parts: MeshBuilder[] = [];
    const cavities: MeshBuilder[] = [];
    for (const fdi of [34, 35, 36]) {
      const shape = shapeFromTooth(getTooth(fdi));
      const m = placed.get(fdi)!.matrix;
      if (fdi === 35) parts.push(buildSolidTooth(shape, 1).transform(m));
      else {
        parts.push(buildCrownShell(shape).transform(m));
        cavities.push(buildCrownCavity(shape, DEFAULT_PREP).transform(m));
      }
    }
    parts.push(buildConnector(placed.get(34)!.matrix, 8.5, placed.get(35)!.matrix, 8));
    parts.push(buildConnector(placed.get(35)!.matrix, 8, placed.get(36)!.matrix, 7.5));
    const bridge = await subtract(parts, cavities);
    expect(closed(bridge).watertight).toBe(true);
    expect(closedAfterStl(bridge).watertight).toBe(true);
    expect(shells(bridge)).toBe(1);
    // the intaglio of 34 must stay open: a point inside its prep is outside the bridge
    const inside = new THREE.Vector3(0, 0, 2).applyMatrix4(placed.get(34)!.matrix);
    const ray = new THREE.Raycaster(inside, new THREE.Vector3(0, 0, -1));
    const hits = ray.intersectObject(new THREE.Mesh(bridge.toGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
    // straight down from inside the intaglio we leave through the open margin: no surface below
    expect(hits.length).toBe(0);
  });
});

describe('two-piece denture', () => {
  it('cuts sockets with the tolerance gap and keeps the base closed', async () => {
    const arch = defaultArch('lower');
    const p = { ...DEFAULT_DENTURE, twoPiece: true, tolerance: 0.15 };
    const baseParts = buildDentureBaseParts(arch, p);
    const teeth = buildDentureTeeth(arch, p).map((t) => t.mesh.clone().transform(t.matrix));
    const base = await buildSocketedBase(baseParts, teeth, p.tolerance);
    const solidBase = await union(baseParts);
    expect(closed(base).watertight).toBe(true);
    expect(closedAfterStl(base).watertight).toBe(true);
    expect(closed(base).volume).toBeLessThan(closed(solidBase).volume - 50);
    // teeth + tolerance never overlap the socketed base
    const overlap = await union([base, ...teeth]);
    const sum = closed(base).volume + teeth.reduce((s, t) => s + closed(t).volume, 0);
    expect(closed(overlap).volume).toBeGreaterThan(sum - 0.5);
  });

  it('merges a one-piece denture into a single solid', async () => {
    const arch = defaultArch('lower');
    const baseParts = buildDentureBaseParts(arch, DEFAULT_DENTURE);
    const teeth = buildDentureTeeth(arch).map((t) => t.mesh.clone().transform(t.matrix));
    const merged = await buildMergedDenture(baseParts, teeth);
    expect(closed(merged).watertight).toBe(true);
    expect(closedAfterStl(merged).watertight).toBe(true);
    expect(shells(merged)).toBe(1);
  });

  it('warns when sockets are too deep', () => {
    expect(validateDenture({ ...DEFAULT_DENTURE, twoPiece: true, socketDepth: 3.2 })).not.toEqual([]);
    expect(validateDenture({ ...DEFAULT_DENTURE, twoPiece: true })).toEqual([]);
  });
});

describe('margin detection and die crown', () => {
  const arch = defaultArch('lower');
  const placed = placeTeeth(arch);
  const scan = buildDemoModel(arch, { preps: [36] }).toGeometry();
  const p36 = placed.get(36)!;
  const axis = new THREE.Vector3(0, 0, 1);

  it('finds the finish line of a prepared tooth on the model', () => {
    const margin = detectMargin(scan, p36.center, axis);
    expect(margin.length).toBe(MARGIN_SAMPLES);
    // demo preps have their margin on the cervical plane (z = 0)
    for (const p of margin) expect(Math.abs(p.z - p36.center.z)).toBeLessThan(0.35);
    const radii = margin.map((p) => Math.hypot(p.x - p36.center.x, p.y - p36.center.y));
    expect(Math.min(...radii)).toBeGreaterThan(2.5);
    expect(Math.max(...radii)).toBeLessThan(6.5);
  });

  it('resamples a hand-drawn loop to regular angles', () => {
    const drawn = Array.from({ length: 9 }, (_, i) => {
      const a = (i / 9) * Math.PI * 2;
      return new THREE.Vector3(4 * Math.cos(a), 3 * Math.sin(a), 0.2 * Math.sin(3 * a));
    });
    const loop = resampleByAngle(drawn, new THREE.Vector3(), axis);
    expect(loop.length).toBe(MARGIN_SAMPLES);
    for (let j = 0; j < loop.length; j++) {
      const angle = (Math.atan2(loop[j].y, loop[j].x) + 2 * Math.PI) % (2 * Math.PI);
      const target = (j / MARGIN_SAMPLES) * Math.PI * 2;
      const d = Math.min(Math.abs(angle - target), 2 * Math.PI - Math.abs(angle - target));
      expect(d).toBeLessThan(0.06);
    }
  });

  it('builds a closed die-fitted crown with cement gap and minimum thickness', () => {
    const margin = detectMargin(scan, p36.center, axis);
    const basis = new THREE.Matrix4().extractRotation(p36.matrix);
    const prep = { ...DEFAULT_PREP, cementGap: 0.08, marginSeal: 0.8 };
    const result = buildDieCrown(scan, margin, basis, shapeFromTooth(getTooth(36)), prep);
    const c = closed(result.mesh);
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeGreaterThan(30);
    expect(closed(result.cavity).watertight).toBe(true);
    expect(result.minThickness).toBeGreaterThanOrEqual(Math.min(prep.axialThickness, prep.occlusalThickness) - 0.05);
    // the crown's margin is the detected margin
    const g = result.mesh.toGeometry();
    const pos = g.getAttribute('position');
    const pts = Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    for (const mp of margin.filter((_, i) => i % 6 === 0)) {
      const nearest = Math.min(...pts.map((p) => p.distanceTo(mp)));
      expect(nearest).toBeLessThan(0.3);
    }
  });
});

describe('merged die-fitted bridge', () => {
  it('fuses die crowns, pontic and connectors into one STL-safe solid', async () => {
    const arch = defaultArch('lower');
    const placed = placeTeeth(arch);
    const scan = buildDemoModel(arch, { preps: [34, 36] }).toGeometry();
    const crowns = [34, 36].map((fdi) => {
      const p = placed.get(fdi)!;
      const margin = detectMargin(scan, p.center, new THREE.Vector3(0, 0, 1));
      return buildDieCrown(scan, margin, new THREE.Matrix4().extractRotation(p.matrix), shapeFromTooth(getTooth(fdi)), DEFAULT_PREP);
    });
    const m35 = placed.get(35)!.matrix;
    const parts = [
      crowns[0].mesh,
      crowns[1].mesh,
      buildSolidTooth(shapeFromTooth(getTooth(35)), 1).transform(m35),
      buildConnector(crowns[0].frame, crowns[0].height, m35, 8),
      buildConnector(m35, 8, crowns[1].frame, crowns[1].height),
    ];
    const bridge = await subtract(parts, crowns.map((c) => c.cavity));
    expect(closed(bridge).watertight).toBe(true);
    expect(closedAfterStl(bridge).watertight).toBe(true);
    expect(shells(bridge)).toBe(1);
  });
});
