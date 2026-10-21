import * as THREE from 'three';
import type { AppContext, DesignModule } from './types';
import type { PointerTool, SceneObject } from '../viewer/Viewport';
import { BRUSH_LABELS, Sculptor, type BrushKind, type RemeshSettings } from '../geometry/sculpt';
import { applySnapshot, snapshotOf } from '../geometry/dynamesh';

type Snapshot = ReturnType<typeof snapshotOf>;
import { fillHoles, fixNormals, inspect, planeCut, removeSmallShells, weldAndClean, type Inspection } from '../geometry/repair';
import { button, checkboxField, el, note, numberField, section, selectField } from '../ui/dom';

const MODULE = 'sculpt';

const settings = {
  brush: 'draw' as BrushKind,
  radius: 1.5,
  strength: 0.5,
  maxHole: 30,
  minShell: 5,
  cutZ: 0,
  cutKeep: 'above' as 'above' | 'below',
  cutFill: true,
  remesh: true,
  detail: 0.15,
  refine: true,
  reduce: true,
  wireframe: false,
};

/** Remesh settings for a dab, or null when dynamic remeshing is off (Refine always remeshes). */
function remeshSettings(kind?: BrushKind): RemeshSettings | null {
  if (!settings.remesh && kind !== 'refine') return null;
  return { detail: settings.detail, refine: settings.refine, reduce: settings.reduce };
}

let sculptor: { geometry: THREE.BufferGeometry; s: Sculptor } | null = null;
let refreshPanel: (() => void) | null = null;
let listening = false;

function target(ctx: AppContext): SceneObject | null {
  const o = ctx.viewport.selected;
  return o && o.category !== 'helper' ? o : null;
}

function sculptorFor(ctx: AppContext, o: SceneObject): Sculptor | null {
  if (sculptor && sculptor.geometry === o.mesh.geometry) return sculptor.s;
  try {
    sculptor = { geometry: o.mesh.geometry, s: new Sculptor(o.mesh.geometry) };
    return sculptor.s;
  } catch (e) {
    ctx.status((e as Error).message, 'warn');
    return null;
  }
}

/** Brush radius in the object's local units (objects may be scaled). */
function localRadius(o: SceneObject): number {
  o.mesh.updateMatrixWorld(true);
  const s = new THREE.Vector3().setFromMatrixScale(o.mesh.matrixWorld);
  return settings.radius / ((Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1);
}

function toLocal(o: SceneObject, p: THREE.Vector3): THREE.Vector3 {
  return p.clone().applyMatrix4(o.mesh.matrixWorld.clone().invert());
}

// ---------------------------------------------------------------------------
// brush cursor

function showCursor(ctx: AppContext, hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null): void {
  let cursor = ctx.viewport.list().find((o) => o.category === 'helper' && o.data.brushCursor === true);
  if (!hit) {
    if (cursor) cursor.mesh.visible = false;
    return;
  }
  if (!cursor) {
    const ring = new THREE.RingGeometry(0.92, 1, 48);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    cursor = ctx.viewport.add('Brush', ring, mat, { category: 'helper', editable: false, data: { brushCursor: true } });
    cursor.mesh.renderOrder = 20;
  }
  cursor.mesh.visible = true;
  cursor.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.02);
  cursor.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
  cursor.mesh.scale.setScalar(settings.radius);
}

// ---------------------------------------------------------------------------
// brush strokes

