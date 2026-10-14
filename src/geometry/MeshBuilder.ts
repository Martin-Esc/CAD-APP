import * as THREE from 'three';

/**
 * Small indexed-mesh builder. All generators in this project build their
 * surfaces from rings of shared vertices so the resulting meshes are
 * watertight (every edge shared by exactly two triangles), which is a hard
 * requirement for milling and 3D printing.
 */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  addVertex(x: number, y: number, z: number): number {
    this.positions.push(x, y, z);
    return this.vertexCount - 1;
  }

  addPoint(p: THREE.Vector3): number {
    return this.addVertex(p.x, p.y, p.z);
  }

  addRing(points: THREE.Vector3[]): number[] {
    return points.map((p) => this.addPoint(p));
  }

  addTri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  addQuad(a: number, b: number, c: number, d: number): void {
    // a-b-c-d counter-clockwise when seen from the front face
    this.addTri(a, b, c);
    this.addTri(a, c, d);
  }

  /**
   * Connect two closed rings with the same vertex count. With both rings
   * running counter-clockwise (seen from +z) and `upper` above `lower`, the
   * strip faces outward.
   */
  stitchRings(lower: number[], upper: number[]): void {
    const n = lower.length;
    if (upper.length !== n) throw new Error('Rings must have the same vertex count');
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.addQuad(lower[i], lower[j], upper[j], upper[i]);
    }
  }

  /** Connect two open polylines (not wrapped). */
  stitchStrips(lower: number[], upper: number[]): void {
    const n = lower.length;
    if (upper.length !== n) throw new Error('Strips must have the same vertex count');
    for (let i = 0; i < n - 1; i++) {
      this.addQuad(lower[i], lower[i + 1], upper[i + 1], upper[i]);
    }
  }

  /** Close a ring with a fan to a centre vertex. `outward` flips the winding. */
  fan(center: number, ring: number[], flip = false): void {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) this.addTri(center, ring[j], ring[i]);
      else this.addTri(center, ring[i], ring[j]);
    }
  }

  /** Append another builder's mesh (e.g. to combine several closed shells). */
  append(other: MeshBuilder): void {
    const offset = this.vertexCount;
    this.positions.push(...other.positions);
    for (const i of other.indices) this.indices.push(i + offset);
  }

  transform(m: THREE.Matrix4): this {
    const v = new THREE.Vector3();
    for (let i = 0; i < this.positions.length; i += 3) {
      v.set(this.positions[i], this.positions[i + 1], this.positions[i + 2]).applyMatrix4(m);
      this.positions[i] = v.x;
      this.positions[i + 1] = v.y;
      this.positions[i + 2] = v.z;
    }
    if (m.determinant() < 0) this.flipWinding();
    return this;
  }

  flipWinding(): this {
    for (let i = 0; i < this.indices.length; i += 3) {
      const t = this.indices[i + 1];
      this.indices[i + 1] = this.indices[i + 2];
      this.indices[i + 2] = t;
    }
    return this;
  }

  signedVolume(): number {
    const p = this.positions;
    let v = 0;
    for (let i = 0; i < this.indices.length; i += 3) {
      const a = this.indices[i] * 3;
      const b = this.indices[i + 1] * 3;
      const c = this.indices[i + 2] * 3;
      v +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
          p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6;
    }
    return v;
  }

  /** Make a consistently wound closed mesh face outward. */
  ensureOutward(): this {
    if (this.signedVolume() < 0) this.flipWinding();
    return this;
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setIndex(this.indices);
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

export interface MeshCheck {
  triangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  watertight: boolean;
  /** Signed volume in mm³ (positive for outward-facing closed meshes). */
  volume: number;
}

/** Topology / volume check used by tests and the "Check mesh" UI action. */
export function checkMesh(geometry: THREE.BufferGeometry): MeshCheck {
  const index = geometry.getIndex();
  const pos = geometry.getAttribute('position');
  if (!index) throw new Error('checkMesh requires an indexed geometry');
  const edges = new Map<string, number>();
  let volume = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (let k = 0; k < 3; k++) {
      const u = tri[k];
      const v = tri[(k + 1) % 3];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    a.fromBufferAttribute(pos, tri[0]);
    b.fromBufferAttribute(pos, tri[1]);
    c.fromBufferAttribute(pos, tri[2]);
    volume += a.dot(b.clone().cross(c)) / 6;
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edges.values()) {
    if (count === 1) boundaryEdges++;
    else if (count > 2) nonManifoldEdges++;
  }
  return {
    triangles: index.count / 3,
    boundaryEdges,
    nonManifoldEdges,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0,
    volume,
  };
}
