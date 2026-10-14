import * as THREE from 'three';
import type { AppContext, DesignModule } from './types';
import { MATERIALS } from '../viewer/Viewport';
import { getTooth, jawOf } from '../core/teeth';
import { placeTeeth } from '../core/arch';
import { teethWithRole } from '../core/case';
import { buildAbutment, validateAbutment } from '../geometry/abutment';
import { button, el, note, numberField, section } from '../ui/dom';

const MODULE = 'abutment';

function generate(ctx: AppContext, issuesBox: HTMLElement): void {
  const { state, viewport } = ctx;
  viewport.removeWhere((o) => o.module === MODULE);
  const p = state.params.abutment;
  const issues = validateAbutment(p);
  issuesBox.replaceChildren(...issues.map((i) => note(i, 'warn')));
  const sites = teethWithRole(state, 'abutment');
  if (!sites.length) {
    ctx.status('Mark implant sites as "Implant abutment" on the tooth chart first.', 'warn');
    return;
  }
  const geometry = buildAbutment(p).toGeometry();
  for (const fdi of sites) {
    const placement = placeTeeth(ctx.arch(jawOf(fdi))).get(fdi)!;
    // implant platform sits one gingival height below the gum line
    const matrix = placement.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -p.gingivalHeight));
    viewport.add(`Abutment ${ctx.state.numbering === 'fdi' ? fdi : '#' + getTooth(fdi).universal}`, geometry.clone(), MATERIALS.metal(), {
      category: 'design',
      module: MODULE,
      matrix,
      data: { kind: 'abutment', fdi },
    });
  }
  ctx.status(`Designed ${sites.length} abutment(s)${issues.length ? ' – see warnings' : ''}.`, issues.length ? 'warn' : 'info');
}

export const abutmentModule: DesignModule = {
  id: MODULE,
  title: 'Abutment',
  render(ctx) {
    const p = ctx.state.params.abutment;
    const issuesBox = el('div', {});
    const regen = () => {
      if (ctx.viewport.list().some((o) => o.module === MODULE)) generate(ctx, issuesBox);
      else issuesBox.replaceChildren(...validateAbutment(p).map((i) => note(i, 'warn')));
    };
    return el(
      'div',
      {},
      note('Custom titanium / zirconia abutment on an internal-hex implant. Set the connection to match your implant system’s library values before manufacturing.'),
      section(
        'Implant connection',
        numberField('Platform Ø', p, 'platformDiameter', { min: 3, max: 7, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Hex across flats', p, 'hexAcrossFlats', { min: 1.5, max: 4, step: 0.05, unit: 'mm', onChange: regen }),
        numberField('Hex height', p, 'hexHeight', { min: 0.5, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Screw channel Ø', p, 'screwChannel', { min: 1.2, max: 3, step: 0.05, unit: 'mm', onChange: regen }),
      ),
      section(
        'Emergence & margin',
        numberField('Gingival height', p, 'gingivalHeight', { min: 0.5, max: 6, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Margin MD', p, 'marginMD', { min: 3, max: 12, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Margin BL', p, 'marginBL', { min: 3, max: 12, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Emergence (−concave/+convex)', p, 'emergence', { min: -1, max: 1, step: 0.1, onChange: regen }),
        numberField('Shoulder width', p, 'shoulder', { min: 0, max: 1.5, step: 0.05, unit: 'mm', onChange: regen }),
      ),
      section(
        'Post',
        numberField('Post height', p, 'postHeight', { min: 2, max: 9, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Taper per wall', p, 'taper', { min: 0, max: 15, step: 0.5, unit: '°', onChange: regen }),
        numberField('Angulation', p, 'angulation', { min: 0, max: 30, step: 1, unit: '°', onChange: regen }),
      ),
      issuesBox,
      el(
        'div',
        { class: 'actions' },
        button('Generate', () => generate(ctx, issuesBox), 'primary'),
        button('Export STL', () => ctx.exportObjects(ctx.viewport.list().filter((o) => o.module === MODULE), 'abutments')),
      ),
    );
  },
};
