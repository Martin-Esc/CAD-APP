import * as THREE from 'three';
import type { AppContext, DesignModule } from './types';
import type { SceneObject } from '../viewer/Viewport';
import { MATERIALS } from '../viewer/Viewport';
import { contiguousRuns, getTooth, jawOf, type Jaw } from '../core/teeth';
import { placeTeeth } from '../core/arch';
import { teethWithRole } from '../core/case';
import { buildCrownShell, buildCrownCavity, buildPrepStump, prepRings, shapeFromTooth, ToothSurface } from '../geometry/toothShape';
import { activeLibrary, mergeParts, outerSurface, prepareTeeth, solidParts } from '../library/provider';
import { buildConnector } from '../geometry/connector';
import { buildDieCrown, adaptWeights, type DieCrownResult } from '../geometry/dieCrown';
import { adaptToObstacles, makeObstacleGeometry, thicknessValues, contactValues, applyColorMap, thicknessStops, CONTACT_STOPS, type Obstacle } from '../geometry/contacts';
import { MATERIALS as MATERIAL_PRESETS, materialById, isAnteriorConnector, minimumConnectorArea } from '../core/materials';
import { analyseAxis, estimateInsertionAxis, undercutOverlay, type AxisAnalysis } from '../geometry/insertion';
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
  const params = ctx.state.params.connector;
  const material = materialById(ctx.state.params.material);
  const longSpan = hasLongSpan(units.map((u) => u.data.role as string));
  for (let i = 0; i < units.length - 1; i++) {
    const a = units[i];
    const b = units[i + 1];
    const fa = a.data.fdi as number, fb = b.data.fdi as number;
    let area = isAnteriorConnector(fa, fb) ? params.areaAnterior : params.area;
    // long spans: never below the material's long-span minimum
    if (material && longSpan) area = Math.max(area, minimumConnectorArea(material, fa, fb, true));
    const mb = buildConnector(unitFrame(a), a.data.height as number, unitFrame(b), b.data.height as number, { ...params, area });
    vp.add(`Connector ${a.data.fdi}-${b.data.fdi}`, mb.toGeometry(), MATERIALS.tooth(), {
      category: 'design',
      module: MODULE,
      editable: false,
      data: { kind: 'connector', run, jaw: jawOf(a.data.fdi as number), area },
    });
  }
}

/** Two or more adjacent pontics make a long span (larger connectors). */
function hasLongSpan(roles: string[]): boolean {
  for (let i = 0; i < roles.length - 1; i++) if (roles[i] === 'pontic' && roles[i + 1] === 'pontic') return true;
  return false;
}

/** Material rules for a span: connector minimums and indication. */
function materialIssues(ctx: AppContext, span: number[]): string[] {
  const material = materialById(ctx.state.params.material);
  if (!material) return [];
  const roles = ctx.state.roles;
  const issues: string[] = [];
  const isBridge = span.length > 1 && span.some((t) => roles[t] === 'pontic');
  if (!isBridge) return issues;
  if (material.bridges === 'no') issues.push(`${material.label}: bridges are not indicated – single crowns only`);
  if (material.bridges === 'anterior-premolar' && span.some((t) => t % 10 >= 6)) {
    issues.push(`${material.label}: bridges only up to the second premolar`);
  }
  const p = ctx.state.params.connector;
  const longSpan = hasLongSpan(span.map((t) => roles[t]));
  for (let i = 0; i < span.length - 1; i++) {
    const [a, b] = [span[i], span[i + 1]];
    const min = minimumConnectorArea(material, a, b, longSpan);
    const used = Math.max(isAnteriorConnector(a, b) ? p.areaAnterior : p.area, longSpan ? min : 0);
    if (used < min - 1e-6) issues.push(`Connector ${a}-${b}: ${used} mm² is below the ${material.label} minimum of ${min} mm²`);
  }
  return issues;
}

