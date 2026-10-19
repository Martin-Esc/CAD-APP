import * as THREE from 'three';
import type { AppContext, DesignModule } from './types';
import type { SceneObject } from '../viewer/Viewport';
import { MATERIALS } from '../viewer/Viewport';
import { contiguousRuns, getTooth, jawOf } from '../core/teeth';
import { placeTeeth } from '../core/arch';
import { teethWithRole } from '../core/case';
import { buildCrownShell, buildCrownCavity, buildPrepStump, prepRings, shapeFromTooth, ToothSurface } from '../geometry/toothShape';
import { activeLibrary, mergeParts, outerSurface, prepareTeeth, solidParts } from '../library/provider';
import { buildConnector } from '../geometry/connector';
import { buildDieCrown } from '../geometry/dieCrown';
import { detectMargin, resampleByAngle, controlPoints } from '../geometry/margin';
import { MeshBuilder } from '../geometry/MeshBuilder';
import { subtract, worldGeometry } from '../geometry/csg';
import { button, checkboxField, el, note, numberField, section } from '../ui/dom';

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

function label(ctx: AppContext, fdi: number): string {
  return ctx.state.numbering === 'fdi' ? String(fdi) : `#${getTooth(fdi).universal}`;
}

function moduleObjects(ctx: AppContext, kind?: string): SceneObject[] {
  return ctx.viewport.list().filter((o) => o.module === MODULE && (!kind || o.data.kind === kind));
}

/** Local tooth frame (x mesiodistal, y buccal, z occlusal) of a unit, in world space. */
function unitFrame(o: SceneObject): THREE.Matrix4 {
  o.mesh.updateMatrixWorld(true);
  return o.mesh.matrixWorld.clone().multiply((o.data.frame as THREE.Matrix4) ?? new THREE.Matrix4());
}

function rebuildConnectors(ctx: AppContext, run: number): void {
  const vp = ctx.viewport;
  vp.removeWhere((o) => o.module === MODULE && o.data.kind === 'connector' && o.data.run === run);
  const units = moduleObjects(ctx, 'unit')
    .filter((o) => o.data.run === run)
    .sort((a, b) => (a.data.order as number) - (b.data.order as number));
  for (let i = 0; i < units.length - 1; i++) {
    const a = units[i];
    const b = units[i + 1];
    const mb = buildConnector(unitFrame(a), a.data.height as number, unitFrame(b), b.data.height as number, ctx.state.params.connector);
    vp.add(`Connector ${a.data.fdi}-${b.data.fdi}`, mb.toGeometry(), MATERIALS.tooth(), {
      category: 'design',
      module: MODULE,
      editable: false,
      data: { kind: 'connector', run, jaw: jawOf(a.data.fdi as number) },
    });
  }
}

// ---------------------------------------------------------------------------
// Margin lines

function toothAxis(ctx: AppContext, fdi: number): { origin: THREE.Vector3; axis: THREE.Vector3; basis: THREE.Matrix4 } {
  const arch = ctx.arch(jawOf(fdi));
  const placement = placeTeeth(arch).get(fdi)!;
  return {
    origin: placement.center.clone(),
    axis: new THREE.Vector3(0, 0, arch.occlusalDir),
    basis: new THREE.Matrix4().extractRotation(placement.matrix),
  };
}

function getMargin(ctx: AppContext, fdi: number): THREE.Vector3[] | null {
  const m = ctx.state.margins[fdi];
  return m ? m.map((p) => new THREE.Vector3(...p)) : null;
}

function setMargin(ctx: AppContext, fdi: number, points: THREE.Vector3[] | null): void {
  if (points) ctx.state.margins[fdi] = points.map((p) => p.toArray() as [number, number, number]);
  else delete ctx.state.margins[fdi];
  showMargin(ctx, fdi);
}

