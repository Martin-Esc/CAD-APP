import { el } from './dom';
import { getTooth } from '../core/teeth';
import { ROLE_LABELS, type CaseState, type UnitRole } from '../core/case';

type Brush = UnitRole | 'clear';

const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

/**
 * Odontogram: pick a "brush" (crown, pontic, wax-up, missing) and
 * click teeth to assign it. Shown from the clinician's view (patient's right
 * on the left of the screen).
 */
export function toothChart(state: CaseState, onChange: () => void): HTMLElement {
  let brush: Brush = 'crown';
  const root = el('div', { class: 'tooth-chart' });

  const brushes = el('div', { class: 'brushes' });
  const renderBrushes = () => {
    brushes.replaceChildren(
      ...([...Object.keys(ROLE_LABELS), 'clear'] as Brush[]).map((b) =>
        el(
          'button',
          {
            type: 'button',
            class: `brush role-${b} ${b === brush ? 'active' : ''}`,
            title: b === 'clear' ? 'Clear' : ROLE_LABELS[b as UnitRole],
            onclick: () => {
              brush = b;
              renderBrushes();
            },
          },
          b === 'clear' ? 'Clear' : ROLE_LABELS[b as UnitRole].split(' ')[0],
        ),
      ),
    );
  };

  const rows = el('div', { class: 'rows' });
  const renderRows = () => {
    const row = (teeth: number[], cls: string) =>
      el(
        'div',
        { class: `row ${cls}` },
        ...teeth.map((fdi) => {
          const role = state.roles[fdi];
          const info = getTooth(fdi);
          const labelText = state.numbering === 'fdi' ? String(fdi) : String(info.universal);
          return el(
            'button',
            {
              type: 'button',
              class: `tooth kind-${info.kind} ${role ? 'role-' + role : ''} ${fdi % 10 === 1 && info.side === 'right' ? 'midline' : ''}`,
              title: `${info.name}${role ? ' – ' + ROLE_LABELS[role] : ''}`,
              onclick: () => {
                if (brush === 'clear' || state.roles[fdi] === brush) delete state.roles[fdi];
                else state.roles[fdi] = brush;
                renderRows();
                onChange();
              },
            },
            labelText,
          );
        }),
      );
    rows.replaceChildren(row(UPPER, 'upper'), row(LOWER, 'lower'));
  };

  renderBrushes();
  renderRows();
  root.append(
    el('div', { class: 'chart-head' }, el('span', {}, 'Patient right'), el('span', {}, 'Patient left')),
    rows,
    brushes,
  );
  return root;
}
