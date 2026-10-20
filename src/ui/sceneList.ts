import { el } from './dom';
import type { Viewport } from '../viewer/Viewport';

/** Object browser: visibility, opacity, selection and deletion. */
export function sceneList(viewport: Viewport): HTMLElement {
  const root = el('div', { class: 'scene-list' });
  const render = () => {
    const objects = viewport.list().filter((o) => o.category !== 'helper' || o.data.arch);
    const groups: Record<string, typeof objects> = {};
    for (const o of objects) (groups[o.category === 'design' ? o.module ?? 'design' : o.category] ??= []).push(o);
    root.replaceChildren(
      el('h3', {}, 'Objects'),
      ...(objects.length ? [] : [el('div', { class: 'empty' }, 'Import scans or load the demo models to begin.')]),
      ...Object.entries(groups).map(([group, objs]) =>
        el(
          'details',
          { open: true },
          el('summary', {}, `${group} (${objs.length})`),
          ...objs.map((o) => {
            const vis = el('input', { type: 'checkbox', checked: o.mesh.visible, title: 'Visible' });
            vis.addEventListener('change', () => viewport.setVisible(o.id, vis.checked));
            const material = o.mesh.material as { opacity: number };
            const opacity = el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: material.opacity, title: 'Opacity' });
            opacity.addEventListener('input', () => viewport.setOpacity(o.id, Number(opacity.value)));
            const name = el('span', { class: 'name', title: o.name }, o.name);
            name.addEventListener('click', () => {
              if (o.editable || viewport.selectionMode === 'any') viewport.select(o.id);
            });
            const del = el('button', { type: 'button', class: 'icon', title: 'Delete', onclick: () => viewport.remove(o.id) }, '×');
            return el('div', { class: `item ${viewport.selected?.id === o.id ? 'selected' : ''}` }, vis, name, opacity, del);
          }),
        ),
      ),
    );
  };
  viewport.onChange(render);
  render();
  return root;
}