function showMargin(ctx: AppContext, fdi: number, controls?: THREE.Vector3[]): void {
  ctx.viewport.removeWhere((o) => o.category === 'helper' && o.data.marginOf === fdi);
  const margin = getMargin(ctx, fdi);
  if (!margin) return;
  const curve = new THREE.CatmullRomCurve3(margin, true, 'centripetal');
  const tube = new THREE.TubeGeometry(curve, margin.length * 2, 0.08, 6, true);
  const material = new THREE.MeshBasicMaterial({ color: 0x35e07a, depthTest: false });
  const line = ctx.viewport.add(`Margin ${label(ctx, fdi)}`, tube, material, {
    category: 'helper',
    editable: false,
    data: { marginOf: fdi, jaw: jawOf(fdi) },
  });
  line.mesh.renderOrder = 10;
  for (const c of controls ?? []) {
    const dot = new THREE.SphereGeometry(0.22, 10, 8).translate(c.x, c.y, c.z);
    const m = ctx.viewport.add('Margin point', dot, new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false }), {
      category: 'helper',
      editable: false,
      data: { marginOf: fdi, jaw: jawOf(fdi), control: true },
    });
    m.mesh.renderOrder = 11;
  }
}

type MarginMode = 'idle' | 'draw' | 'edit' | 'detect-click';

class MarginTool {
  mode: MarginMode = 'idle';
  tooth: number | null = null;
  private drawn: THREE.Vector3[] = [];
  private controls: THREE.Vector3[] = [];

  constructor(private readonly ctx: AppContext, private readonly onChange: () => void) {}

  private scanOrWarn(fdi: number): SceneObject | null {
    const scan = this.ctx.scanFor(jawOf(fdi));
    if (!scan) this.ctx.status(`Load the ${jawOf(fdi)} scan (or the demo models) first.`, 'warn');
    return scan ?? null;
  }

  stop(): void {
    this.mode = 'idle';
    this.drawn = [];
    this.ctx.viewport.pickHandler = null;
    this.ctx.viewport.pickFilter = null;
    this.ctx.viewport.removeWhere((o) => o.category === 'helper' && (o.data.drawn === true || o.data.control === true));
    if (this.tooth) showMargin(this.ctx, this.tooth);
    this.onChange();
  }

  private listen(handler: (p: THREE.Vector3) => void): void {
    this.ctx.viewport.pickFilter = (o) => o.category === 'scan';
    this.ctx.viewport.pickHandler = (p) => handler(p);
  }

  detect(fdi: number, seed?: THREE.Vector3): boolean {
    const scan = this.scanOrWarn(fdi);
    if (!scan) return false;
    const { origin, axis } = toothAxis(this.ctx, fdi);
    try {
      const margin = detectMargin(worldGeometry(scan.mesh), seed ?? origin, axis);
      setMargin(this.ctx, fdi, margin);
      return true;
    } catch (e) {
      this.ctx.status(`Margin ${label(this.ctx, fdi)}: ${(e as Error).message}`, 'warn');
      return false;
    }
  }

  detectAtClick(fdi: number): void {
    if (!this.scanOrWarn(fdi)) return;
    this.stop();
    this.tooth = fdi;
    this.mode = 'detect-click';
    this.ctx.status(`Click the occlusal surface of prep ${label(this.ctx, fdi)}.`);
    this.listen((p) => {
      if (this.detect(fdi, p)) this.ctx.status(`Margin ${label(this.ctx, fdi)} detected. Use "Edit points" to refine it.`);
      this.stop();
    });
    this.onChange();
  }

  draw(fdi: number): void {
    if (!this.scanOrWarn(fdi)) return;
    this.stop();
    this.tooth = fdi;
    this.mode = 'draw';
    this.ctx.status(`Click along the finish line of ${label(this.ctx, fdi)} all the way around (8–20 points), then "Finish".`);
    this.listen((p) => {
      this.drawn.push(p.clone());
      const dot = new THREE.SphereGeometry(0.2, 10, 8).translate(p.x, p.y, p.z);
      this.ctx.viewport.add('Margin point', dot, new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false }), {
        category: 'helper',
        editable: false,
        data: { drawn: true, jaw: jawOf(fdi) },
      });
      this.ctx.status(`${this.drawn.length} margin point(s).`);
    });
    this.onChange();
  }

  edit(fdi: number): void {
    const margin = getMargin(this.ctx, fdi);
    if (!margin) {
      this.ctx.status('Detect or draw the margin first.', 'warn');
      return;
    }
    this.stop();
    this.tooth = fdi;
    this.mode = 'edit';
    this.controls = controlPoints(margin);
    showMargin(this.ctx, fdi, this.controls);
    this.ctx.status('Click on the scan where the margin should run: the nearest yellow point moves there. "Finish" when done.');
    const { origin, axis } = toothAxis(this.ctx, fdi);
    this.listen((p) => {
      let best = 0;
      this.controls.forEach((c, i) => {
        if (c.distanceTo(p) < this.controls[best].distanceTo(p)) best = i;
      });
      this.controls[best] = p.clone();
      this.ctx.state.margins[fdi] = resampleByAngle(this.controls, origin, axis).map((v) => v.toArray() as [number, number, number]);
      showMargin(this.ctx, fdi, this.controls);
    });
    this.onChange();
  }

  finish(): void {
    if (this.mode === 'draw' && this.tooth) {
      if (this.drawn.length < 4) {
        this.ctx.status('Click at least 4 points around the prep.', 'warn');
        return;
      }
      const { origin, axis } = toothAxis(this.ctx, this.tooth);
      setMargin(this.ctx, this.tooth, resampleByAngle(this.drawn, origin, axis));
      this.ctx.status(`Margin ${label(this.ctx, this.tooth)} drawn.`);
    }
    this.stop();
  }
}