function brushTool(ctx: AppContext): PointerTool {
  let stroke: {
    o: SceneObject;
    s: Sculptor;
    before: Snapshot;
    last: THREE.Vector3;
    kind: BrushKind;
    grabPlane?: THREE.Plane;
    grabStart?: THREE.Vector3;
  } | null = null;
  const ray = new THREE.Raycaster();

  const pointerRay = (e: PointerEvent) => {
    const rect = ctx.viewport.renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
      ctx.viewport.camera,
    );
    return ray.ray;
  };

  /** Ray hit on the stroke's mesh near the last dab (local mesh picking; the scene BVH is stale mid-stroke). */
  const strokeHit = (e: PointerEvent): { point: THREE.Vector3; normal: THREE.Vector3 } | null => {
    if (!stroke) return null;
    const { o, s } = stroke;
    const inv = o.mesh.matrixWorld.clone().invert();
    const local = pointerRay(e).clone().applyMatrix4(inv);
    const near = toLocal(o, stroke.last);
    const r = localRadius(o) * 4;
    const hit = s.mesh.raycastNear(local, near, r);
    if (!hit) return null;
    return {
      point: hit.point.applyMatrix4(o.mesh.matrixWorld),
      normal: hit.normal.transformDirection(o.mesh.matrixWorld),
    };
  };

  return {
    wantsHitWhileDragging: () => false,
    down(hit, e) {
      const o = target(ctx);
      if (!hit || !o || hit.object.id !== o.id) return false;
      const before = snapshotOf(o.mesh.geometry);
      const s = sculptorFor(ctx, o);
      if (!s) return false;
      const kind: BrushKind = e.shiftKey ? 'smooth' : settings.brush;
      stroke = { o, s, before, last: hit.point.clone(), kind };
      // the picking BVH would be stale while the topology changes: drop it until the stroke ends
      o.mesh.geometry.disposeBoundsTree?.();
      s.begin();
      const brush = { radius: localRadius(o), strength: settings.strength };
      if (kind === 'grab') {
        const n = ctx.viewport.camera.getWorldDirection(new THREE.Vector3()).negate();
        stroke.grabPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point);
        stroke.grabStart = hit.point.clone();
        s.beginGrab(toLocal(o, hit.point), brush, remeshSettings());
      } else {
        s.dab(kind, toLocal(o, hit.point), brush, remeshSettings(kind));
      }
      s.flush();
      return true;
    },
    move(_hit, e) {
      if (!stroke) return;
      const { o, s, kind } = stroke;
      if (kind === 'grab') {
        const p = pointerRay(e).intersectPlane(stroke.grabPlane!, new THREE.Vector3());
        if (!p) return;
        const delta = toLocal(o, p).sub(toLocal(o, stroke.grabStart!));
        s.grabTo(delta, settings.strength);
        s.flush();
        showCursor(ctx, { point: p, normal: stroke.grabPlane!.normal });
        return;
      }
      const hit = strokeHit(e);
      showCursor(ctx, hit);
      if (!hit) return;
      // dabs spaced at a quarter of the brush radius along the stroke
      const spacing = settings.radius * 0.25;
      const dist = hit.point.distanceTo(stroke.last);
      if (dist < spacing) return;
      const steps = Math.min(8, Math.floor(dist / spacing));
      const brush = { radius: localRadius(o), strength: settings.strength };
      const remesh = remeshSettings(kind);
      if (remesh && kind !== 'refine') s.remeshSegment(toLocal(o, stroke.last), toLocal(o, hit.point), brush, remesh);
      for (let i = 1; i <= steps; i++) {
        const p = stroke.last.clone().lerp(hit.point, i / steps);
        s.dab(kind as Exclude<BrushKind, 'grab'>, toLocal(o, p), brush, kind === 'refine' ? remesh : null);
      }
      s.flush();
      stroke.last.copy(hit.point);
    },
    up() {
      if (!stroke) return;
      const { o, s, before, kind } = stroke;
      if (kind === 'grab') s.endGrab(remeshSettings());
      stroke = null;
      const after = s.end();
      ctx.viewport.refreshBvh(o, true);
      ctx.viewport.select(o.id); // refresh triangle count / watertight info
      const geometry = o.mesh.geometry;
      const restore = (snap: Snapshot) => {
        if (o.mesh.geometry !== geometry) return;
        applySnapshot(geometry, snap);
        sculptor = null; // the dynamic mesh no longer matches
        ctx.viewport.refreshBvh(o, true);
        ctx.viewport.select(o.id);
      };
      const bytes = (x: Snapshot) => x.position.byteLength + x.normal.byteLength + x.index.byteLength;
      ctx.history.push({
        label: `${BRUSH_LABELS[kind]} stroke`,
        bytes: bytes(before) + bytes(after),
        undo: () => restore(before),
        redo: () => restore(after),
      });
      refreshPanel?.();
    },
    hover(hit) {
      const o = target(ctx);
      showCursor(ctx, hit && o && hit.object.id === o.id ? hit : null);
    },
  };
}

// ---------------------------------------------------------------------------
// repairs (replace the geometry, undoable)

function replaceGeometry(ctx: AppContext, o: SceneObject, next: THREE.BufferGeometry, label: string): void {
  const before = o.mesh.geometry.clone();
  const after = next;
  const apply = (g: THREE.BufferGeometry) => {
    if (!ctx.viewport.get(o.id)) return;
    ctx.viewport.setGeometry(o.id, g.clone());
    sculptor = null;
    ctx.viewport.select(o.id); // refresh the selection info (triangles, volume, watertight)
  };
  apply(after);
  ctx.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
}