/** Insertion axis of a tooth: the stored per-tooth axis, or the occlusal direction of its arch. */
function insertionBasis(ctx: AppContext, fdi: number, placement: THREE.Matrix4): THREE.Matrix4 {
  const basis = new THREE.Matrix4().extractRotation(placement);
  const stored = ctx.state.axes[fdi];
  if (!stored) return basis;
  const z = new THREE.Vector3(...stored).normalize();
  const x = new THREE.Vector3().setFromMatrixColumn(basis, 0);
  x.sub(z.clone().multiplyScalar(x.dot(z))).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

interface ContactContext {
  antagonist: Obstacle | null;
  neighbours: { bvh: Obstacle['bvh']; geometry: THREE.BufferGeometry } | null;
}

/** Obstacles (BVHs over the scans), built once per design run. */
function contactContext(ctx: AppContext, jaw: Jaw, scanGeometry: (j: Jaw) => THREE.BufferGeometry | null, cache: Map<string, ReturnType<typeof makeObstacleGeometry>>): ContactContext {
  const get = (j: Jaw) => {
    if (!cache.has(j)) {
      const g = scanGeometry(j);
      if (!g) return null;
      cache.set(j, makeObstacleGeometry(g));
    }
    return cache.get(j)!;
  };
  const other: Jaw = jaw === 'upper' ? 'lower' : 'upper';
  const ant = get(other);
  return {
    antagonist: ant ? { ...ant, clearance: ctx.state.params.contacts.occlusal } : null,
    neighbours: get(jaw),
  };
}

/**
 * Adapt a die crown (world space) to the antagonist and the neighbouring
 * teeth. The crown's own die is ignored: closest points inside a cylinder
 * around the tooth axis (just wider than the margin) do not count.
 */
function adaptCrown(ctx: AppContext, r: DieCrownResult, cc: ContactContext): { occlusal: number; proximal: number; remaining: number } {
  const toLocal = r.frame.clone().invert();
  let marginR = 0;
  for (let i = 0; i < r.marginVertexCount; i++) {
    const q = new THREE.Vector3().fromArray(r.mesh.positions, i * 3).applyMatrix4(toLocal);
    marginR = Math.max(marginR, Math.hypot(q.x, q.y));
  }
  const ownDie = (p: THREE.Vector3) => {
    const q = p.clone().applyMatrix4(toLocal);
    return q.z > -3 && Math.hypot(q.x, q.y) < marginR + 0.4;
  };
  const weights = adaptWeights(r);
  const out = { occlusal: 0, proximal: 0, remaining: 0 };
  if (cc.antagonist) {
    const res = adaptToObstacles(r.mesh, weights, [cc.antagonist]);
    out.occlusal = res.maxCorrection;
    out.remaining = Math.max(out.remaining, res.remaining);
  }
  if (cc.neighbours) {
    const res = adaptToObstacles(r.mesh, weights, [{ ...cc.neighbours, clearance: ctx.state.params.contacts.proximal, ignore: ownDie }]);
    out.proximal = res.maxCorrection;
    out.remaining = Math.max(out.remaining, res.remaining);
  }
  return out;
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
  const jawScan = (jaw: Jaw) => {
    const scan = ctx.scanFor(jaw);
    if (!scan) return null;
    if (!scanCache.has(jaw)) scanCache.set(jaw, worldGeometry(scan.mesh));
    return scanCache.get(jaw)!;
  };
  const scanGeometry = (fdi: number) => jawScan(jawOf(fdi));
  const obstacleCache = new Map<string, ReturnType<typeof makeObstacleGeometry>>();
  const contacts = state.params.contacts;
  let dieCount = 0;
  let maxOcclusal = 0;
  let maxProximal = 0;
  contiguousRuns(teeth).forEach((span, run) => {
    issues.push(...validateSpan(span, state.roles), ...materialIssues(ctx, span));
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
          const basis = insertionBasis(ctx, fdi, placements.get(fdi)!.matrix);
          const r = buildDieCrown(scan, margin, basis, library?.has(fdi) ? outerSurface(fdi, scale) : shape, state.params.prep);
          if (r.blockedOut > 0.05) issues.push(`${name}: undercut up to ${r.blockedOut.toFixed(2)} mm blocked out`);
          if (contacts.adapt) {
            const a = adaptCrown(ctx, r, contactContext(ctx, jawOf(fdi), jawScan, obstacleCache));
            maxOcclusal = Math.max(maxOcclusal, a.occlusal);
            maxProximal = Math.max(maxProximal, a.proximal);
            if (a.occlusal > 0.6) issues.push(`${name}: occlusal surface reduced by ${a.occlusal.toFixed(2)} mm – check the thickness map / occlusal clearance of the prep`);
          }
          viewport.add(`${name} (die)`, r.mesh.toGeometry(), MATERIALS.tooth(), {
            category: 'design',
            module: MODULE,
            editable: false,
            data: { ...base, height: r.height, frame: r.frame, cavity: r.cavity, die: true, minThickness: r.minThickness, marginCount: r.marginVertexCount },
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
          const placement = placements.get(fdi)!.matrix;
          if (contacts.adapt && (jawScan('upper') || jawScan('lower'))) {
            // adapt in world space, then return to the tooth frame
            r.mesh.transform(placement);
            r.frame.premultiply(placement);
            const a = adaptCrown(ctx, r, contactContext(ctx, jawOf(fdi), jawScan, obstacleCache));
            maxOcclusal = Math.max(maxOcclusal, a.occlusal);
            maxProximal = Math.max(maxProximal, a.proximal);
            const back = placement.clone().invert();
            r.mesh.transform(back);
            r.frame.premultiply(back);
          }
          viewport.add(name, r.mesh.toGeometry(), MATERIALS.tooth(), {
            category: 'design',
            module: MODULE,
            matrix: placements.get(fdi)!.matrix,
            data: { ...base, height: r.height, frame: r.frame, cavity: r.cavity, marginCount: r.marginVertexCount },
          });
          return;
        } catch (e) {
          issues.push(`${name}: library crown failed (${(e as Error).message}) – used the procedural tooth`);
        }
      }
      const mb = role === 'crown' ? buildCrownShell(shape, state.params.prep) : mergeParts(solidParts(fdi, scale, 0));
      if (role === 'pontic' && contacts.adapt && jawScan(jawOf(fdi))) {
        // ovate pontic: limit how deep it presses into the ridge, keep antagonist / neighbour clearance
        const placement = placements.get(fdi)!.matrix;
        mb.transform(placement);
        const cc = contactContext(ctx, jawOf(fdi), jawScan, obstacleCache);
        const obstacles: Obstacle[] = [];
        if (cc.neighbours) obstacles.push({ ...cc.neighbours, clearance: -contacts.ponticPressure });
        if (cc.antagonist) obstacles.push(cc.antagonist);
        const res = adaptToObstacles(mb, new Float32Array(mb.vertexCount).fill(1), obstacles);
        if (res.maxCorrection > 0.01) issues.push(`${name}: adapted to the ridge / contacts by up to ${res.maxCorrection.toFixed(2)} mm`);
        mb.transform(placement.clone().invert());
      }
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
  const adapted = maxOcclusal > 0.01 || maxProximal > 0.01
    ? ` Contacts adapted (occlusal up to ${maxOcclusal.toFixed(2)} mm, proximal up to ${maxProximal.toFixed(2)} mm).`
    : '';
  const summary = `Designed ${teeth.length} unit(s)${dieCount ? `, ${dieCount} fitted to scanned dies` : ''}${library ? ' from the tooth library' : ''}.${adapted}`;
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

/** Apply a material preset to the crown & bridge parameters. */
export function applyMaterial(ctx: AppContext, id: string): void {
  const m = materialById(id);
  if (!m) return;
  const p = ctx.state.params;
  p.material = id;
  Object.assign(p.prep, m.prep);
  p.connector.area = m.connector.posterior;
  p.connector.areaAnterior = m.connector.anterior;
  ctx.state.info.material = m.label;
  ctx.status(`Material: ${m.label} – cement gap, thickness and connector values updated.`);
}

/** Insertion axis tools for the selected tooth (needs a margin on a scan). */
function axisBox(ctx: AppContext, fdi: number, rerender: () => void): HTMLElement {
  const margin = getMargin(ctx, fdi);
  const scanObj = ctx.scanFor(jawOf(fdi));
  if (!margin || !scanObj) return el('div', {});
  const { axis: occlusal } = toothAxis(ctx, fdi);
  const stored = ctx.state.axes[fdi];
  const axis = stored ? new THREE.Vector3(...stored) : occlusal;
  const scan = () => worldGeometry(scanObj.mesh);
  let info: AxisAnalysis | null = null;
  try {
    info = analyseAxis(scan(), margin, axis, occlusal);
  } catch {
    info = null;
  }
  const showing = ctx.viewport.list().some((o) => o.category === 'helper' && o.data.undercutOf === fdi);
  return el(
    'div',
    {},
    note(
      `Insertion axis: ${stored ? `custom, ${info ? info.tilt.toFixed(1) : '?'}° from occlusal` : 'occlusal direction'}` +
        (info ? ` · undercut ${info.undercut.toFixed(1)} mm²${info.undercut > 0.05 ? ' (blocked out in the intaglio)' : ''}` : ''),
      info && info.undercut > 0.5 ? 'warn' : 'info',
    ),
    el(
      'div',
      { class: 'actions' },
      button('Auto axis', () => {
        try {
          const r = estimateInsertionAxis(scan(), margin, occlusal);
          if (r.tilt < 0.5) delete ctx.state.axes[fdi];
          else ctx.state.axes[fdi] = r.axis.toArray() as [number, number, number];
          ctx.status(`Insertion axis ${label(ctx, fdi)}: ${r.tilt.toFixed(1)}° from occlusal, undercut ${r.undercut.toFixed(1)} mm². Generate to apply.`);
          if (showing) showUndercuts(ctx, fdi, true);
        } catch (e) {
          ctx.status(`Axis: ${(e as Error).message}`, 'warn');
        }
        rerender();
      }),
      button('Occlusal axis', () => {
        delete ctx.state.axes[fdi];
        if (showing) showUndercuts(ctx, fdi, true);
        rerender();
      }),
      button(showing ? 'Hide undercuts' : 'Show undercuts', () => {
        showUndercuts(ctx, fdi, !showing);
        rerender();
      }),
    ),
  );
}

function showUndercuts(ctx: AppContext, fdi: number, on: boolean): void {
  ctx.viewport.removeWhere((o) => o.category === 'helper' && o.data.undercutOf === fdi);
  if (!on) return;
  const margin = getMargin(ctx, fdi);
  const scanObj = ctx.scanFor(jawOf(fdi));
  if (!margin || !scanObj) return;
  const stored = ctx.state.axes[fdi];
  const axis = stored ? new THREE.Vector3(...stored) : toothAxis(ctx, fdi).axis;
  const overlay = undercutOverlay(worldGeometry(scanObj.mesh), margin, axis);
  const m = ctx.viewport.add(`Undercuts ${label(ctx, fdi)}`, overlay, new THREE.MeshBasicMaterial({ color: 0xff3355, side: THREE.DoubleSide }), {
    category: 'helper',
    editable: false,
    data: { undercutOf: fdi, marginOf: fdi, jaw: jawOf(fdi) },
  });
  m.mesh.renderOrder = 5;
}

function colorMapOn(o: SceneObject, on: boolean): void {
  const mat = o.mesh.material as THREE.MeshStandardMaterial;
  mat.vertexColors = on;
  mat.needsUpdate = true;
}

async function showThicknessMap(ctx: AppContext): Promise<void> {
  const units = moduleObjects(ctx).filter((o) => o.data.kind === 'unit' || o.data.kind === 'merged');
  if (!units.length) return ctx.status('Generate the design first.', 'warn');
  const p = ctx.state.params.prep;
  const min = Math.min(p.axialThickness, p.occlusalThickness);
  let thinnest = Infinity;
  for (const o of units) {
    const values = thicknessValues(o.mesh.geometry);
    // The wall ramps up from the margin thickness over the first 1.2 mm by
    // design: report the thinnest wall beyond that zone (all of it is still
    // coloured). Pontics are solid, not shells.
    if (o.data.role === 'crown') {
      const pos = o.mesh.geometry.getAttribute('position');
      const marginCount = (o.data.marginCount as number | undefined) ?? 0;
      const margin = Array.from({ length: marginCount }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i));
      const toLocal = unitFrame(o).invert();
      o.mesh.updateMatrixWorld(true);
      const q = new THREE.Vector3();
      values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        q.fromBufferAttribute(pos, i);
        if (margin.length) {
          if (margin.some((m) => m.distanceToSquared(q) < 1.3 * 1.3)) return;
        } else if (q.applyMatrix4(o.mesh.matrixWorld).applyMatrix4(toLocal).z < 1.5) return;
        thinnest = Math.min(thinnest, v);
      });
    }
    applyColorMap(o.mesh.geometry, values, thicknessStops(min));
    colorMapOn(o, true);
  }
  ctx.status(`Thickness map: thinnest wall ${Number.isFinite(thinnest) ? thinnest.toFixed(2) : '–'} mm (minimum ${min.toFixed(2)} mm).`, thinnest < min - 0.05 ? 'warn' : 'info');
}

async function showContactMap(ctx: AppContext): Promise<void> {
  const units = moduleObjects(ctx).filter((o) => o.data.kind === 'unit' || o.data.kind === 'merged');
  if (!units.length) return ctx.status('Generate the design first.', 'warn');
  const cache = new Map<string, ReturnType<typeof makeObstacleGeometry>>();
  const scanOf = (j: Jaw) => {
    const s = ctx.scanFor(j);
    return s ? worldGeometry(s.mesh) : null;
  };
  let closest = Infinity;
  let worstName = '';
  for (const o of units) {
    const fdi = (o.data.fdi as number | undefined) ?? undefined;
    const jaw = (o.data.jaw as Jaw | undefined) ?? (fdi ? jawOf(fdi) : 'lower');
    const cc = contactContext(ctx, jaw, scanOf, cache);
    const frame = o.data.kind === 'unit' ? unitFrame(o) : null;
    const toLocal = frame ? frame.clone().invert() : null;
    // ignore the unit's own die: closest points within its margin radius
    let marginR = 0;
    if (toLocal) {
      const pos = o.mesh.geometry.getAttribute('position');
      o.mesh.updateMatrixWorld(true);
      const q = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        q.fromBufferAttribute(pos, i).applyMatrix4(o.mesh.matrixWorld).applyMatrix4(toLocal);
        if (q.z < 0.3) marginR = Math.max(marginR, Math.hypot(q.x, q.y));
      }
    }
    const obstacles: Obstacle[] = [];
    if (cc.antagonist) obstacles.push({ ...cc.antagonist, clearance: 0 });
    if (cc.neighbours) {
      obstacles.push({
        ...cc.neighbours,
        clearance: 0,
        ignore: toLocal && o.data.role === 'crown' ? (pt) => {
          const q = pt.clone().applyMatrix4(toLocal);
          return q.z > -3 && Math.hypot(q.x, q.y) < marginR + 0.4;
        } : undefined,
      });
    }
    if (!obstacles.length) return ctx.status('Load scans (or the demo models) to see contacts.', 'warn');
    o.mesh.updateMatrixWorld(true);
    const values = contactValues(o.mesh.geometry, o.mesh.matrixWorld, obstacles);
    for (const v of values) {
      if (v < closest) {
        closest = v;
        worstName = o.name;
      }
    }
    applyColorMap(o.mesh.geometry, values, CONTACT_STOPS);
    colorMapOn(o, true);
  }
  ctx.status(
    Number.isFinite(closest)
      ? closest < 0
        ? `Contact map: deepest penetration ${(-closest).toFixed(2)} mm (${worstName}${ponticHint(worstName)}).`
        : `Contact map: closest contact ${closest.toFixed(2)} mm (${worstName}).`
      : 'Contact map: no contacts within 0.6 mm.',
    Number.isFinite(closest) && closest < -0.02 ? 'warn' : 'info',
  );
}

