import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

// BVH-accelerated ray casting: picking and sculpt brushes stay fast on scans
// with hundreds of thousands of triangles.
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

/** Geometries above this size get a BVH for picking. */
const BVH_MIN_TRIANGLES = 4000;

function ensureBvh(g: THREE.BufferGeometry): void {
  const tris = g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  if (!g.boundsTree && tris >= BVH_MIN_TRIANGLES) g.computeBoundsTree();
}

/**
 * A tool that takes over left-button drags in the viewport (e.g. a sculpt
 * brush). `down` returns true to capture the drag; orbiting is then paused.
 */
export interface PointerTool {
  down(hit: { point: THREE.Vector3; object: SceneObject; normal: THREE.Vector3 } | null, e: PointerEvent): boolean;
  move(hit: { point: THREE.Vector3; object: SceneObject; normal: THREE.Vector3 } | null, e: PointerEvent): void;
  up(e: PointerEvent): void;
  /** pointer moving without a captured drag (brush cursor) */
  hover?(hit: { point: THREE.Vector3; object: SceneObject; normal: THREE.Vector3 } | null): void;
}

export type ObjectCategory = 'scan' | 'design' | 'helper';

export interface SceneObject {
  id: string;
  name: string;
  category: ObjectCategory;
  /** module that owns the object (crown-bridge, denture, …) */
  module?: string;
  mesh: THREE.Mesh;
  /** design objects the user may move with the gizmo */
  editable: boolean;
  /** free-form metadata (tooth number, unit role, …) */
  data: Record<string, unknown>;
}

