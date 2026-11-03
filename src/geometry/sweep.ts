import * as THREE from 'three';
import { MeshBuilder } from './MeshBuilder';
import { archCurve, type ArchDefinition } from '../core/arch';

/**
 * Sweep a closed 2D profile along the arch curve.
 *
 * Profile points are (n, h): n = offset toward buccal (mm, negative = lingual),
 * h = height toward occlusal from the arch margin plane. The profile may
 * vary along the arch through `profileAt(u)` (u = 0..1 from right to left).
 */
export function sweepAlongArch(
  arch: ArchDefinition,
  profileAt: (u: number) => [number, number][],
  options: { samples?: number; extend?: number } = {},
): MeshBuilder {
  const samples = options.samples ?? 96;
  const extend = options.extend ?? 0;
  const curve = archCurve(arch);
  const centroid = arch.points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(arch.points.length);
  const mb = new MeshBuilder();
  const rings: number[][] = [];
  let ringSize = -1;

  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const uc = THREE.MathUtils.clamp(u, 0, 1);
    const tangent = curve.getTangentAt(uc).setZ(0).normalize();
    // extend straight beyond both ends (distal of the last molars)
    const along = i === 0 ? -extend : i === samples ? extend : 0;
    const p = curve.getPointAt(uc).addScaledVector(tangent, along);
    let normal = new THREE.Vector3(tangent.y, -tangent.x, 0);
    if (normal.dot(p.clone().sub(centroid).setZ(0)) < 0) normal.negate();
    const profile = profileAt(u);
    if (ringSize < 0) ringSize = profile.length;
    if (profile.length !== ringSize) throw new Error('Profile vertex count must be constant');
    rings.push(
      mb.addRing(
        profile.map(([n, h]) =>
          new THREE.Vector3(p.x + normal.x * n, p.y + normal.y * n, arch.marginZ + arch.occlusalDir * h),
        ),
      ),
    );
  }
  for (let i = 0; i < rings.length - 1; i++) mb.stitchRings(rings[i], rings[i + 1]);

  const capCenter = (ids: number[]) => {
    const c = new THREE.Vector3();
    for (const id of ids) c.add(new THREE.Vector3().fromArray(mb.positions, id * 3));
    return mb.addPoint(c.divideScalar(ids.length));
  };
  mb.fan(capCenter(rings[0]), rings[0], true);
  mb.fan(capCenter(rings[rings.length - 1]), rings[rings.length - 1]);
  return mb.ensureOutward();
}

/**
 * Closed slab filling the inside of the arch (palate). `rim` is a sampled
 * closed outline in world space at the slab's rim height; the slab domes
 * toward `vaultHeight` (along the arch's anti-occlusal direction).
 */
export function palateSlab(arch: ArchDefinition, rim: THREE.Vector3[], vaultHeight: number, thickness: number): MeshBuilder {
  const mb = new MeshBuilder();
  const center = rim.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(rim.length);
  const away = new THREE.Vector3(0, 0, -arch.occlusalDir);
  const rings = 6;
  const top: number[][] = [];
  const bottom: number[][] = [];
  for (let k = 0; k < rings; k++) {
    const s = k / rings; // 0 = rim, -> centre
    const dome = Math.sin((s * Math.PI) / 2) * vaultHeight;
    const pts = rim.map((p) => p.clone().lerp(center, s).addScaledVector(away, dome));
    top.push(mb.addRing(pts.map((p) => p.clone())));
    bottom.push(mb.addRing(pts.map((p) => p.clone().addScaledVector(away, -thickness))));
  }
  const apexTop = mb.addPoint(center.clone().addScaledVector(away, vaultHeight));
  const apexBottom = mb.addPoint(center.clone().addScaledVector(away, vaultHeight - thickness));
  for (let k = 0; k < rings - 1; k++) {
    mb.stitchRings(top[k], top[k + 1]);
    mb.stitchRings(bottom[k + 1], bottom[k]);
  }
  mb.fan(apexTop, top[rings - 1]);
  mb.fan(apexBottom, bottom[rings - 1], true);
  mb.stitchRings(bottom[0], top[0]);
  return mb.ensureOutward();
}
