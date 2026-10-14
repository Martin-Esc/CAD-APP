import * as THREE from 'three';
import { MeshBuilder } from './MeshBuilder';

export interface ConnectorParams {
  /** cross-sectional area in mm² (e.g. ≥ 9 mm² posterior zirconia, ≥ 16 mm² for long spans) */
  area: number;
  /** height / width ratio of the elliptical section (connectors are taller than wide) */
  aspect: number;
  /** relative height of the connector above the margin (0 = margin, 1 = cusp tip) */
  heightRatio: number;
}

export const DEFAULT_CONNECTOR: ConnectorParams = { area: 9, aspect: 1.3, heightRatio: 0.55 };

/**
 * Elliptical connector between two bridge units, built in world space from
 * the units' local->world matrices. Its ends are tapered so it blends into
 * the axial walls of both units.
 */
export function buildConnector(
  matA: THREE.Matrix4,
  heightA: number,
  matB: THREE.Matrix4,
  heightB: number,
  params: ConnectorParams = DEFAULT_CONNECTOR,
): MeshBuilder {
  const pA = new THREE.Vector3(0, 0, heightA * params.heightRatio).applyMatrix4(matA);
  const pB = new THREE.Vector3(0, 0, heightB * params.heightRatio).applyMatrix4(matB);
  const axis = pB.clone().sub(pA);
  const length = axis.length();
  axis.normalize();
  // "up" = average occlusal direction of both units, orthogonalised
  const upA = new THREE.Vector3(0, 0, 1).transformDirection(matA);
  const upB = new THREE.Vector3(0, 0, 1).transformDirection(matB);
  const up = upA.add(upB).normalize();
  up.sub(axis.clone().multiplyScalar(up.dot(axis))).normalize();
  const side = new THREE.Vector3().crossVectors(axis, up);

  // area = π · a · b with a (vertical) = aspect · b
  const b = Math.sqrt(params.area / (Math.PI * params.aspect));
  const a = b * params.aspect;
  const segments = 32;
  const stations = [0, 0.12, 0.3, 0.5, 0.7, 0.88, 1];
  // flare toward the units, narrowest (= specified area) in the middle
  const scaleAt = (s: number) => 1 + 0.9 * Math.pow(Math.abs(s - 0.5) * 2, 3);

  const mb = new MeshBuilder();
  const rings = stations.map((s) => {
    const c = pA.clone().addScaledVector(axis, s * length);
    const k = scaleAt(s);
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      ring.push(
        c.clone()
          .addScaledVector(side, Math.cos(t) * b * k)
          .addScaledVector(up, Math.sin(t) * a * k),
      );
    }
    return mb.addRing(ring);
  });
  for (let i = 0; i < rings.length - 1; i++) mb.stitchRings(rings[i], rings[i + 1]);
  mb.fan(mb.addPoint(pA), rings[0], true);
  mb.fan(mb.addPoint(pB), rings[rings.length - 1]);
  return mb.ensureOutward();
}
