import type { AppContext, DesignModule } from './types';
import type { SceneObject } from '../viewer/Viewport';
import { MATERIALS } from '../viewer/Viewport';
import { archOrder, type Jaw } from '../core/teeth';
import { prepareTeeth, solidTooth } from '../library/provider';
import { MeshBuilder } from '../geometry/MeshBuilder';
import { worldGeometry } from '../geometry/csg';
import {
  buildDentureBaseParts,
  buildDentureTeeth,
  buildMergedDenture,
  buildSocketedBase,
  validateDenture,
} from '../geometry/denture';
import { button, checkboxField, el, note, numberField, section, selectField } from '../ui/dom';

const MODULE = 'denture';

function objects(ctx: AppContext, kind: 'base' | 'tooth', jaw?: Jaw): SceneObject[] {
  return ctx.viewport.list().filter((o) => o.module === MODULE && o.data.kind === kind && (!jaw || o.data.jaw === jaw));
}

function teethWorld(ctx: AppContext, jaw: Jaw): MeshBuilder[] {
  return objects(ctx, 'tooth', jaw).map((o) => MeshBuilder.fromGeometry(worldGeometry(o.mesh)));
}

/** Socket version counter per jaw, so a slow boolean never overwrites a newer one. */
const socketJob: Record<string, number> = {};

async function cutSockets(ctx: AppContext, jaw: Jaw): Promise<void> {
  const base = objects(ctx, 'base', jaw)[0];
  if (!base) return;
  const job = (socketJob[jaw] = (socketJob[jaw] ?? 0) + 1);
  ctx.status(`Cutting tooth sockets in the ${jaw} base…`);
  try {
    const result = await buildSocketedBase(base.data.parts as MeshBuilder[], teethWorld(ctx, jaw), ctx.state.params.denture.tolerance);
    if (job !== socketJob[jaw] || !ctx.viewport.get(base.id)) return;
    ctx.viewport.setGeometry(base.id, result.toGeometry());
    base.data.socketed = true;
    ctx.status(`Two-piece ${jaw} denture: sockets cut with ${ctx.state.params.denture.tolerance.toFixed(2)} mm tolerance. Hide the teeth to inspect them.`);
  } catch (e) {
    ctx.status(`Socket cut failed: ${(e as Error).message}`, 'error');
  }
}

async function generate(ctx: AppContext, issuesBox: HTMLElement): Promise<void> {
  const { state, viewport } = ctx;
  const p = state.params.denture;
  const issues = validateDenture(p);
  issuesBox.replaceChildren(...issues.map((i) => note(i, 'warn')));
  const jaws: Jaw[] = p.jaw === 'both' ? ['upper', 'lower'] : [p.jaw];
  // each tooth as one solid that reaches `socketDepth` into the base
  const fdis = jaws.flatMap((j) => archOrder(j)).filter((f) => f % 10 !== 8 && (f % 10 !== 7 || p.includeSecondMolars));
  ctx.status('Preparing denture teeth…');
  let solids: Map<number, MeshBuilder>;
  try {
    await prepareTeeth(fdis);
    solids = new Map(await Promise.all(fdis.map(async (f) => [f, await solidTooth(f, p.toothScale, p.socketDepth)] as const)));
  } catch (e) {
    ctx.status(`Could not prepare the denture teeth: ${(e as Error).message}`, 'error');
    return;
  }
  viewport.removeWhere((o) => o.module === MODULE);
  for (const jaw of jaws) {
    const arch = ctx.arch(jaw);
    const parts = buildDentureBaseParts(arch, p);
    const preview = new MeshBuilder();
    parts.forEach((part) => preview.append(part));
    viewport.add(`Denture base (${jaw})`, preview.toGeometry(), MATERIALS.gingiva(), {
      category: 'design',
      module: MODULE,
      editable: false,
      data: { kind: 'base', jaw, parts },
    });
    for (const t of buildDentureTeeth(arch, p, (f) => solids.get(f)!.clone())) {
      viewport.add(`Denture tooth ${t.fdi}`, t.mesh.toGeometry(), MATERIALS.tooth(), {
        category: 'design',
        module: MODULE,
        matrix: t.matrix,
        data: { kind: 'tooth', fdi: t.fdi, jaw },
      });
    }
    if (p.twoPiece) void cutSockets(ctx, jaw);
  }
  if (!p.twoPiece) ctx.status(`Denture set-up generated (${jaws.join(' + ')}). Select teeth to adjust the set-up.`);
}

