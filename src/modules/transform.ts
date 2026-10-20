import * as THREE from 'three';
import type { AppContext, DesignModule } from './types';
import type { SceneObject } from '../viewer/Viewport';
import { MATERIALS } from '../viewer/Viewport';
import { button, el, note, section } from '../ui/dom';

const MODULE = 'transform';

/** Apply a world matrix to an object's mesh. */
export function setMatrix(o: SceneObject, m: THREE.Matrix4): void {
  m.decompose(o.mesh.position, o.mesh.quaternion, o.mesh.scale);
  o.mesh.updateMatrixWorld(true);
}

/**
 * Record a finished move / rotate / scale for undo. When a scan moves, the
 * margin lines drawn on it move with it.
 */
export function recordTransform(ctx: AppContext, o: SceneObject, before: THREE.Matrix4, after: THREE.Matrix4, label: string): void {
  if (before.equals(after)) return;
  const followMargins = (from: THREE.Matrix4, to: THREE.Matrix4) => {
    if (o.category !== 'scan') return;
    const jaw = o.data.jaw as string;
    const delta = to.clone().multiply(from.clone().invert());
    for (const [fdi, pts] of Object.entries(ctx.state.margins)) {
      const isUpper = Math.floor(Number(fdi) / 10) <= 2;
      if ((jaw === 'upper') !== isUpper) continue;
      ctx.state.margins[Number(fdi)] = pts.map((p) => new THREE.Vector3(...p).applyMatrix4(delta).toArray() as [number, number, number]);
    }
  };
  followMargins(before, after);
  ctx.history.push({
    label,
    undo: () => {
      setMatrix(o, before);
      followMargins(after, before);
      ctx.objectMoved(o);
    },
    redo: () => {
      setMatrix(o, after);
      followMargins(before, after);
      ctx.objectMoved(o);
    },
  });
}

function objects(ctx: AppContext): SceneObject[] {
  return ctx.viewport.list().filter((o) => o.category !== 'helper');
}

/** Change an object's transform through a function and record it. */
function change(ctx: AppContext, o: SceneObject, label: string, fn: (m: THREE.Matrix4) => THREE.Matrix4): void {
  o.mesh.updateMatrix();
  const before = o.mesh.matrix.clone();
  const after = fn(before.clone());
  setMatrix(o, after);
  recordTransform(ctx, o, before, after, label);
  ctx.objectMoved(o);
}

function worldBox(o: SceneObject): THREE.Box3 {
  o.mesh.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o.mesh);
}

const nudge = { move: 0.5, rotate: 5 };
let refreshPanel: (() => void) | null = null;
let listening = false;

