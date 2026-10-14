import type { AppContext, DesignModule } from './types';
import type { SceneObject } from '../viewer/Viewport';
import { MATERIALS } from '../viewer/Viewport';
import { contiguousRuns, getTooth, jawOf } from '../core/teeth';
import { placeTeeth } from '../core/arch';
import { teethWithRole } from '../core/case';
import { buildCrownShell, buildSolidTooth, shapeFromTooth } from '../geometry/toothShape';
import { buildConnector } from '../geometry/connector';
import { button, el, note, numberField, section } from '../ui/dom';

const MODULE = 'crown-bridge';

/** Checks a span for basic bridge design rules. */
export function validateSpan(span: number[], roles: Record<number, string>): string[] {
  const issues: string[] = [];
  const pontics = span.filter((t) => roles[t] === 'pontic');
  const retainers = span.filter((t) => roles[t] === 'crown');
  if (pontics.length && !retainers.length) issues.push(`Span ${span.join('-')}: pontics without any retainer`);
  if (pontics.length && (roles[span[0]] === 'pontic' || roles[span[span.length - 1]] === 'pontic')) {
    issues.push(`Span ${span.join('-')}: cantilever pontic – check the clinical indication`);
  }
  if (pontics.length > 2 * retainers.length) issues.push(`Span ${span.join('-')}: more pontics than the retainers can support (Ante's law)`);
  return issues;
}

function rebuildConnectors(ctx: AppContext, run: number): void {
  const vp = ctx.viewport;
  vp.removeWhere((o) => o.module === MODULE && o.data.kind === 'connector' && o.data.run === run);
  const units = vp
    .list()
    .filter((o) => o.module === MODULE && o.data.kind === 'unit' && o.data.run === run)
    .sort((a, b) => (a.data.order as number) - (b.data.order as number));
  for (let i = 0; i < units.length - 1; i++) {
    const a = units[i];
    const b = units[i + 1];
    a.mesh.updateMatrixWorld(true);
    b.mesh.updateMatrixWorld(true);
    const mb = buildConnector(a.mesh.matrixWorld, a.data.height as number, b.mesh.matrixWorld, b.data.height as number, ctx.state.params.connector);
    vp.add(`Connector ${a.data.fdi}-${b.data.fdi}`, mb.toGeometry(), MATERIALS.tooth(), {
      category: 'design',
      module: MODULE,
      editable: false,
      data: { kind: 'connector', run, jaw: jawOf(a.data.fdi as number) },
    });
  }
}

function generate(ctx: AppContext): void {
  const { state, viewport } = ctx;
  viewport.removeWhere((o) => o.module === MODULE);
  const teeth = teethWithRole(state, 'crown', 'pontic');
  if (!teeth.length) {
    ctx.status('Mark teeth as Crown or Pontic on the tooth chart first.', 'warn');
    return;
  }
  const issues: string[] = [];
  contiguousRuns(teeth).forEach((span, run) => {
    issues.push(...validateSpan(span, state.roles));
    const placements = placeTeeth(ctx.arch(jawOf(span[0])));
    span.forEach((fdi, order) => {
      const role = state.roles[fdi];
      const shape = shapeFromTooth(getTooth(fdi), state.params.anatomyScale);
      // pontics: closed full-contour unit with a shallow ovate base
      const mb = role === 'crown' ? buildCrownShell(shape, state.params.prep) : buildSolidTooth(shape, 1.0);
      viewport.add(`${role === 'crown' ? 'Crown' : 'Pontic'} ${label(ctx, fdi)}`, mb.toGeometry(), MATERIALS.tooth(), {
        category: 'design',
        module: MODULE,
        matrix: placements.get(fdi)!.matrix,
        data: { kind: 'unit', fdi, role, run, order, height: shape.height },
      });
    });
    if (span.length > 1 && span.some((t) => state.roles[t] === 'pontic')) rebuildConnectors(ctx, run);
  });
  ctx.status(issues.length ? issues.join(' · ') : `Designed ${teeth.length} unit(s).`, issues.length ? 'warn' : 'info');
}

function label(ctx: AppContext, fdi: number): string {
  return ctx.state.numbering === 'fdi' ? String(fdi) : `#${getTooth(fdi).universal}`;
}

export const crownBridgeModule: DesignModule = {
  id: MODULE,
  title: 'Crown & Bridge',
  render(ctx) {
    const p = ctx.state.params;
    const regen = () => {
      if (ctx.viewport.list().some((o) => o.module === MODULE)) generate(ctx);
    };
    return el(
      'div',
      {},
      note('Mark retainers as "Crown" and missing teeth as "Pontic" on the chart. Adjacent units become a bridge. Select a unit in the viewport to move / rotate / scale it (W / E / R); connectors follow.'),
      section(
        'Preparation & intaglio',
        numberField('Cement gap', p.prep, 'cementGap', { min: 0, max: 0.3, step: 0.01, unit: 'mm', onChange: regen }),
        numberField('Marginal seal (no gap)', p.prep, 'marginSeal', { min: 0, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Margin thickness', p.prep, 'marginThickness', { min: 0.2, max: 1.5, step: 0.05, unit: 'mm', onChange: regen }),
        numberField('Min. axial thickness', p.prep, 'axialThickness', { min: 0.3, max: 2.5, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Min. occlusal thickness', p.prep, 'occlusalThickness', { min: 0.5, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Prep convergence', p.prep, 'taper', { min: 0, max: 30, step: 1, unit: '°', onChange: regen }),
      ),
      section(
        'Anatomy & connectors',
        numberField('Anatomy scale', p, 'anatomyScale', { min: 0.7, max: 1.3, step: 0.01, onChange: regen }),
        numberField('Connector area', p.connector, 'area', { min: 4, max: 30, step: 0.5, unit: 'mm²', onChange: regen }),
        numberField('Connector height/width', p.connector, 'aspect', { min: 0.6, max: 2, step: 0.05, onChange: regen }),
        numberField('Connector position', p.connector, 'heightRatio', { min: 0.2, max: 0.9, step: 0.05, onChange: regen }),
      ),
      el(
        'div',
        { class: 'actions' },
        button('Generate', () => generate(ctx), 'primary'),
        button('Export STL', () => ctx.exportObjects(ctx.viewport.list().filter((o) => o.module === MODULE), 'crown-bridge')),
      ),
    );
  },
  onTransform(ctx, object: SceneObject) {
    if (object.data.kind === 'unit') {
      const run = object.data.run as number;
      const hasConnectors = ctx.viewport.list().some((o) => o.module === MODULE && o.data.kind === 'connector' && o.data.run === run);
      if (hasConnectors) rebuildConnectors(ctx, run);
    }
  },
};
