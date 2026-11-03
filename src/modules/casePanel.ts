import * as THREE from 'three';
import type { AppContext, DesignModule } from './types';
import { MATERIALS } from '../viewer/Viewport';
import { archOrder, type Jaw } from '../core/teeth';
import { mergeParts, prepareTeeth, solidParts } from '../library/provider';
import { archCurve, archFromPicks } from '../core/arch';
import { teethWithRole } from '../core/case';
import { buildDemoModel } from '../geometry/denture';
import { loadMeshFile, pickFile } from '../io/files';
import { button, el, note, section, selectField, textField } from '../ui/dom';

function addScan(ctx: AppContext, jaw: Jaw, name: string, geometry: THREE.BufferGeometry): void {
  ctx.viewport.removeWhere((o) => o.category === 'scan' && o.data.jaw === jaw);
  ctx.viewport.add(name, geometry, MATERIALS.scan(), { category: 'scan', editable: false, data: { jaw } });
}

export async function loadDemoModels(ctx: AppContext): Promise<void> {
  const s = ctx.state;
  await prepareTeeth([...archOrder('upper'), ...archOrder('lower')]);
  for (const jaw of ['upper', 'lower'] as Jaw[]) {
    const model = buildDemoModel(ctx.arch(jaw), {
      preps: teethWithRole(s, 'crown'),
      missing: teethWithRole(s, 'pontic', 'missing'),
      prep: s.params.prep,
      solid: (fdi, scale, depth) => mergeParts(solidParts(fdi, scale, depth)),
    });
    addScan(ctx, jaw, `Demo model (${jaw})`, model.toGeometry());
  }
  ctx.viewport.view('front');
  ctx.status('Demo models generated from the tooth chart (crowns → preps, pontics → missing).');
}

function showArch(ctx: AppContext, jaw: Jaw): void {
  ctx.viewport.removeWhere((o) => o.category === 'helper' && o.data.arch === jaw);
  const arch = ctx.arch(jaw);
  const curve = archCurve(arch);
  const pts = curve.getSpacedPoints(80).map((p) => p.setZ(arch.marginZ));
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.25, 6, false);
  ctx.viewport.add(`Arch (${jaw})`, tube, MATERIALS.helper(), { category: 'helper', editable: false, data: { arch: jaw } });
}

function libraryBox(ctx: AppContext): HTMLElement {
  const lib = ctx.library();
  if (!lib) {
    return section('Tooth library', note('No scanned tooth library found (public/library/teeth). Using procedural teeth. Build one with "npm run build:library -- <folder of STLs>".', 'warn'));
  }
  const p = ctx.state.params;
  return section(
    'Tooth library',
    selectField('Tooth shapes', p, 'toothLibrary', [['scanned', `Scanned library (${lib.manifest.teeth.length} teeth)`], ['procedural', 'Procedural (parametric)']], () => {
      ctx.setToothLibrary(p.toothLibrary);
      ctx.status(`Using ${p.toothLibrary === 'scanned' ? 'the scanned tooth library' : 'procedural teeth'}. Reload the demo models and press Generate to update designs.`);
    }),
    ...lib.manifest.notes.map((n) => note(n)),
  );
}

export const casePanel: DesignModule = {
  id: 'case',
  title: 'Case',
  render(ctx) {
    const info = ctx.state.info;
    const pick = { jaw: 'lower' as Jaw };
    const picks: THREE.Vector3[] = [];
    const pickStatus = el('div', {});

    const stopPicking = () => {
      ctx.viewport.pickHandler = null;
      ctx.viewport.removeWhere((o) => o.category === 'helper' && o.data.pick === true);
      picks.length = 0;
    };

    const startPicking = () => {
      stopPicking();
      pickStatus.replaceChildren(note('Click cusp tips / incisal edges along the arch, from one distal end to the other (5–9 points), then press "Finish arch".'));
      ctx.viewport.pickHandler = (point) => {
        picks.push(point.clone());
        const dot = new THREE.SphereGeometry(0.6, 12, 8);
        dot.translate(point.x, point.y, point.z);
        ctx.viewport.add(`Arch point ${picks.length}`, dot, MATERIALS.helper(), { category: 'helper', editable: false, data: { pick: true } });
        ctx.status(`${picks.length} arch point(s) picked.`);
      };
    };

    const finishPicking = () => {
      if (picks.length < 3) {
        ctx.status('Pick at least 3 points along the arch.', 'warn');
        return;
      }
      ctx.state.arches[pick.jaw] = archFromPicks(pick.jaw, picks, pick.jaw === 'upper' ? -1 : 1);
      stopPicking();
      pickStatus.replaceChildren();
      showArch(ctx, pick.jaw);
      ctx.status(`Arch fitted to the ${pick.jaw} scan. Regenerate designs to use it.`);
    };

    const importScan = async (jaw: Jaw) => {
      const file = await pickFile('.stl,.ply,.obj');
      if (!file) return;
      try {
        ctx.status(`Loading ${file.name}…`);
        addScan(ctx, jaw, `${file.name} (${jaw})`, await loadMeshFile(file));
        ctx.viewport.view('fit');
        ctx.status(`Loaded ${file.name} as the ${jaw} scan. Fit the arch to it below.`);
      } catch (e) {
        ctx.status(`Could not load ${file.name}: ${(e as Error).message}`, 'error');
      }
    };

    const toggleScanEditing = () => {
      const scans = ctx.viewport.list().filter((o) => o.category === 'scan');
      const editable = !scans.some((o) => o.editable);
      scans.forEach((o) => (o.editable = editable));
      ctx.status(editable ? 'Scans can now be selected and moved / rotated to align the occlusal plane with the grid.' : 'Scans locked.');
    };

    return el(
      'div',
      {},
      section(
        'Case',
        textField('Case ID', info, 'caseId'),
        textField('Patient', info, 'patient'),
        textField('Dentist', info, 'dentist'),
        textField('Due date', info, 'dueDate'),
        textField('Shade', info, 'shade'),
        textField('Material', info, 'material'),
        textField('Notes', info, 'notes', true),
      ),
      libraryBox(ctx),
      section(
        'Scans',
        el(
          'div',
          { class: 'actions' },
          button('Import upper', () => importScan('upper')),
          button('Import lower', () => importScan('lower')),
          button('Demo models', () => void loadDemoModels(ctx), 'primary'),
          button('Unlock / lock scans', toggleScanEditing),
        ),
        note('STL, PLY or OBJ in millimetres. Align the occlusal plane with the grid (Z up, incisors toward +Y) so the arch tools and the nightguard work as expected.'),
      ),
      section(
        'Arch',
        selectField('Jaw', pick, 'jaw', [['lower', 'Lower'], ['upper', 'Upper']]),
        el(
          'div',
          { class: 'actions' },
          button('Pick arch points', startPicking),
          button('Finish arch', finishPicking, 'primary'),
          button('Default arch', () => {
            stopPicking();
            delete ctx.state.arches[pick.jaw];
            showArch(ctx, pick.jaw);
            ctx.status(`Using the default ${pick.jaw} arch form.`);
          }),
          button('Show arches', () => (['upper', 'lower'] as Jaw[]).forEach((j) => showArch(ctx, j))),
        ),
        pickStatus,
      ),
    );
  },
};
