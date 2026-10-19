import './styles.css';
import * as THREE from 'three';
import { Viewport, type SceneObject } from './viewer/Viewport';
import { defaultArch } from './core/arch';
import { ToothLibrary } from './library/toothLibrary';
import { setActiveLibrary } from './library/provider';
import { newCase, serializeCase, deserializeCase, type CaseState } from './core/case';
import type { Jaw } from './core/teeth';
import { checkMesh } from './geometry/MeshBuilder';
import { download, exportStl, pickFile } from './io/files';
import { el, button } from './ui/dom';
import { toothChart } from './ui/toothChart';
import { sceneList } from './ui/sceneList';
import type { AppContext, DesignModule } from './modules/types';
import { casePanel, loadDemoModels } from './modules/casePanel';
import { crownBridgeModule } from './modules/crownBridge';
import { dentureModule } from './modules/denture';
import { nightguardModule } from './modules/nightguard';
import { waxupModule } from './modules/waxup';

const MODULES: DesignModule[] = [casePanel, crownBridgeModule, dentureModule, nightguardModule, waxupModule];

class App {
  private state: CaseState = newCase();
  private readonly viewport: Viewport;
  private readonly ctx: AppContext;
  private activeTab = 'case';
  private readonly chartHost = el('div', {});
  private readonly tabsHost = el('nav', { class: 'tabs' });
  private readonly panelHost = el('div', { class: 'panel' });
  private readonly statusBar = el('footer', { class: 'status' }, 'Ready.');
  private readonly selectionInfo = el('div', { class: 'selection-info' });

  constructor(root: HTMLElement) {
    const viewportHost = el('div', { class: 'viewport' });
    const header = this.buildHeader();
    root.append(
      header,
      el(
        'main',
        {},
        el('aside', { class: 'sidebar' }, this.chartHost, this.tabsHost, this.panelHost),
        el('div', { class: 'stage' }, viewportHost, this.buildViewBar(), this.selectionInfo),
        el('aside', { class: 'objects' }),
      ),
      this.statusBar,
    );
    this.viewport = new Viewport(viewportHost);
    root.querySelector('aside.objects')!.append(sceneList(this.viewport));

    const self = this;
    this.ctx = {
      viewport: this.viewport,
      get state() {
        return self.state;
      },
      arch: (jaw: Jaw) => this.state.arches[jaw] ?? defaultArch(jaw),
      scanFor: (jaw: Jaw) => this.viewport.list().find((o) => o.category === 'scan' && o.data.jaw === jaw),
      status: (msg, kind = 'info') => this.status(msg, kind),
      exportObjects: (objs, name) => this.exportObjects(objs, name),
      library: () => this.library,
      setToothLibrary: (mode) => {
        this.state.params.toothLibrary = mode;
        this.applyLibrary();
      },
      exportGeometries: (geoms, name) => {
        download(exportStl(geoms.map((g) => new THREE.Mesh(g))), `${this.state.info.caseId}_${name}.stl`);
        this.status(`Exported ${name}.stl`);
      },
    };

    this.viewport.onTransform((o) => MODULES.find((m) => m.id === o.module)?.onTransform?.(this.ctx, o));
    this.viewport.onSelect((o) => this.renderSelection(o));
    this.bindKeys();
    this.renderAll();
    void this.start();
  }

  private library: ToothLibrary | null = null;

  /** Activate the scanned library when it is loaded and the case asks for it (never changes the case's choice). */
  private applyLibrary(): void {
    setActiveLibrary(this.library && this.state.params.toothLibrary === 'scanned' ? this.library : null);
  }

  /** Load the scanned tooth library (if present), then build the demo models. */
  private async start(): Promise<void> {
    this.status('Loading tooth library…');
    try {
      this.library = await ToothLibrary.load(async (path) => {
        const res = await fetch(`${import.meta.env.BASE_URL}library/teeth/${path}`);
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return res.arrayBuffer();
      });
    } catch {
      this.library = null;
    }
    this.applyLibrary();
    this.renderTabs();
    await loadDemoModels(this.ctx);
  }

  private buildHeader(): HTMLElement {
    return el(
      'header',
      {},
      el('div', { class: 'brand' }, el('strong', {}, 'Dental CAD'), el('span', {}, 'open-source restoration design')),
      el(
        'div',
        { class: 'toolbar' },
        button('New case', () => {
          if (!confirm('Discard the current case and all designs?')) return;
          this.viewport.removeWhere(() => true);
          this.state = newCase();
          this.renderAll();
        }),
        button('Open case…', () => this.openCase()),
        button('Save case', () => download(new Blob([serializeCase(this.state)], { type: 'application/json' }), `${this.state.info.caseId}.json`)),
        button('Export all designs', () =>
          this.exportObjects(this.viewport.list().filter((o) => o.category === 'design' && o.mesh.visible), 'designs'),
        ),
        button('Screenshot', () => {
          this.viewport.renderer.domElement.toBlob((b) => b && download(b, `${this.state.info.caseId}.png`));
        }),
      ),
    );
  }

