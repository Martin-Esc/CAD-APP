import * as THREE from 'three';
import type { Jaw } from './teeth';
import type { ArchDefinition } from './arch';
import { DEFAULT_PREP, type PrepParams } from '../geometry/toothShape';
import { DEFAULT_CONNECTOR, type ConnectorParams } from '../geometry/connector';
import { DEFAULT_DENTURE, type DentureParams } from '../geometry/denture';
import { DEFAULT_NIGHTGUARD, type NightguardParams } from '../geometry/nightguard';

/** What is planned for a tooth position. */
export type UnitRole = 'crown' | 'pontic' | 'waxup' | 'missing';

export const ROLE_LABELS: Record<UnitRole, string> = {
  crown: 'Crown / retainer',
  pontic: 'Pontic',
  waxup: 'Wax-up',
  missing: 'Missing',
};

export interface CaseInfo {
  caseId: string;
  patient: string;
  dentist: string;
  dueDate: string;
  shade: string;
  material: string;
  notes: string;
}

export interface CaseState {
  info: CaseInfo;
  numbering: 'fdi' | 'universal';
  roles: Record<number, UnitRole>;
  /** arches fitted to scans (falls back to the default arch form) */
  arches: Partial<Record<Jaw, ArchDefinition>>;
  /** margin lines on scanned preps, world coordinates, per FDI tooth */
  margins: Record<number, [number, number, number][]>;
  params: {
    /** build crowns on the scanned die when a margin line exists */
    fitToDie: boolean;
    prep: PrepParams;
    connector: ConnectorParams;
    anatomyScale: number;
    denture: DentureParams & { jaw: Jaw | 'both' };
    nightguard: NightguardParams & { jaw: Jaw };
    waxupScale: number;
  };
}

export function newCase(): CaseState {
  return {
    info: {
      caseId: `CASE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-001`,
      patient: '',
      dentist: '',
      dueDate: '',
      shade: 'A2',
      material: 'Zirconia',
      notes: '',
    },
    numbering: 'fdi',
    roles: {},
    arches: {},
    margins: {},
    params: {
      fitToDie: true,
      prep: { ...DEFAULT_PREP },
      connector: { ...DEFAULT_CONNECTOR },
      anatomyScale: 1,
      denture: { ...DEFAULT_DENTURE, jaw: 'both' },
      nightguard: { ...DEFAULT_NIGHTGUARD, jaw: 'upper' },
      waxupScale: 1,
    },
  };
}

export function teethWithRole(state: CaseState, ...roles: UnitRole[]): number[] {
  return Object.entries(state.roles)
    .filter(([, r]) => roles.includes(r))
    .map(([fdi]) => Number(fdi));
}

interface SerializedArch {
  jaw: Jaw;
  points: [number, number, number][];
  marginZ: number;
  occlusalDir: 1 | -1;
}

export function serializeCase(state: CaseState): string {
  const arches: Partial<Record<Jaw, SerializedArch>> = {};
  for (const [jaw, a] of Object.entries(state.arches) as [Jaw, ArchDefinition][]) {
    arches[jaw] = { ...a, points: a.points.map((p) => p.toArray() as [number, number, number]) };
  }
  return JSON.stringify({ format: 'dental-cad-case', version: 1, ...state, arches }, null, 2);
}

export function deserializeCase(json: string): CaseState {
  const raw = JSON.parse(json);
  if (raw.format !== 'dental-cad-case') throw new Error('Not a dental CAD case file');
  const base = newCase();
  const arches: Partial<Record<Jaw, ArchDefinition>> = {};
  for (const [jaw, a] of Object.entries(raw.arches ?? {}) as [Jaw, SerializedArch][]) {
    arches[jaw] = { ...a, points: a.points.map((p) => new THREE.Vector3(...p)) };
  }
  return {
    info: { ...base.info, ...raw.info },
    numbering: raw.numbering ?? base.numbering,
    // drop roles from older versions (e.g. 'abutment') that this build doesn't support
    roles: Object.fromEntries(Object.entries(raw.roles ?? {}).filter(([, r]) => (r as string) in ROLE_LABELS)) as Record<number, UnitRole>,
    arches,
    margins: raw.margins ?? {},
    params: {
      fitToDie: raw.params?.fitToDie ?? true,
      prep: { ...base.params.prep, ...raw.params?.prep },
      connector: { ...base.params.connector, ...raw.params?.connector },
      anatomyScale: raw.params?.anatomyScale ?? 1,
      denture: { ...base.params.denture, ...raw.params?.denture },
      nightguard: { ...base.params.nightguard, ...raw.params?.nightguard },
      waxupScale: raw.params?.waxupScale ?? 1,
    },
  };
}