function showHoles(ctx: AppContext, o: SceneObject, report: Inspection): void {
  clearMarkers(ctx);
  o.mesh.updateMatrixWorld(true);
  report.holes.forEach((loop, i) => {
    const pts = loop.map((p) => p.clone().applyMatrix4(o.mesh.matrixWorld));
    if (pts.length < 3) return;
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), Math.min(400, pts.length * 2), 0.12, 5, true);
    const m = ctx.viewport.add(`Hole ${i + 1}`, tube, new THREE.MeshBasicMaterial({ color: 0xff4d6d, depthTest: false }), {
      category: 'helper',
      editable: false,
      data: { holeMarker: true },
    });
    m.mesh.renderOrder = 15;
  });
}

function clearMarkers(ctx: AppContext): void {
  ctx.viewport.removeWhere((h) => h.category === 'helper' && (h.data.holeMarker === true || h.data.cutPreview === true));
}

function showCutPlane(ctx: AppContext, o: SceneObject): void {
  ctx.viewport.removeWhere((h) => h.category === 'helper' && h.data.cutPreview === true);
  const box = new THREE.Box3().setFromObject(o.mesh);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const plane = new THREE.PlaneGeometry(size.x * 1.2 + 4, size.y * 1.2 + 4).translate(c.x, c.y, settings.cutZ);
  ctx.viewport.add('Cut plane', plane, new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }), {
    category: 'helper',
    editable: false,
    data: { cutPreview: true },
  });
}