// ---------------------------------------------------------------------------
// Design

async function generate(ctx: AppContext): Promise<void> {
  const { state, viewport } = ctx;
  const teeth = teethWithRole(state, 'crown', 'pontic');
  if (!teeth.length) {
    viewport.removeWhere((o) => o.module === MODULE);
    ctx.status('Mark teeth as Crown or Pontic on the tooth chart first.', 'warn');
    return;
  }
  await prepareTeeth(teeth);
  viewport.removeWhere((o) => o.module === MODULE);
  const library = activeLibrary();
  const scale = state.params.anatomyScale;
  const issues: string[] = [];
  const scanCache = new Map<string, THREE.BufferGeometry>();
  const scanGeometry = (fdi: number) => {
    const jaw = jawOf(fdi);
    const scan = ctx.scanFor(jaw);
    if (!scan) return null;
    if (!scanCache.has(jaw)) scanCache.set(jaw, worldGeometry(scan.mesh));
    return scanCache.get(jaw)!;
  };
  let dieCount = 0;
  contiguousRuns(teeth).forEach((span, run) => {
    issues.push(...validateSpan(span, state.roles));
    const placements = placeTeeth(ctx.arch(jawOf(span[0])));
    span.forEach((fdi, order) => {
      const role = state.roles[fdi];
      const shape = shapeFromTooth(getTooth(fdi), state.params.anatomyScale);
      const name = `${role === 'crown' ? 'Crown' : 'Pontic'} ${label(ctx, fdi)}`;
      const base = { kind: 'unit', fdi, role, run, order };
      const margin = role === 'crown' && state.params.fitToDie ? getMargin(ctx, fdi) : null;
      const scan = margin ? scanGeometry(fdi) : null;
      if (margin && scan) {
        try {
          const basis = new THREE.Matrix4().extractRotation(placements.get(fdi)!.matrix);
          const r = buildDieCrown(scan, margin, basis, library?.has(fdi) ? outerSurface(fdi, scale) : shape, state.params.prep);
          viewport.add(`${name} (die)`, r.mesh.toGeometry(), MATERIALS.tooth(), {
            category: 'design',
            module: MODULE,
            editable: false,
            data: { ...base, height: r.height, frame: r.frame, cavity: r.cavity, die: true, minThickness: r.minThickness },
          });
          dieCount++;
          if (r.minThickness < Math.min(state.params.prep.axialThickness, state.params.prep.occlusalThickness) - 0.05) {
            issues.push(`${name}: thinnest wall ${r.minThickness.toFixed(2)} mm`);
          }
          return;
        } catch (e) {
          issues.push(`${name}: die fit failed (${(e as Error).message}) – used the parametric prep`);
        }
      }
      if (role === 'crown' && library?.has(fdi)) {
        // library crown on the parametric prep: build it as a die crown on a virtual die (in the tooth frame)
        try {
          const die = buildPrepStump(shape, state.params.prep, 3).toGeometry();
          const prepMargin = prepRings(new ToothSurface(shape), state.params.prep, 0).rings[0];
          const r = buildDieCrown(die, prepMargin, new THREE.Matrix4(), outerSurface(fdi, scale), state.params.prep);
          viewport.add(name, r.mesh.toGeometry(), MATERIALS.tooth(), {
            category: 'design',
            module: MODULE,
            matrix: placements.get(fdi)!.matrix,
            data: { ...base, height: r.height, frame: r.frame, cavity: r.cavity },
          });
          return;
        } catch (e) {
          issues.push(`${name}: library crown failed (${(e as Error).message}) – used the procedural tooth`);
        }
      }
      const mb = role === 'crown' ? buildCrownShell(shape, state.params.prep) : mergeParts(solidParts(fdi, scale, 0));
      viewport.add(name, mb.toGeometry(), MATERIALS.tooth(), {
        category: 'design',
        module: MODULE,
        matrix: placements.get(fdi)!.matrix,
        data: {
          ...base,
          height: shape.height,
          frame: new THREE.Matrix4(),
          cavity: role === 'crown' ? buildCrownCavity(shape, state.params.prep) : undefined,
        },
      });
    });
    if (span.length > 1 && span.some((t) => state.roles[t] === 'pontic')) rebuildConnectors(ctx, run);
  });
  const summary = `Designed ${teeth.length} unit(s)${dieCount ? `, ${dieCount} fitted to scanned dies` : ''}${library ? ' from the tooth library' : ''}.`;
  ctx.status(issues.length ? `${summary} ${issues.join(' · ')}` : summary, issues.length ? 'warn' : 'info');
}

