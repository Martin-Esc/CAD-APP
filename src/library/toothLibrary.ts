import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { OuterSurface } from '../geometry/toothShape';
import { MeshBuilder } from '../geometry/MeshBuilder';
import { SURFACE_ALPHA, SURFACE_STEPS } from './analyze';

/**
 * Scanned tooth library, as built by `npm run build:library` into
 * public/library/teeth/. The manifest loads up front (its measured tooth
 * widths drive the arch layout); meshes load on demand and are cached.
 */

export interface ManifestTooth {
  fdi: number;
  universal: number;
  source: string;
  mesh: string;
  surface: string;
  mesiodistal: number;
  buccolingual: number;
  height: number;
  bottom: number;
}

export interface LibraryManifest {
  format: 'dental-cad-tooth-library';
  version: number;
  notes: string[];
  teeth: ManifestTooth[];
}

export interface LibraryTooth {
  info: ManifestTooth;
  /** closed mesh in the local tooth frame (cervical line on z = 0) */
  geometry: THREE.BufferGeometry;
  surface: LibrarySurface;
}

/** Fetches a file of the library by relative path. */
export type LibraryFetcher = (path: string) => Promise<ArrayBuffer>;

/** Where on the sampled s-axis the axial wall ends and the occlusal table begins. */
const S_RIM = 0.5;

/**
 * Outer surface of a library crown, from samples taken at build time (see
 * sampleSurface): SURFACE_ALPHA directions around the axis, SURFACE_STEPS
 * from the cervical line (s = 0) to the top (s = 1).
 */
export class LibrarySurface implements OuterSurface {
  readonly height: number;

  constructor(
    private readonly samples: Float32Array,
    private readonly sx = 1,
    private readonly sy = 1,
    private readonly sz = 1,
  ) {
    let top = 0;
    for (let i = 2; i < samples.length; i += 3) top = Math.max(top, samples[i]);
    this.height = top * sz;
  }

  private at(j: number, k: number, out: THREE.Vector3): THREE.Vector3 {
    const i = ((((j % SURFACE_ALPHA) + SURFACE_ALPHA) % SURFACE_ALPHA) * SURFACE_STEPS + k) * 3;
    return out.set(this.samples[i] * this.sx, this.samples[i + 1] * this.sy, this.samples[i + 2] * this.sz);
  }

  /** Bilinear interpolation in (alpha, s). */
  point(alpha: number, s: number): THREE.Vector3 {
    const fa = (((alpha / (Math.PI * 2)) % 1) + 1) % 1 * SURFACE_ALPHA;
    const j = Math.floor(fa);
    const wa = fa - j;
    const fk = THREE.MathUtils.clamp(s, 0, 1) * (SURFACE_STEPS - 1);
    const k = Math.min(SURFACE_STEPS - 2, Math.floor(fk));
    const wk = fk - k;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
    this.at(j, k, a).lerp(this.at(j + 1, k, b), wa);
    this.at(j, k + 1, c).lerp(this.at(j + 1, k + 1, d), wa);
    return a.lerp(c, wk);
  }

  semiAxes(t: number): [number, number] {
    let ax = 0;
    let by = 0;
    for (let j = 0; j < SURFACE_ALPHA; j++) {
      const p = this.point((j / SURFACE_ALPHA) * Math.PI * 2, t * S_RIM);
      ax = Math.max(ax, Math.abs(p.x));
      by = Math.max(by, Math.abs(p.y));
    }
    return [ax, by];
  }

  wallPointAt(alpha: number, t: number): THREE.Vector3 {
    return this.point(alpha, t * S_RIM);
  }

  capPointAt(alpha: number, r: number): THREE.Vector3 {
    return this.point(alpha, S_RIM + (1 - r) * (1 - S_RIM));
  }

