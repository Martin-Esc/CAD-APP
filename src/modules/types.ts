import type * as THREE from 'three';
import type { Viewport, SceneObject } from '../viewer/Viewport';
import type { CaseState } from '../core/case';
import type { ArchDefinition } from '../core/arch';
import type { Jaw } from '../core/teeth';
import type { ToothLibrary } from '../library/toothLibrary';

export interface AppContext {
  viewport: Viewport;
  state: CaseState;
  /** fitted arch for the jaw, or the default arch form */
  arch(jaw: Jaw): ArchDefinition;
  /** the scan object loaded for a jaw, if any */
  scanFor(jaw: Jaw): SceneObject | undefined;
  status(message: string, kind?: 'info' | 'warn' | 'error'): void;
  /** export the given objects as one STL */
  exportObjects(objects: SceneObject[], name: string): void;
  /** the scanned tooth library, if it could be loaded */
  library(): ToothLibrary | null;
  /** switch between the scanned library and procedural teeth */
  setToothLibrary(mode: 'scanned' | 'procedural'): void;
  /** export world-space geometries (e.g. boolean results) as one STL */
  exportGeometries(geometries: THREE.BufferGeometry[], name: string): void;
}

export interface DesignModule {
  id: string;
  title: string;
  /** build the parameter panel */
  render(ctx: AppContext): HTMLElement;
  /** called while the user drags one of this module's objects */
  onTransform?(ctx: AppContext, object: SceneObject): void;
}