export const sculptModule: DesignModule = {
  id: MODULE,
  title: 'Sculpt',
  activate(ctx) {
    const vp = ctx.viewport;
    vp.selectionMode = 'any';
    vp.gizmoEnabled = false;
    const sel = vp.selected;
    vp.select(sel ? sel.id : null);
    vp.pointerTool = brushTool(ctx);
    if (!listening) {
      listening = true;
      vp.onSelect(() => refreshPanel?.());
    }
  },
  deactivate(ctx) {
    const vp = ctx.viewport;
    vp.pointerTool = null;
    vp.gizmoEnabled = true;
    vp.selectionMode = 'editable';
    vp.removeWhere((h) => h.category === 'helper' && h.data.brushCursor === true);
    clearMarkers(ctx);
    const sel = vp.selected;
    vp.select(sel && sel.editable ? sel.id : null);
    refreshPanel = null;
  },
  render(ctx) {
    const root = el('div', {});
    const report = el('div', {});
    const render = () => {
      const o = target(ctx);
      const brushButtons = (Object.keys(BRUSH_LABELS) as BrushKind[]).map((k) =>
        button(BRUSH_LABELS[k], () => {
          settings.brush = k;
          render();
        }, settings.brush === k ? 'primary' : ''),
      );
      const need = (fn: (o: SceneObject) => void) => () => {
        const t = target(ctx);
        if (!t) {
          ctx.status('Click the model you want to edit first.', 'warn');
          return;
        }
        fn(t);
      };
      root.replaceChildren(
        note(o ? `Editing: ${o.name}. Drag on it to sculpt; drag elsewhere to orbit. Hold Shift to smooth.` : 'Click a model (scan, crown, tooth…) to start sculpting or repairing it.'),
        section(
          'Brushes',
          el('div', { class: 'actions' }, ...brushButtons),
          numberField('Size (radius)', settings, 'radius', { min: 0.2, max: 15, step: 0.1, unit: 'mm' }),
          numberField('Strength', settings, 'strength', { min: 0.02, max: 1, step: 0.02 }),
          note('Draw adds material, Remove takes it away, Inflate pushes along the surface normals, Flatten levels toward a plane, Grab drags a region, Refine only re-triangulates (no shape change).'),
        ),
        section(
          'Dynamic remesh',
          checkboxField('Remesh while sculpting', settings, 'remesh'),
          numberField('Detail (edge length)', settings, 'detail', { min: 0.03, max: 2, step: 0.01, unit: 'mm' }),
          checkboxField('Refine (add triangles)', settings, 'refine'),
          checkboxField('Reduce (merge small triangles)', settings, 'reduce'),
          checkboxField('Show triangles (wireframe)', settings, 'wireframe', () => {
            const t = target(ctx);
            if (t) (t.mesh.material as THREE.MeshStandardMaterial).wireframe = settings.wireframe;
          }),
          note('The surface under the brush is re-triangulated to the detail size as you sculpt, so large Draw / Grab edits stay smooth instead of stretching. Smaller detail = finer surface but more triangles (the detail is limited to brush size / 25).'),
          o && sculptor?.geometry === o.mesh.geometry ? note(`${sculptor.s.triangleCount.toLocaleString()} triangles`) : null,
        ),
        section(
          'Inspector & repair',
          el(
            'div',
            { class: 'actions' },
            button('Inspect', need((t) => {
              const r = inspect(t.mesh.geometry);
              showHoles(ctx, t, r);
              report.replaceChildren(
                note(
                  `${r.triangles.toLocaleString()} triangles · ${r.shells} piece(s) · ${r.holes.length} hole(s)` +
                    `${r.holes.length ? ` (largest ${Math.max(...r.holePerimeters).toFixed(1)} mm around)` : ''}` +
                    ` · ${r.nonManifoldEdges} non-manifold edge(s) · ${r.degenerate} degenerate triangle(s)`,
                  r.watertight && r.shells === 1 ? 'info' : 'warn',
                ),
              );
            }), 'primary'),
            button('Clear markers', () => {
              clearMarkers(ctx);
              report.replaceChildren();
            }),
          ),
          report,
          numberField('Fill holes up to', settings, 'maxHole', { min: 1, max: 1000, step: 1, unit: 'mm' }),
          el(
            'div',
            { class: 'actions' },
            button('Fill holes', need((t) => {
              const { geometry, filled } = fillHoles(t.mesh.geometry, settings.maxHole);
              if (!filled) return ctx.status('No holes within the size limit.');
              replaceGeometry(ctx, t, geometry, 'Fill holes');
              clearMarkers(ctx);
              ctx.status(`Filled ${filled} hole(s).`);
            })),
            button('Weld & clean', need((t) => {
              const { geometry, removed } = weldAndClean(t.mesh.geometry);
              replaceGeometry(ctx, t, geometry, 'Weld & clean');
              ctx.status(`Welded duplicate vertices; removed ${removed} degenerate/duplicate triangle(s).`);
            })),
            button('Fix normals', need((t) => {
              const { geometry, flipped } = fixNormals(t.mesh.geometry);
              replaceGeometry(ctx, t, geometry, 'Fix normals');
              ctx.status(`Flipped ${flipped} triangle(s).`);
            })),
          ),
          numberField('Remove pieces smaller than', settings, 'minShell', { min: 0.1, max: 90, step: 0.5, unit: '%' }),
          el(
            'div',
            { class: 'actions' },
            button('Remove small pieces', need((t) => {
              const { geometry, removed } = removeSmallShells(t.mesh.geometry, settings.minShell / 100);
              if (!removed) return ctx.status('No small loose pieces found.');
              replaceGeometry(ctx, t, geometry, 'Remove small pieces');
              ctx.status(`Removed ${removed} loose piece(s).`);
            })),
          ),
        ),
        section(
          'Plane cut',
          numberField('Cut height (Z)', settings, 'cutZ', { min: -100, max: 100, step: 0.5, unit: 'mm', onChange: () => {
            const t = target(ctx);
            if (t) showCutPlane(ctx, t);
          } }),
          selectField('Keep', settings, 'cutKeep', [['above', 'Above the plane'], ['below', 'Below the plane']]),
          checkboxField('Close the cut flat', settings, 'cutFill'),
          el(
            'div',
            { class: 'actions' },
            button('Preview plane', need((t) => showCutPlane(ctx, t))),
            button('Cut', need((t) => {
              t.mesh.updateMatrixWorld(true);
              const n = new THREE.Vector3(0, 0, settings.cutKeep === 'above' ? 1 : -1);
              const world = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(0, 0, settings.cutZ));
              const local = world.clone().applyMatrix4(t.mesh.matrixWorld.clone().invert());
              const geometry = planeCut(t.mesh.geometry, local, settings.cutFill);
              if (!geometry.index || geometry.index.count === 0) return ctx.status('Nothing would be left on that side of the plane.', 'warn');
              replaceGeometry(ctx, t, geometry, 'Plane cut');
              clearMarkers(ctx);
              ctx.status('Plane cut applied.');
            })),
          ),
        ),
        el(
          'div',
          { class: 'actions' },
          button('Undo (Ctrl+Z)', () => {
            const l = ctx.history.undo();
            ctx.status(l ? `Undid: ${l}` : 'Nothing to undo.');
          }),
          button('Redo (Ctrl+Y)', () => {
            const l = ctx.history.redo();
            ctx.status(l ? `Redid: ${l}` : 'Nothing to redo.');
          }),
        ),
      );
    };
    // refresh on the next frame: a re-render while an input is firing its
    // change/blur events would remove that input mid-event
    let pending = false;
    refreshPanel = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        render();
      });
    };
    render();
    return root;
  },
};