export const MATERIALS = {
  scan: () => new THREE.MeshStandardMaterial({ color: 0xd8cdb8, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }),
  tooth: () => new THREE.MeshStandardMaterial({ color: 0xf4f0e4, roughness: 0.35, metalness: 0, side: THREE.DoubleSide }),
  waxup: () => new THREE.MeshStandardMaterial({ color: 0xe8c66a, roughness: 0.45, metalness: 0, side: THREE.DoubleSide }),
  metal: () => new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.85, side: THREE.DoubleSide }),
  gingiva: () => new THREE.MeshStandardMaterial({ color: 0xd9707f, roughness: 0.55, metalness: 0, side: THREE.DoubleSide }),
  splint: () =>
    new THREE.MeshStandardMaterial({
      color: 0x9fd3ff,
      roughness: 0.15,
      metalness: 0,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  helper: () => new THREE.MeshBasicMaterial({ color: 0xff3b6b }),
};

/**
 * Three.js viewport: Z-up scene, orbit navigation, transform gizmo, picking,
 * selection highlighting and an optional section (clipping) plane.
 */
export class Viewport {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  private readonly objects = new Map<string, SceneObject>();
  private selectedId: string | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly section = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private nextId = 1;
  private listeners = new Set<() => void>();
  private selectListeners = new Set<(o: SceneObject | null) => void>();
  private transformListeners = new Set<(o: SceneObject) => void>();
  /** when set, clicks are delivered here instead of selecting */
  pickHandler: ((point: THREE.Vector3, object: SceneObject) => void) | null = null;
  /** restricts which objects the pick handler can hit (e.g. scans only) */
  pickFilter: ((object: SceneObject) => boolean) | null = null;
  /** 'any' lets every model (scans included) be selected, e.g. in the Transform tab */
  selectionMode: 'editable' | 'any' = 'editable';
  /** show the move / rotate / scale gizmo on the selection */
  gizmoEnabled = true;
  /** active drag tool (sculpt brush), if any */
  pointerTool: PointerTool | null = null;
  private transformStartListeners = new Set<(o: SceneObject) => void>();
  private transformEndListeners = new Set<(o: SceneObject) => void>();

  constructor(private readonly container: HTMLElement) {
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.scene.background = new THREE.Color(0x1d2330);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -120, 70);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 8);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener('mouseDown', () => {
      const o = this.selected;
      if (o) this.transformStartListeners.forEach((fn) => fn(o));
    });
    this.gizmo.addEventListener('mouseUp', () => {
      const o = this.selected;
      if (o) this.transformEndListeners.forEach((fn) => fn(o));
    });
    this.gizmo.addEventListener('objectChange', () => {
      const o = this.selected;
      if (o) this.transformListeners.forEach((fn) => fn(o));
    });
    this.scene.add(this.gizmo.getHelper());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(40, -80, 120);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.8);
    rim.position.set(-60, 80, -40);
    this.scene.add(rim);
    // camera-attached fill so undersides of upper teeth are lit
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    this.camera.add(fill);
    this.scene.add(this.camera);

    const grid = new THREE.GridHelper(120, 24, 0x3d4a60, 0x2a3344);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -14.5;
    this.scene.add(grid);

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    let toolActive = false;
    // capture phase on the container: runs before OrbitControls sees the event
    this.container.addEventListener(
      'pointerdown',
      (e) => {
        down = { x: e.clientX, y: e.clientY };
        if (this.pointerTool && e.button === 0 && !this.gizmo.dragging) {
          if (this.pointerTool.down(this.surfaceHit(e.clientX, e.clientY), e)) {
            toolActive = true;
            this.controls.enabled = false;
            el.setPointerCapture(e.pointerId);
          }
        }
      },
      { capture: true },
    );
    el.addEventListener('pointermove', (e) => {
      if (!this.pointerTool) return;
      const hit = this.surfaceHit(e.clientX, e.clientY);
      if (toolActive) this.pointerTool.move(hit, e);
      else this.pointerTool.hover?.(hit);
    });
    el.addEventListener('pointerup', (e) => {
      if (toolActive) {
        toolActive = false;
        this.controls.enabled = true;
        this.pointerTool?.up(e);
        down = null;
        return;
      }
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4 || this.gizmo.dragging) return;
      const hit = this.raycast(e.clientX, e.clientY);
      if (this.pickHandler) {
        if (hit) this.pickHandler(hit.point, hit.object);
        return;
      }
      this.select(hit && this.selectable(hit.object) ? hit.object.id : null);
    });
  }

  private selectable(o: SceneObject): boolean {
    return o.category !== 'helper' && (o.editable || this.selectionMode === 'any');
  }

  /** Ray cast that also returns the surface normal in world space. */
  surfaceHit(clientX: number, clientY: number): { point: THREE.Vector3; object: SceneObject; normal: THREE.Vector3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.objects.values()].filter((o) => o.mesh.visible && o.category !== 'helper').map((o) => o.mesh);
    for (const h of this.raycaster.intersectObjects(meshes, false)) {
      if (this.renderer.clippingPlanes.length && this.section.distanceToPoint(h.point) < 0) continue;
      const obj = [...this.objects.values()].find((o) => o.mesh === h.object);
      if (!obj || !h.face) continue;
      const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
      return { point: h.point.clone(), object: obj, normal };
    }
    return null;
  }

  onTransformStart(fn: (o: SceneObject) => void): void {
    this.transformStartListeners.add(fn);
  }

  onTransformEnd(fn: (o: SceneObject) => void): void {
    this.transformEndListeners.add(fn);
  }

  /** Rebuild the picking BVH after a geometry was edited in place (sculpting). */
  refreshBvh(o: SceneObject): void {
    const g = o.mesh.geometry;
    if (g.boundsTree) g.boundsTree.refit();
    else ensureBvh(g);
    g.computeBoundingSphere();
    g.computeBoundingBox();
  }

  /** Notify listeners that objects changed (names, visibility…). */
  changed(): void {
    this.emit();
  }

  raycast(clientX: number, clientY: number): { point: THREE.Vector3; object: SceneObject } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const filter = this.pickHandler && this.pickFilter ? this.pickFilter : () => true;
    const meshes = [...this.objects.values()].filter((o) => o.mesh.visible && o.category !== 'helper' && filter(o)).map((o) => o.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      if (this.renderer.clippingPlanes.length && this.section.distanceToPoint(h.point) < 0) continue;
      const obj = [...this.objects.values()].find((o) => o.mesh === h.object);
      if (obj) return { point: h.point.clone(), object: obj };
    }
    return null;
  }

  add(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    opts: { category: ObjectCategory; module?: string; editable?: boolean; matrix?: THREE.Matrix4; data?: Record<string, unknown> },
  ): SceneObject {
    ensureBvh(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    if (opts.matrix) opts.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    this.scene.add(mesh);
    const obj: SceneObject = {
      id: `obj${this.nextId++}`,
      name,
      category: opts.category,
      module: opts.module,
      mesh,
      editable: opts.editable ?? opts.category === 'design',
      data: opts.data ?? {},
    };
    this.objects.set(obj.id, obj);
    this.emit();
    return obj;
  }

  remove(id: string): void {
    const o = this.objects.get(id);
    if (!o) return;
    if (this.selectedId === id) this.select(null);
    this.scene.remove(o.mesh);
    o.mesh.geometry.disposeBoundsTree?.();
    o.mesh.geometry.dispose();
    (o.mesh.material as THREE.Material).dispose();
    this.objects.delete(id);
    this.emit();
  }

  removeWhere(pred: (o: SceneObject) => boolean): void {
    for (const o of [...this.objects.values()]) if (pred(o)) this.remove(o.id);
  }

  /** Replace an object's geometry in place (keeps transform and selection). */
  setGeometry(id: string, geometry: THREE.BufferGeometry): void {
    const o = this.objects.get(id);
    if (!o) return;
    o.mesh.geometry.disposeBoundsTree?.();
    o.mesh.geometry.dispose();
    ensureBvh(geometry);
    o.mesh.geometry = geometry;
  }

  list(): SceneObject[] {
    return [...this.objects.values()];
  }

  get(id: string): SceneObject | undefined {
    return this.objects.get(id);
  }

  get selected(): SceneObject | null {
    return this.selectedId ? this.objects.get(this.selectedId) ?? null : null;
  }

  select(id: string | null): void {
    const prev = this.selected;
    if (prev) (prev.mesh.material as THREE.MeshStandardMaterial).emissive?.setHex(0x000000);
    this.selectedId = id;
    const o = this.selected;
    if (o) (o.mesh.material as THREE.MeshStandardMaterial).emissive?.setHex(0x1b3a66);
    if (o && this.gizmoEnabled && this.selectable(o)) this.gizmo.attach(o.mesh);
    else this.gizmo.detach();
    this.selectListeners.forEach((fn) => fn(o));
    this.emit();
  }

  setVisible(id: string, visible: boolean): void {
    this.hiddenByView.delete(id);
    const o = this.objects.get(id);
    if (o) o.mesh.visible = visible;
    this.emit();
  }

  setOpacity(id: string, opacity: number): void {
    const o = this.objects.get(id);
    if (!o) return;
    const m = o.mesh.material as THREE.MeshStandardMaterial;
    m.opacity = opacity;
    m.transparent = opacity < 1;
    m.depthWrite = opacity >= 1;
    m.needsUpdate = true;
  }

  setSection(enabled: boolean, axis: 'x' | 'y' = 'y', offset = 0): void {
    if (!enabled) {
      this.renderer.clippingPlanes = [];
      return;
    }
    this.section.normal.set(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0, 0);
    this.section.constant = offset;
    this.renderer.clippingPlanes = [this.section];
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  onSelect(fn: (o: SceneObject | null) => void): void {
    this.selectListeners.add(fn);
  }

  onTransform(fn: (o: SceneObject) => void): void {
    this.transformListeners.add(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  private hiddenByView = new Set<string>();

  /** Which jaw an object belongs to, if any. */
  static jawOf(o: SceneObject): 'upper' | 'lower' | undefined {
    if (o.data.jaw === 'upper' || o.data.jaw === 'lower') return o.data.jaw;
    if (o.data.arch === 'upper' || o.data.arch === 'lower') return o.data.arch;
    const fdi = o.data.fdi as number | undefined;
    if (fdi) return Math.floor(fdi / 10) <= 2 ? 'upper' : 'lower';
    return undefined;
  }

  /**
   * Frame all visible objects from a preset direction. Occlusal views hide
   * the antagonist (opposing jaw); other views bring it back.
   */
  view(preset: 'front' | 'occlusal-upper' | 'occlusal-lower' | 'left' | 'right' | 'fit'): void {
    for (const id of this.hiddenByView) {
      const o = this.objects.get(id);
      if (o) o.mesh.visible = true;
    }
    this.hiddenByView.clear();
    if (preset === 'occlusal-upper' || preset === 'occlusal-lower') {
      const antagonist = preset === 'occlusal-upper' ? 'lower' : 'upper';
      for (const o of this.objects.values()) {
        if (o.mesh.visible && Viewport.jawOf(o) === antagonist) {
          o.mesh.visible = false;
          this.hiddenByView.add(o.id);
        }
      }
      this.emit();
    }
    const box = new THREE.Box3();
    for (const o of this.objects.values()) if (o.mesh.visible && o.category !== 'helper') box.expandByObject(o.mesh);
    if (box.isEmpty()) box.set(new THREE.Vector3(-30, -30, -5), new THREE.Vector3(30, 30, 20));
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const dirs: Record<string, THREE.Vector3> = {
      front: new THREE.Vector3(0, -1, 0.15),
      'occlusal-lower': new THREE.Vector3(0, -0.05, 1),
      'occlusal-upper': new THREE.Vector3(0, -0.05, -1),
      left: new THREE.Vector3(1, 0, 0.1),
      right: new THREE.Vector3(-1, 0, 0.1),
    };
    const dir = (dirs[preset] ?? this.camera.position.clone().sub(this.controls.target)).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.up.set(0, 0, 1);
    if (preset === 'occlusal-lower') this.camera.up.set(0, 1, 0);
    if (preset === 'occlusal-upper') this.camera.up.set(0, -1, 0);
    this.camera.lookAt(center);
  }
}