export const transformModule: DesignModule = {
  id: MODULE,
  title: 'Transform',
  activate(ctx) {
    ctx.viewport.selectionMode = 'any';
    ctx.viewport.gizmoEnabled = true;
    const sel = ctx.viewport.selected;
    ctx.viewport.select(sel ? sel.id : null);
    if (!listening) {
      listening = true;
      ctx.viewport.onSelect(() => refreshPanel?.());
      ctx.viewport.onTransform(() => refreshPanel?.());
      ctx.history.onChange(() => refreshPanel?.());
    }
  },
  deactivate(ctx) {
    ctx.viewport.selectionMode = 'editable';
    ctx.viewport.pickHandler = null;
    ctx.viewport.pickFilter = null;
    ctx.viewport.removeWhere((o) => o.category === 'helper' && o.data.orientPick === true);
    const sel = ctx.viewport.selected;
    ctx.viewport.select(sel && sel.editable ? sel.id : null);
    refreshPanel = null;
  },
  render(ctx) {
    const vp = ctx.viewport;
    const root = el('div', {});
    const body = el('div', {});
    const orient = { jaw: 'lower' as 'upper' | 'lower', picks: [] as THREE.Vector3[] };

    const numberInput = (value: number, step: number, onChange: (v: number) => void) => {
      const input = el('input', { type: 'number', step, value: Number(value.toFixed(3)) });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) onChange(v);
      });
      return input;
    };

    const render = () => {
      const o = vp.selected;
      const list = objects(ctx);
      const select = el('select', {}, el('option', { value: '' }, '— click a model or choose —'));
      for (const obj of list) select.append(el('option', { value: obj.id, selected: obj.id === o?.id }, obj.name));
      select.addEventListener('change', () => vp.select(select.value || null));

      if (!o) {
        body.replaceChildren(
          el('label', { class: 'field' }, el('span', {}, 'Object'), select),
          note('Click any model in the viewport (scans included) or pick it from the list to move, rotate or scale it.'),
        );
        return;
      }
      o.mesh.updateMatrix();
      const euler = new THREE.Euler().setFromQuaternion(o.mesh.quaternion, 'XYZ');
      const deg = THREE.MathUtils.radToDeg;
      const rad = THREE.MathUtils.degToRad;
      const axisRow = (label: string, values: number[], step: number, unit: string, apply: (axis: number, v: number) => void) =>
        el(
          'div',
          { class: 'xyz' },
          el('span', {}, label),
          ...values.map((v, i) => el('label', {}, el('small', {}, 'XYZ'[i]), numberInput(v, step, (nv) => apply(i, nv)))),
          el('small', {}, unit),
        );

      const setPos = (axis: number, v: number) =>
        change(ctx, o, 'Move', (m) => {
          const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          m.decompose(p, q, s);
          p.setComponent(axis, v);
          return m.compose(p, q, s);
        });
      const setRot = (axis: number, v: number) =>
        change(ctx, o, 'Rotate', (m) => {
          const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          m.decompose(p, q, s);
          const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
          e[(['x', 'y', 'z'] as const)[axis]] = rad(v);
          return m.compose(p, q.setFromEuler(e), s);
        });
      const setScale = (v: number) =>
        change(ctx, o, 'Scale', (m) => {
          const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          m.decompose(p, q, s);
          return m.compose(p, q, new THREE.Vector3(v, v, v));
        });

      const move = (axis: number, sign: number) =>
        change(ctx, o, 'Move', (m) => {
          const d = new THREE.Vector3();
          d.setComponent(axis, sign * nudge.move);
          return new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(m);
        });
      const rotate = (axis: number, sign: number) =>
        change(ctx, o, 'Rotate', (m) => {
          // rotate about the object's bounding-box centre, in world axes
          const c = worldBox(o).getCenter(new THREE.Vector3());
          const r = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3().setComponent(axis, 1), rad(sign * nudge.rotate));
          return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)).multiply(m);
        });

      const stepSelect = (key: 'move' | 'rotate', values: number[], unit: string) => {
        const s = el('select', {});
        for (const v of values) s.append(el('option', { value: v, selected: v === nudge[key] }, `${v} ${unit}`));
        s.addEventListener('change', () => (nudge[key] = Number(s.value)));
        return s;
      };
      const nudgeRow = (label: string, fn: (axis: number, sign: number) => void, step: HTMLElement) =>
        el(
          'div',
          { class: 'nudge' },
          el('span', {}, label),
          ...[0, 1, 2].flatMap((axis) => [
            button(`−${'XYZ'[axis]}`, () => fn(axis, -1), 'small'),
            button(`+${'XYZ'[axis]}`, () => fn(axis, 1), 'small'),
          ]),
          step,
        );

      const mode = (m: 'translate' | 'rotate' | 'scale', label: string, key: string) =>
        button(`${label} (${key})`, () => {
          vp.gizmo.setMode(m);
          render();
        }, vp.gizmo.mode === m ? 'primary' : '');

      body.replaceChildren(
        el('label', { class: 'field' }, el('span', {}, 'Object'), select),
        o.category === 'scan' ? note('Moving a scan also moves the margin lines drawn on it. Refit the arch (Case tab) after rotating a scan.') : '',
        section(
          'Gizmo',
          el(
            'div',
            { class: 'actions' },
            mode('translate', 'Move', 'W'),
            mode('rotate', 'Rotate', 'E'),
            mode('scale', 'Scale', 'R'),
            button(vp.gizmo.space === 'world' ? 'World axes' : 'Local axes', () => {
              vp.gizmo.setSpace(vp.gizmo.space === 'world' ? 'local' : 'world');
              render();
            }),
          ),
        ),
        section(
          'Exact values',
          axisRow('Position', o.mesh.position.toArray(), 0.1, 'mm', setPos),
          axisRow('Rotation', [deg(euler.x), deg(euler.y), deg(euler.z)], 1, '°', setRot),
          el('div', { class: 'xyz' }, el('span', {}, 'Scale'), el('label', {}, numberInput(o.mesh.scale.x, 0.01, setScale)), el('small', {}, '×')),
        ),
        section(
          'Nudge',
          nudgeRow('Move', move, stepSelect('move', [0.05, 0.1, 0.5, 1, 5], 'mm')),
          nudgeRow('Rotate', rotate, stepSelect('rotate', [0.5, 1, 5, 15, 90], '°')),
        ),
        section(
          'Quick actions',
          el(
            'div',
            { class: 'actions' },
            button('Center on grid', () =>
              change(ctx, o, 'Center', (m) => {
                const c = worldBox(o).getCenter(new THREE.Vector3());
                return new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0).multiply(m);
              }),
            ),
            button('Reset', () => change(ctx, o, 'Reset transform', () => new THREE.Matrix4())),
            button('Apply to mesh', () => bake(ctx, o)),
          ),
          note('"Apply to mesh" writes the current position into the mesh itself and resets the transform to zero.'),
        ),
        section(
          'Orient occlusal plane',
          el(
            'label',
            { class: 'field' },
            el('span', {}, 'This model is'),
            (() => {
              const s = el('select', {}, el('option', { value: 'lower', selected: orient.jaw === 'lower' }, 'Lower jaw (teeth up)'), el('option', { value: 'upper', selected: orient.jaw === 'upper' }, 'Upper jaw (teeth down)'));
              s.addEventListener('change', () => (orient.jaw = s.value as 'upper' | 'lower'));
              return s;
            })(),
          ),
          el(
            'div',
            { class: 'actions' },
            button('Pick 3 points', () => startOrient(ctx, o, orient, render)),
          ),
          note('Click three cusp tips spread over the arch (e.g. both first molars and an incisor). The model is rotated so that plane becomes horizontal, ready for the arch, nightguard and margin tools.'),
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
    root.append(body);
    return root;
  },
};

