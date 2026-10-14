import type { AppContext, DesignModule } from './types';
import { MATERIALS } from '../viewer/Viewport';
import { buildNightguard } from '../geometry/nightguard';
import { button, el, note, numberField, section, selectField } from '../ui/dom';

const MODULE = 'nightguard';

function generate(ctx: AppContext, info: HTMLElement): void {
  const { state, viewport } = ctx;
  const p = state.params.nightguard;
  const scan = ctx.scanFor(p.jaw);
  if (!scan) {
    ctx.status(`Load a ${p.jaw} scan (or the demo models) first.`, 'warn');
    return;
  }
  viewport.removeWhere((o) => o.module === MODULE);
  scan.mesh.updateMatrixWorld(true);
  const world = scan.mesh.geometry.clone().applyMatrix4(scan.mesh.matrixWorld);
  const arch = ctx.arch(p.jaw);
  const t0 = performance.now();
  try {
    const result = buildNightguard(world, arch.occlusalDir, p);
    viewport.add(`Nightguard (${p.jaw})`, result.mesh.toGeometry(), MATERIALS.splint(), {
      category: 'design',
      module: MODULE,
      editable: false,
      data: { kind: 'nightguard', jaw: p.jaw },
    });
    info.replaceChildren(
      note(
        `Occlusal thickness over the teeth: ${result.minThickness.toFixed(2)} – ${result.maxThickness.toFixed(2)} mm. ` +
          `Built in ${Math.round(performance.now() - t0)} ms.`,
      ),
    );
    ctx.status('Nightguard generated.');
  } catch (e) {
    ctx.status(`Nightguard failed: ${(e as Error).message}`, 'error');
  } finally {
    world.dispose();
  }
}

export const nightguardModule: DesignModule = {
  id: MODULE,
  title: 'Nightguard',
  render(ctx) {
    const p = ctx.state.params.nightguard;
    const info = el('div', {});
    const regen = () => {
      if (ctx.viewport.list().some((o) => o.module === MODULE)) generate(ctx, info);
    };
    return el(
      'div',
      {},
      note('Occlusal splint built along the insertion axis (scan +z / −z), so undercuts are blocked out automatically. Orient the scan so the occlusal plane is horizontal before generating.'),
      section(
        'Splint',
        selectField('Arch', p, 'jaw', [['upper', 'Upper (maxillary)'], ['lower', 'Lower (mandibular)']], regen),
        selectField('Occlusal surface', p, 'surface', [['flat', 'Flat bite plane'], ['anatomic', 'Smoothed anatomic']], regen),
        numberField('Min. thickness', p, 'thickness', { min: 0.8, max: 5, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Fit gap', p, 'gap', { min: 0, max: 0.5, step: 0.01, unit: 'mm', onChange: regen }),
        numberField('Coverage from cusp tips', p, 'coverDepth', { min: 1.5, max: 9, step: 0.25, unit: 'mm', onChange: regen }),
        numberField('Buccal/lingual wall', p, 'wallThickness', { min: 0.5, max: 4, step: 0.1, unit: 'mm', onChange: regen }),
      ),
      section(
        'Quality',
        numberField('Resolution', p, 'resolution', { min: 0.15, max: 1, step: 0.05, unit: 'mm', onChange: regen }),
        numberField('Outline smoothing', p, 'outlineSmoothing', { min: 0, max: 20, step: 1, onChange: regen }),
      ),
      info,
      el(
        'div',
        { class: 'actions' },
        button('Generate', () => generate(ctx, info), 'primary'),
        button('Export STL', () => ctx.exportObjects(ctx.viewport.list().filter((o) => o.module === MODULE), 'nightguard')),
      ),
    );
  },
};