/** Explain what a pontic's penetration means. */
function ponticHint(name: string): string {
  return name.startsWith('Pontic') ? ' – pontic into the ridge; set "Pontic tissue contact"' : '';
}

function clearMaps(ctx: AppContext): void {
  for (const o of moduleObjects(ctx)) colorMapOn(o, false);
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
        axisBox(ctx, fdi, renderMargin),
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

    const build = () => {
      const material = materialById(p.material);
      const materialSelect = el('select', {});
      for (const m of MATERIAL_PRESETS) materialSelect.append(el('option', { value: m.id, selected: m.id === p.material }, m.label));
      materialSelect.addEventListener('change', () => {
        applyMaterial(ctx, materialSelect.value);
        build();
        regen();
      });
      root.replaceChildren(
        note('Mark retainers as "Crown" and missing teeth as "Pontic" on the chart. Adjacent units become a bridge. With a margin on a scanned prep, the crown is fitted to the die; without one it uses the parametric prep below.'),
        section(
          'Material',
          el('label', { class: 'field' }, el('span', {}, 'Material'), materialSelect),
          material ? note(`${material.note} Starting values only – check the material's instructions for use.`) : null,
        ),
        section('Margin line & insertion axis', marginBox),
        section(
          'Cement gap',
          numberField('Cement gap', p.prep, 'cementGap', { min: 0, max: 0.3, step: 0.01, unit: 'mm', onChange: regen }),
          numberField('Extra spacing', p.prep, 'extraSpacing', { min: 0, max: 0.2, step: 0.01, unit: 'mm', onChange: regen }),
          numberField('Distance to margin line', p.prep, 'marginSeal', { min: 0, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
          numberField('Gap transition', p.prep, 'gapTransition', { min: 0.05, max: 2, step: 0.05, unit: 'mm', onChange: regen }),
          checkboxField('Block out undercuts', p.prep, 'blockOut', regen),
          checkboxField('Fit crowns to scanned dies', p, 'fitToDie', regen),
          note('The gap is zero along the margin, starts at the distance to the margin line and reaches full size (cement gap + extra spacing) over the transition length. Undercuts of the die along the insertion axis are filled so the crown can seat.'),
        ),
        section(
          'Thickness',
          numberField('Margin thickness', p.prep, 'marginThickness', { min: 0.1, max: 1.5, step: 0.05, unit: 'mm', onChange: regen }),
          numberField('Min. axial thickness', p.prep, 'axialThickness', { min: 0.3, max: 2.5, step: 0.1, unit: 'mm', onChange: regen }),
          numberField('Min. occlusal thickness', p.prep, 'occlusalThickness', { min: 0.5, max: 3, step: 0.1, unit: 'mm', onChange: regen }),
          numberField('Prep convergence (parametric)', p.prep, 'taper', { min: 0, max: 30, step: 1, unit: '°', onChange: regen }),
        ),
        section(
          'Contacts',
          checkboxField('Adapt to antagonist & neighbours', p.contacts, 'adapt', regen),
          numberField('Occlusal clearance', p.contacts, 'occlusal', { min: -0.2, max: 1, step: 0.01, unit: 'mm', onChange: regen }),
          numberField('Proximal clearance', p.contacts, 'proximal', { min: -0.2, max: 0.5, step: 0.01, unit: 'mm', onChange: regen }),
          numberField('Pontic tissue contact', p.contacts, 'ponticPressure', { min: 0, max: 1.5, step: 0.05, unit: 'mm', onChange: regen }),
          note('Distance kept to the opposing scan and to the neighbouring teeth: 0 = touching, negative = tight contact. Crowns are reduced smoothly where they come closer; the margin and cervical wall never move. Pontics may press into the ridge by the tissue contact depth (ovate pontic).'),
          el(
            'div',
            { class: 'actions' },
            button('Thickness map', () => void showThicknessMap(ctx)),
            button('Contact map', () => void showContactMap(ctx)),
            button('Clear maps', () => clearMaps(ctx)),
          ),
          note('Thickness map: red = below the minimum, orange/yellow = within 0.3 mm of it, green/blue = thicker. Contact map: red = penetration, orange = touching (0–0.05 mm), yellow = up to 0.15 mm, green = up to 0.5 mm.'),
        ),
        section(
          'Anatomy & connectors',
          numberField('Anatomy scale', p, 'anatomyScale', { min: 0.7, max: 1.3, step: 0.01, onChange: regen }),
          numberField('Connector area – posterior', p.connector, 'area', { min: 4, max: 30, step: 0.5, unit: 'mm²', onChange: regen }),
          numberField('Connector area – anterior', p.connector, 'areaAnterior', { min: 4, max: 30, step: 0.5, unit: 'mm²', onChange: regen }),
          numberField('Connector height/width', p.connector, 'aspect', { min: 0.6, max: 2, step: 0.05, onChange: regen }),
          numberField('Connector position', p.connector, 'heightRatio', { min: 0.2, max: 0.9, step: 0.05, onChange: regen }),
          note('Anterior = canine to canine. Spans with two adjacent pontics automatically use the material\'s long-span minimum.'),
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
    };
    build();
    return root;
  },
  onTransform(ctx, object: SceneObject) {
    if (object.data.kind === 'unit') {
      const run = object.data.run as number;
      if (isBridge(ctx, run)) rebuildConnectors(ctx, run);
    }
  },
};