  topPoint(): THREE.Vector3 {
    const c = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let j = 0; j < SURFACE_ALPHA; j++) c.add(this.at(j, SURFACE_STEPS - 1, p));
    return c.divideScalar(SURFACE_ALPHA);
  }

  scaled(sx: number, sy: number, sz = 1): LibrarySurface {
    return new LibrarySurface(this.samples, this.sx * sx, this.sy * sy, this.sz * sz);
  }

  /** Points on the cervical line (z ≈ 0), one per sampled direction. */
  cervicalRing(): THREE.Vector3[] {
    return Array.from({ length: SURFACE_ALPHA }, (_, j) => this.at(j, 0, new THREE.Vector3()));
  }
}

export class ToothLibrary {
  private readonly cache = new Map<number, Promise<LibraryTooth>>();
  private readonly loaded = new Map<number, LibraryTooth>();

  private constructor(
    readonly manifest: LibraryManifest,
    private readonly fetcher: LibraryFetcher,
  ) {}

  static async load(fetcher: LibraryFetcher): Promise<ToothLibrary> {
    const manifest = JSON.parse(new TextDecoder().decode(await fetcher('manifest.json'))) as LibraryManifest;
    if (manifest.format !== 'dental-cad-tooth-library') throw new Error('Not a tooth library manifest');
    return new ToothLibrary(manifest, fetcher);
  }

  has(fdi: number): boolean {
    return this.manifest.teeth.some((t) => t.fdi === fdi);
  }

  info(fdi: number): ManifestTooth | undefined {
    return this.manifest.teeth.find((t) => t.fdi === fdi);
  }

  /** Measured [mesiodistal, buccolingual, height] per tooth, for the arch layout. */
  dimensions(): Map<number, [number, number, number]> {
    return new Map(this.manifest.teeth.map((t) => [t.fdi, [t.mesiodistal, t.buccolingual, t.height]]));
  }

  tooth(fdi: number): Promise<LibraryTooth> {
    let p = this.cache.get(fdi);
    if (!p) {
      const info = this.info(fdi);
      if (!info) return Promise.reject(new Error(`Tooth ${fdi} is not in the library`));
      p = (async () => {
        const [stl, surf] = await Promise.all([this.fetcher(info.mesh), this.fetcher(info.surface)]);
        const raw = new STLLoader().parse(stl);
        raw.deleteAttribute('normal');
        const geometry = mergeVertices(raw, 1e-5);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        const tooth = { info, geometry, surface: new LibrarySurface(new Float32Array(surf)) };
        this.loaded.set(fdi, tooth);
        return tooth;
      })();
      this.cache.set(fdi, p);
    }
    return p;
  }

  /** A tooth that has already been loaded (see `tooth`), or undefined. */
  loadedTooth(fdi: number): LibraryTooth | undefined {
    return this.loaded.get(fdi);
  }
}

/**
 * Closed "root" stub below the cervical line of a library crown. Library
 * crowns end just below the cervical line; this extends them so they can be
 * seated in a denture base (sockets) or embedded in a model's gingiva.
 */
export function buildRootStub(surface: LibrarySurface, depth: number): MeshBuilder {
  const ring = surface.cervicalRing();
  const mb = new MeshBuilder();
  const top = 0.4; // starts inside the crown so the union is clean
  const k = 0.9;
  const steps = 6;
  const rings: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps) * (Math.PI / 2) * 0.95;
    const r = k * Math.cos(phi);
    const z = top - (top + depth) * Math.sin(phi) / Math.sin((Math.PI / 2) * 0.95);
    rings.push(mb.addRing(ring.map((p) => new THREE.Vector3(p.x * r, p.y * r, z))));
  }
  for (let i = 0; i < steps; i++) mb.stitchRings(rings[i + 1], rings[i]);
  mb.fan(mb.addVertex(0, 0, top), rings[0]);
  mb.fan(mb.addVertex(0, 0, -depth), rings[steps], true);
  return mb.ensureOutward();
}
