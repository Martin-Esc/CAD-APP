import type { AppContext, DesignModule } from './types';
import { MATERIALS } from '../viewer/Viewport';
import { getTooth, jawOf } from '../core/teeth';
import { placeTeeth } from '../core/arch';
import { teethWithRole } from '../core/case';
import { buildSolidTooth, shapeFromTooth } from '../geometry/toothShape';
import { button, el, note, numberField, section } from '../ui/dom';

const MODULE = 'waxup';

function generate(ctx: AppContext): void {
  const { state, viewport } = ctx;
  viewport.removeWhere((o) => o.module === MODULE);
  const teeth = teethWithRole(state, 'waxup');
  if (!teeth.length) {
    ctx.status('Mark teeth as "Wax-up" on the tooth chart first.', 'warn');
    return;
  }
  for (const fdi of teeth) {
    const placement = placeTeeth(ctx.arch(jawOf(fdi))).get(fdi)!;
    const shape = shapeFromTooth(getTooth(fdi), state.params.waxupScale);
    viewport.add(`Wax-up ${ctx.state.numbering === 'fdi' ? fdi : '#' + getTooth(fdi).universal}`, buildSolidTooth(shape, 1.5).toGeometry(), MATERIALS.waxup(), {
      category: 'design',
      module: MODULE,
      matrix: placement.matrix,
      data: { kind: 'waxup', fdi },
    });
  }
  ctx.status(`Wax-up of ${teeth.length} tooth/teeth proposed. Select a tooth and use W / E / R to move, rotate and scale it.`);
}

export const waxupModule: DesignModule = {
  id: MODULE,
  title: 'Wax-up',
  render(ctx) {
    const regen = () => {
      if (ctx.viewport.list().some((o) => o.module === MODULE)) generate(ctx);
    };
    return el(
      'div',
      {},
      note('Diagnostic wax-up: library teeth are proposed on the arch for the selected positions. Adjust them, then export them merged with the model (“Export with scan”) to print a model for a mock-up / putty index.'),
      section('Proposal', numberField('Tooth size', ctx.state.params, 'waxupScale', { min: 0.8, max: 1.25, step: 0.01, onChange: regen })),
      el(
        'div',
        { class: 'actions' },
        button('Generate', () => generate(ctx), 'primary'),
        button('Export wax-up', () => ctx.exportObjects(ctx.viewport.list().filter((o) => o.module === MODULE), 'waxup')),
        button('Export with scan', () => {
          const wax = ctx.viewport.list().filter((o) => o.module === MODULE);
          const jaws = new Set(wax.map((o) => jawOf(o.data.fdi as number)));
          const scans = [...jaws].map((j) => ctx.scanFor(j)).filter((s) => s !== undefined);
          ctx.exportObjects([...scans, ...wax], 'waxup-model');
        }),
      ),
    );
  },
};
