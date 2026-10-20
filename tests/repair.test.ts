import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { checkMesh } from '../src/geometry/MeshBuilder';
import { buildSolidTooth, shapeFromTooth } from '../src/geometry/toothShape';
import { getTooth } from '../src/core/teeth';
import { inspect, fillHoles, removeSmallShells, weldAndClean, fixNormals, planeCut } from '../src/geometry/repair';
import { Sculptor } from '../src/geometry/sculpt';

const tooth = () => buildSolidTooth(shapeFromTooth(getTooth(36)), 2).toGeometry();

/** Remove the triangles touching a small region to punch a hole. */
function punchHole(g: THREE.BufferGeometry, center: THREE.Vector3, r: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const idx = Array.from(g.getIndex()!.array);
  const keep: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3().fromBufferAttribute(pos, idx[t + k]));
    if (c.divideScalar(3).distanceTo(center) > r) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const out = g.clone();
  out.setIndex(keep);
  return out;
}

describe('inspector and hole filling', () => {
  it('reports a watertight tooth as clean', () => {
    const r = inspect(tooth());
    expect(r.watertight).toBe(true);
    expect(r.holes.length).toBe(0);
    expect(r.shells).toBe(1);
  });

  it('finds a punched hole and fills it watertight', () => {
    const g = tooth();
    g.computeBoundingBox();
    const side = new THREE.Vector3(g.boundingBox!.max.x, 0, 3);
    const holed = punchHole(g, side, 1.5);
    const r = inspect(holed);
    expect(r.holes.length).toBe(1);
    expect(r.watertight).toBe(false);
    const { geometry, filled } = fillHoles(holed);
    expect(filled).toBe(1);
    const c = checkMesh(geometry);
    expect(c.watertight).toBe(true);
    // the patch follows the surrounding surface: volume close to the original
    expect(c.volume).toBeCloseTo(checkMesh(g).volume, -1);
  });

  it('skips holes above the size limit', () => {
    const g = tooth();
    g.computeBoundingBox();
    const holed = punchHole(g, new THREE.Vector3(g.boundingBox!.max.x, 0, 3), 1.5);
    expect(fillHoles(holed, 0.5).filled).toBe(0);
  });
});

describe('cleanup', () => {
  it('removes floating debris', () => {
    const a = tooth();
    const debris = new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(20, 0, 0);
    const merged = weldAndClean(new THREE.BufferGeometry().copy(a)).geometry;
    const both = new THREE.BufferGeometry();
    const pa = Array.from(merged.getAttribute('position').array as Float32Array);
    const ia = Array.from(merged.getIndex()!.array);
    const dbg = weldAndClean(debris).geometry;
    const pb = Array.from(dbg.getAttribute('position').array as Float32Array);
    const ib = Array.from(dbg.getIndex()!.array).map((i) => i + pa.length / 3);
    both.setAttribute('position', new THREE.Float32BufferAttribute([...pa, ...pb], 3));
    both.setIndex([...ia, ...ib]);
    expect(inspect(both).shells).toBe(2);
    const { geometry, removed } = removeSmallShells(both, 0.05);
    expect(removed).toBe(1);
    expect(inspect(geometry).shells).toBe(1);
  });

  it('welds an unindexed STL-style mesh into a closed solid', () => {
    const soup = tooth().toNonIndexed();
    const { geometry } = weldAndClean(soup);
    expect(checkMesh(geometry).watertight).toBe(true);
  });

  it('fixes flipped triangles', () => {
    const g = tooth();
    const idx = g.getIndex()!;
    for (let t = 0; t < 300; t += 3) {
      const b = idx.getX(t * 3 + 1);
      idx.setX(t * 3 + 1, idx.getX(t * 3 + 2));
      idx.setX(t * 3 + 2, b);
    }
    const { geometry, flipped } = fixNormals(g);
    expect(flipped).toBeGreaterThan(0);
    const c = checkMesh(geometry);
    expect(c.watertight).toBe(true);
    expect(c.volume).toBeCloseTo(checkMesh(tooth()).volume, 3);
  });

  it('plane-cuts and closes the cut flat', () => {
    const g = tooth();
    const cut = planeCut(g, new THREE.Plane(new THREE.Vector3(0, 0, 1), -2)); // keep z ≥ 2
    const c = checkMesh(cut);
    expect(c.watertight).toBe(true);
    cut.computeBoundingBox();
    expect(cut.boundingBox!.min.z).toBeCloseTo(2, 3);
    expect(c.volume).toBeLessThan(checkMesh(g).volume);
  });
});

describe('sculpt brushes', () => {
  const center = (g: THREE.BufferGeometry) => {
    g.computeBoundingBox();
    return new THREE.Vector3(g.boundingBox!.max.x, 0, 3);
  };

  it('draw raises and remove lowers the surface, keeping it closed', () => {
    const g = tooth();
    const v0 = checkMesh(g).volume;
    const s = new Sculptor(g);
    for (let i = 0; i < 5; i++) s.dab('draw', center(tooth()), { radius: 2, strength: 0.6 });
    s.commit();
    const v1 = checkMesh(g).volume;
    expect(v1).toBeGreaterThan(v0);
    for (let i = 0; i < 10; i++) s.dab('remove', center(tooth()), { radius: 2, strength: 0.6 });
    expect(checkMesh(g).volume).toBeLessThan(v1);
    expect(checkMesh(g).watertight).toBe(true);
  });

  it('smooth reduces roughness', () => {
    const g = tooth();
    const s = new Sculptor(g);
    const pos = g.getAttribute('position');
    // add noise near the brush
    const c = center(tooth());
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      if (p.distanceTo(c) < 2) pos.setXYZ(i, p.x + (Math.random() - 0.5) * 0.4, p.y, p.z);
    }
    const idx = g.getIndex()!;
    const nb = new Map<number, Set<number>>();
    for (let t = 0; t < idx.count; t += 3) {
      const tri = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      for (const a of tri) for (const b of tri) if (a !== b) (nb.get(a) ?? nb.set(a, new Set()).get(a)!).add(b);
    }
    // roughness: mean distance of each vertex from the average of its neighbours
    const rough = () => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < pos.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(pos, i);
        if (p.distanceTo(c) > 1.5) continue;
        const avg = new THREE.Vector3();
        for (const j of nb.get(i)!) avg.add(new THREE.Vector3().fromBufferAttribute(pos, j));
        sum += avg.divideScalar(nb.get(i)!.size).distanceTo(p);
        n++;
      }
      return sum / n;
    };
    const before = rough();
    for (let i = 0; i < 6; i++) s.dab('smooth', c, { radius: 2.5, strength: 1 });
    expect(rough()).toBeLessThan(before);
  });

  it('grab moves a region with falloff', () => {
    const g = tooth();
    const s = new Sculptor(g);
    const c = center(tooth());
    s.beginGrab(c, { radius: 2, strength: 1 });
    const moved = s.grabTo(new THREE.Vector3(1, 0, 0), 1);
    s.endGrab();
    expect(moved.length).toBeGreaterThan(0);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.x).toBeGreaterThan(c.x + 0.5);
  });
});
