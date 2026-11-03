import * as THREE from 'three';
import { MeshBuilder } from '../geometry/MeshBuilder';
import { buildSolidTooth, shapeFromTooth, ToothSurface, type OuterSurface } from '../geometry/toothShape';
import { union } from '../geometry/csg';
import { getTooth, setToothDimensions } from '../core/teeth';
import { buildRootStub, type ToothLibrary } from './toothLibrary';

/**
 * Single source of tooth shapes for every module. Uses the scanned library
 * when one is active, and the procedural teeth otherwise (or for a tooth the
 * library does not contain). Call `prepareTeeth` before the sync getters.
 */

let active: ToothLibrary | null = null;

export function setActiveLibrary(library: ToothLibrary | null): void {
  active = library;
  setToothDimensions(library ? library.dimensions() : null);
  solidCache.clear();
}

export function activeLibrary(): ToothLibrary | null {
  return active;
}

/** Load the library meshes for these teeth (no-op for procedural teeth). */
export async function prepareTeeth(fdis: number[]): Promise<void> {
  const lib = active;
  if (!lib) return;
  await Promise.all(fdis.filter((f) => lib.has(f)).map((f) => lib.tooth(f)));
}

function libraryTooth(fdi: number) {
  return active?.loadedTooth(fdi);
}

/** Outer crown surface of a tooth in its local frame. */
export function outerSurface(fdi: number, scale = 1): OuterSurface {
  const lib = libraryTooth(fdi);
  if (lib) return lib.surface.scaled(scale, scale, scale);
  return new ToothSurface(shapeFromTooth(getTooth(fdi), scale));
}

/**
 * Closed solid(s) of a full-contour tooth in its local frame, possibly as
 * overlapping shells (library crown + root stub). Fine for display and for
 * scans; use `solidTooth` when a single manifold solid is needed.
 */
export function solidParts(fdi: number, scale = 1, rootDepth = 0): MeshBuilder[] {
  const lib = libraryTooth(fdi);
  if (!lib) return [buildSolidTooth(shapeFromTooth(getTooth(fdi), scale), Math.max(0.3, rootDepth || 1))];
  const s = new THREE.Matrix4().makeScale(scale, scale, scale);
  const crown = MeshBuilder.fromGeometry(lib.geometry).transform(s);
  if (rootDepth <= lib.info.bottom * scale + 0.05) return [crown];
  return [crown, buildRootStub(lib.surface, rootDepth / scale).transform(s)];
}

/** `solidParts` merged into one solid. */
export function mergeParts(parts: MeshBuilder[]): MeshBuilder {
  const out = new MeshBuilder();
  for (const p of parts) out.append(p);
  return out;
}

const solidCache = new Map<string, Promise<MeshBuilder>>();

/** A single manifold solid per tooth (crown fused with its root stub), cached. */
export function solidTooth(fdi: number, scale = 1, rootDepth = 0): Promise<MeshBuilder> {
  const key = `${fdi}|${scale}|${rootDepth}|${active ? 'lib' : 'proc'}`;
  let p = solidCache.get(key);
  if (!p) {
    const parts = solidParts(fdi, scale, rootDepth);
    p = parts.length === 1 ? Promise.resolve(parts[0]) : union(parts);
    solidCache.set(key, p);
  }
  return p.then((m) => m.clone());
}