async function exportMerged(ctx: AppContext): Promise<void> {
  const bases = objects(ctx, 'base');
  if (!bases.length) {
    ctx.status('Generate the denture first.', 'warn');
    return;
  }
  ctx.status('Merging base and teeth into one solid…');
  try {
    const geometries = [];
    for (const base of bases) {
      const jaw = base.data.jaw as Jaw;
      geometries.push((await buildMergedDenture(base.data.parts as MeshBuilder[], teethWorld(ctx, jaw))).toGeometry());
    }
    ctx.exportGeometries(geometries, 'denture-merged');
  } catch (e) {
    ctx.status(`Merge failed: ${(e as Error).message}`, 'error');
  }
}

async function exportBase(ctx: AppContext): Promise<void> {
  const bases = objects(ctx, 'base');
  if (!bases.length) {
    ctx.status('Generate the denture first.', 'warn');
    return;
  }
  for (const b of bases) if (!b.data.socketed) await cutSockets(ctx, b.data.jaw as Jaw);
  ctx.exportGeometries(objects(ctx, 'base').map((o) => worldGeometry(o.mesh)), 'denture-base-socketed');
}

let socketTimer: ReturnType<typeof setTimeout> | undefined;

export const dentureModule: DesignModule = {
  id: MODULE,
  title: 'Denture',
  render(ctx) {
    const p = ctx.state.params.denture;
    const root = el('div', {});
    const issuesBox = el('div', {});
    const regen = () => {
      if (ctx.viewport.list().some((o) => o.module === MODULE)) void generate(ctx, issuesBox);
      else issuesBox.replaceChildren(...validateDenture(p).map((i) => note(i, 'warn')));
    };
    const build = () => {
      root.replaceChildren(
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
        section(
          'Construction',
          checkboxField('Two-piece (teeth separate from base)', p, 'twoPiece', () => {
            build();
            regen();
          }),
          p.twoPiece
            ? el(
                'div',
                {},
                numberField('Tooth depth into base', p, 'socketDepth', { min: 0.5, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
                numberField('Socket tolerance (offset)', p, 'tolerance', { min: 0, max: 0.5, step: 0.01, unit: 'mm', onChange: regen }),
                note('Each socket is the tooth grown by the tolerance, so the printed teeth slide in with an even gap for bonding resin. Typical: 0.05–0.15 mm (printed), 0.1–0.2 mm (milled). Sockets update automatically when you move a tooth.'),
              )
            : note('One-piece: base and teeth are fused into a single solid on export.'),
          issuesBox,
        ),
        el(
          'div',
          { class: 'actions' },
          button('Generate', () => void generate(ctx, issuesBox), 'primary'),
          ...(p.twoPiece
            ? [
                button('Export base (sockets)', () => void exportBase(ctx)),
                button('Export teeth', () => ctx.exportObjects(objects(ctx, 'tooth'), 'denture-teeth')),
              ]
            : [button('Export merged denture', () => void exportMerged(ctx))]),
        ),
      );
    };
    build();
    issuesBox.replaceChildren(...validateDenture(p).map((i) => note(i, 'warn')));
    return root;
  },
  onTransform(ctx, object) {
    if (object.data.kind !== 'tooth' || !ctx.state.params.denture.twoPiece) return;
    const jaw = object.data.jaw as Jaw;
    const base = objects(ctx, 'base', jaw)[0];
    if (base) base.data.socketed = false;
    // re-cut once the user stops dragging
    clearTimeout(socketTimer);
    socketTimer = setTimeout(() => void cutSockets(ctx, jaw), 500);
  },
};