/** Write the object's transform into its geometry and reset the transform. */
function bake(ctx: AppContext, o: SceneObject): void {
  o.mesh.updateMatrix();
  const m = o.mesh.matrix.clone();
  if (m.equals(new THREE.Matrix4())) {
    ctx.status('The transform is already zero.');
    return;
  }
  const before = o.mesh.geometry.clone();
  const after = before.clone().applyMatrix4(m);
  if (m.determinant() < 0 && after.index) {
    const idx = after.index;
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
  }
  after.computeVertexNormals();
  const apply = (g: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    ctx.viewport.setGeometry(o.id, g.clone());
    setMatrix(o, matrix);
    ctx.objectMoved(o);
  };
  apply(after, new THREE.Matrix4());
  ctx.history.push({ label: 'Apply transform', undo: () => apply(before, m), redo: () => apply(after, new THREE.Matrix4()) });
  ctx.status(`Transform applied to ${o.name}.`);
}

function startOrient(ctx: AppContext, o: SceneObject, orient: { jaw: 'upper' | 'lower'; picks: THREE.Vector3[] }, rerender: () => void): void {
  const vp = ctx.viewport;
  orient.picks = [];
  vp.removeWhere((h) => h.category === 'helper' && h.data.orientPick === true);
  ctx.status('Click 3 cusp tips on the model (spread over the arch).');
  vp.pickFilter = (h) => h.id === o.id;
  vp.pickHandler = (point) => {
    orient.picks.push(point.clone());
    vp.add('Orient point', new THREE.SphereGeometry(0.5, 12, 8).translate(point.x, point.y, point.z), MATERIALS.helper(), {
      category: 'helper',
      editable: false,
      data: { orientPick: true },
    });
    if (orient.picks.length < 3) {
      ctx.status(`${orient.picks.length} of 3 points.`);
      return;
    }
    vp.pickHandler = null;
    vp.pickFilter = null;
    vp.removeWhere((h) => h.category === 'helper' && h.data.orientPick === true);
    const [a, b, c] = orient.picks;
    const centroid = a.clone().add(b).add(c).divideScalar(3);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    // the cusps were clicked from the side they face: the plane normal points toward the camera
    if (n.dot(vp.camera.position.clone().sub(centroid)) < 0) n.negate();
    const target = new THREE.Vector3(0, 0, orient.jaw === 'lower' ? 1 : -1);
    const rot = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(n, target));
    // occlusal plane level of the default arches (cusp tips ≈ 8.5 mm above the lower margins)
    const level = 8.5;
    change(ctx, o, 'Orient occlusal plane', (m) =>
      new THREE.Matrix4()
        .makeTranslation(centroid.x, centroid.y, level)
        .multiply(rot)
        .multiply(new THREE.Matrix4().makeTranslation(-centroid.x, -centroid.y, -centroid.z))
        .multiply(m),
    );
    vp.view(orient.jaw === 'lower' ? 'occlusal-lower' : 'occlusal-upper');
    ctx.status('Occlusal plane is now horizontal.');
    rerender();
  };
}