/** Fuse one bridge span into a single solid: union of units + connectors, minus every intaglio. */
async function mergeRun(ctx: AppContext, run: number): Promise<MeshBuilder> {
  const objs = moduleObjects(ctx).filter((o) => o.data.run === run && (o.data.kind === 'unit' || o.data.kind === 'connector'));
  const parts = objs.map((o) => MeshBuilder.fromGeometry(worldGeometry(o.mesh)));
  const cavities = objs
    .filter((o) => o.data.cavity)
    .map((o) => {
      o.mesh.updateMatrixWorld(true);
      return (o.data.cavity as MeshBuilder).clone().transform(o.mesh.matrixWorld);
    });
  return subtract(parts, cavities);
}

function runs(ctx: AppContext): number[] {
  return [...new Set(moduleObjects(ctx).map((o) => o.data.run as number))].sort((a, b) => a - b);
}

function isBridge(ctx: AppContext, run: number): boolean {
  return moduleObjects(ctx, 'connector').some((o) => o.data.run === run);
}

async function mergeAll(ctx: AppContext): Promise<void> {
  const bridges = runs(ctx).filter((r) => isBridge(ctx, r));
  if (!bridges.length) {
    ctx.status('No bridge to merge – single crowns are already one solid each.', 'warn');
    return;
  }
  ctx.status('Merging bridges…');
  try {
    for (const run of bridges) {
      const teeth = moduleObjects(ctx, 'unit')
        .filter((o) => o.data.run === run)
        .sort((a, b) => (a.data.order as number) - (b.data.order as number))
        .map((o) => o.data.fdi as number);
      const merged = await mergeRun(ctx, run);
      ctx.viewport.removeWhere((o) => o.module === MODULE && o.data.run === run);
      ctx.viewport.add(`Bridge ${label(ctx, teeth[0])}–${label(ctx, teeth[teeth.length - 1])} (merged)`, merged.toGeometry(), MATERIALS.tooth(), {
        category: 'design',
        module: MODULE,
        editable: false,
        data: { kind: 'merged', run, jaw: jawOf(teeth[0]) },
      });
    }
    ctx.status(`Merged ${bridges.length} bridge(s) into single solids. Generate again to edit.`);
  } catch (e) {
    ctx.status(`Merge failed: ${(e as Error).message}`, 'error');
  }
}

/** Export every span as a solid: bridges are merged on the fly. */
async function exportSolids(ctx: AppContext): Promise<void> {
  const all = runs(ctx);
  if (!all.length) {
    ctx.status('Nothing to export – generate a design first.', 'warn');
    return;
  }
  ctx.status('Preparing solids for export…');
  try {
    const geometries: THREE.BufferGeometry[] = [];
    for (const run of all) {
      const objs = moduleObjects(ctx).filter((o) => o.data.run === run);
      if (isBridge(ctx, run)) geometries.push((await mergeRun(ctx, run)).toGeometry());
      else geometries.push(...objs.map((o) => worldGeometry(o.mesh)));
    }
    ctx.exportGeometries(geometries, 'crown-bridge');
  } catch (e) {
    ctx.status(`Export failed: ${(e as Error).message}`, 'error');
  }
}