  private buildViewBar(): HTMLElement {
    const axis = el('select', {}, el('option', { value: 'y' }, 'Section ⟂ Y'), el('option', { value: 'x' }, 'Section ⟂ X'));
    const enabled = el('input', { type: 'checkbox', title: 'Enable section view' });
    const offset = el('input', { type: 'range', min: -40, max: 40, step: 0.2, value: 0 });
    const update = () => this.viewport.setSection(enabled.checked, axis.value as 'x' | 'y', Number(offset.value));
    [axis, enabled, offset].forEach((i) => i.addEventListener('input', update));
    return el(
      'div',
      { class: 'viewbar' },
      button('Front', () => this.viewport.view('front')),
      button('Upper occlusal', () => this.viewport.view('occlusal-upper')),
      button('Lower occlusal', () => this.viewport.view('occlusal-lower')),
      button('Left', () => this.viewport.view('left')),
      button('Right', () => this.viewport.view('right')),
      button('Fit', () => this.viewport.view('fit')),
      el('label', { class: 'section-ctl' }, enabled, axis, offset),
    );
  }

  private renderAll(): void {
    // a new or opened case may choose a different tooth library
    this.applyLibrary();
    this.chartHost.replaceChildren(toothChart(this.state, () => {}));
    this.renderTabs();
  }

  private renderTabs(): void {
    this.tabsHost.replaceChildren(
      ...MODULES.map((m) =>
        el(
          'button',
          {
            type: 'button',
            class: m.id === this.activeTab ? 'active' : '',
            onclick: () => {
              // leave any pick mode (margin drawing, arch picking) of the previous tab
              this.viewport.pickHandler = null;
              this.viewport.pickFilter = null;
              this.activeTab = m.id;
              this.renderTabs();
            },
          },
          m.title,
        ),
      ),
    );
    const module = MODULES.find((m) => m.id === this.activeTab)!;
    this.panelHost.replaceChildren(module.render(this.ctx));
    // margin lines are only shown while working in Crown & Bridge
    for (const o of this.viewport.list()) {
      if (o.category === 'helper' && o.data.marginOf !== undefined) o.mesh.visible = this.activeTab === 'crown-bridge';
    }
  }

  private renderSelection(o: SceneObject | null): void {
    if (!o) {
      this.selectionInfo.replaceChildren();
      return;
    }
    const check = checkMesh(o.mesh.geometry);
    const s = o.mesh.scale;
    this.selectionInfo.replaceChildren(
      el('strong', {}, o.name),
      el('span', {}, `${check.triangles.toLocaleString()} triangles · ${(check.volume * s.x * s.y * s.z).toFixed(1)} mm³`),
      el('span', { class: check.watertight ? 'ok' : 'bad' }, check.watertight ? 'Watertight' : `Open edges: ${check.boundaryEdges}`),
      el('span', { class: 'hint' }, 'W move · E rotate · R scale · Del delete · Esc deselect'),
    );
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const g = this.viewport.gizmo;
      switch (e.key.toLowerCase()) {
        case 'w': g.setMode('translate'); break;
        case 'e': g.setMode('rotate'); break;
        case 'r': g.setMode('scale'); break;
        case 'f': this.viewport.view('fit'); break;
        case 'escape': this.viewport.select(null); this.viewport.pickHandler = null; break;
        case 'delete':
        case 'backspace': {
          const sel = this.viewport.selected;
          if (sel) this.viewport.remove(sel.id);
          break;
        }
      }
    });
  }

  private async openCase(): Promise<void> {
    const file = await pickFile('.json');
    if (!file) return;
    try {
      this.state = deserializeCase(await file.text());
      this.viewport.removeWhere((o) => o.category !== 'scan');
      this.renderAll();
      this.status(`Opened ${this.state.info.caseId}. Re-import scans and press Generate in each module.`);
    } catch (e) {
      this.status(`Could not open case: ${(e as Error).message}`, 'error');
    }
  }

  private exportObjects(objects: SceneObject[], name: string): void {
    if (!objects.length) {
      this.status('Nothing to export – generate a design first.', 'warn');
      return;
    }
    download(exportStl(objects.map((o) => o.mesh)), `${this.state.info.caseId}_${name}.stl`);
    this.status(`Exported ${objects.length} object(s) to ${name}.stl`);
  }

  private status(msg: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.statusBar.textContent = msg;
    this.statusBar.className = `status ${kind}`;
  }
}

new App(document.getElementById('app')!);
