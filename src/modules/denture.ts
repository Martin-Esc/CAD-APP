import type { AppContext, DesignModule } from './types';
import { MATERIALS } from '../viewer/Viewport';
import type { Jaw } from '../core/teeth';
import { buildDentureBase, buildDentureTeeth } from '../geometry/denture';
import { button, checkboxField, el, note, numberField, section, selectField } from '../ui/dom';

const MODULE = 'denture';

function generate(ctx: AppContext): void {
  const { state, viewport } = ctx;
  viewport.removeWhere((o) => o.module === MODULE);
  const p = state.params.denture;
  const jaws: Jaw[] = p.jaw === 'both' ? ['upper', 'lower'] : [p.jaw];
  for (const jaw of jaws) {
    const arch = ctx.arch(jaw);
    viewport.add(`Denture base (${jaw})`, buildDentureBase(arch, p).toGeometry(), MATERIALS.gingiva(), {
      category: 'design',
      module: MODULE,
      editable: false,
      data: { kind: 'base', jaw },
    });
    for (const t of buildDentureTeeth(arch, p)) {
      viewport.add(`Denture tooth ${t.fdi}`, t.mesh.toGeometry(), MATERIALS.tooth(), {
        category: 'design',
        module: MODULE,
        matrix: t.matrix,
        data: { kind: 'tooth', fdi: t.fdi, jaw },
      });
    }
  }
  ctx.status(`Complete denture set-up generated (${jaws.join(' + ')}). Select teeth to adjust the set-up.`);
}

export const dentureModule: DesignModule = {
  id: MODULE,
  title: 'Denture',
  render(ctx) {
    const p = ctx.state.params.denture;
    const regen = () => {
      if (ctx.viewport.list().some((o) => o.module === MODULE)) generate(ctx);
    };
    return el(
      'div',
      {},
      note('Complete denture: the base is swept along the arch (fit the arch to the edentulous scan in the Case tab), teeth are set from the library along the same arch and can be adjusted individually.'),
      section(
        'Set-up',
        selectField('Arch', p, 'jaw', [['both', 'Upper + lower'], ['upper', 'Upper (maxillary)'], ['lower', 'Lower (mandibular)']], regen),
        numberField('Tooth size', p, 'toothScale', { min: 0.8, max: 1.2, step: 0.01, onChange: regen }),
        checkboxField('Set second molars', p, 'includeSecondMolars', regen),
      ),
      section(
        'Base',
        numberField('Buccal flange depth', p, 'flangeDepth', { min: 4, max: 14, step: 0.5, unit: 'mm', onChange: regen }),
        numberField('Lingual flange depth', p, 'lingualFlangeDepth', { min: 3, max: 12, step: 0.5, unit: 'mm', onChange: regen }),
        checkboxField('Full palate (upper)', p, 'palate', regen),
        numberField('Palate thickness', p, 'palateThickness', { min: 1.5, max: 4, step: 0.1, unit: 'mm', onChange: regen }),
      ),
      el(
        'div',
        { class: 'actions' },
        button('Generate', () => generate(ctx), 'primary'),
        button('Export base', () =>
          ctx.exportObjects(ctx.viewport.list().filter((o) => o.module === MODULE && o.data.kind === 'base'), 'denture-base'),
        ),
        button('Export teeth', () =>
          ctx.exportObjects(ctx.viewport.list().filter((o) => o.module === MODULE && o.data.kind === 'tooth'), 'denture-teeth'),
        ),
      ),
    );
  },
};