export const crownBridgeModule: DesignModule = {
  id: MODULE,
  title: 'Crown & Bridge',
  render(ctx) {
    const p = ctx.state.params;
    const regen = () => {
      if (moduleObjects(ctx).length) void generate(ctx);
    };
    const root = el('div', {});
    const marginBox = el('div', {});
    const tool = new MarginTool(ctx, () => renderMargin());
    const crowns = () => teethWithRole(ctx.state, 'crown').sort((a, b) => a - b);

    const renderMargin = () => {
      const list = crowns();
      if (!list.length) {
        marginBox.replaceChildren(note('Mark teeth as "Crown" on the chart to draw their margins.'));
        return;
      }
      if (!tool.tooth || !list.includes(tool.tooth)) tool.tooth = list[0];
      const fdi = tool.tooth;
      const select = el('select', {});
      for (const t of list) select.append(el('option', { value: t, selected: t === fdi }, `${label(ctx, t)}${ctx.state.margins[t] ? '  ✓ margin' : ''}`));
      select.addEventListener('change', () => {
        tool.stop();
        tool.tooth = Number(select.value);
        renderMargin();
      });
      const busy = tool.mode === 'draw' || tool.mode === 'edit';
      marginBox.replaceChildren(
        el('label', { class: 'field' }, el('span', {}, 'Tooth'), select),
        el(
          'div',
          { class: 'actions' },
          button('Detect', () => {
            if (tool.detect(fdi)) ctx.status(`Margin ${label(ctx, fdi)} detected. Check it and use "Edit points" where needed.`);
            renderMargin();
          }, 'primary'),
          button('Detect at click', () => tool.detectAtClick(fdi)),
          button('Draw', () => tool.draw(fdi)),
          button('Edit points', () => tool.edit(fdi)),
          button('Clear', () => {
            tool.stop();
            setMargin(ctx, fdi, null);
            renderMargin();
          }),
        ),
        busy ? el('div', { class: 'actions' }, button('Finish', () => tool.finish(), 'primary'), button('Cancel', () => tool.stop())) : '',
        el(
          'div',
          { class: 'actions' },
          button('Detect all crowns', () => {
            const found = list.filter((t) => tool.detect(t));
            ctx.status(`Detected ${found.length} of ${list.length} margin(s).`, found.length < list.length ? 'warn' : 'info');
            renderMargin();
          }),
        ),
      );
    };
    renderMargin();
    for (const t of crowns()) showMargin(ctx, t);

    root.append(
      note('Mark retainers as "Crown" and missing teeth as "Pontic" on the chart. Adjacent units become a bridge. With a margin on a scanned prep, the crown is fitted to the die; without one it uses the parametric prep below.'),
      section('Margin line', marginBox),
      section(
        'Cement gap',
        numberField('Cement gap', p.prep, 'cementGap', { min: 0, max: 0.3, step: 0.01, unit: 'mm', onChange: regen }),
        numberField('Gap-free band at margin', p.prep, 'marginSeal', { min: 0, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
        checkboxField('Fit crowns to scanned dies', p, 'fitToDie', regen),
      ),
      section(
        'Thickness',
        numberField('Margin thickness', p.prep, 'marginThickness', { min: 0.1, max: 1.5, step: 0.05, unit: 'mm', onChange: regen }),
        numberField('Min. axial thickness', p.prep, 'axialThickness', { min: 0.3, max: 2.5, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Min. occlusal thickness', p.prep, 'occlusalThickness', { min: 0.5, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
        numberField('Prep convergence (parametric)', p.prep, 'taper', { min: 0, max: 30, step: 1, unit: '°', onChange: regen }),
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
        button('Generate', () => void generate(ctx), 'primary'),
        button('Merge to solid', () => void mergeAll(ctx)),
        button('Export STL', () => void exportSolids(ctx)),
      ),
      note('Export always fuses each bridge into one manifold solid (units + connectors, intaglios kept clear).'),
    );
    return root;
  },
  onTransform(ctx, object: SceneObject) {
    if (object.data.kind === 'unit') {
      const run = object.data.run as number;
      if (isBridge(ctx, run)) rebuildConnectors(ctx, run);
    }
  },
};
