import type { PrepParams } from '../geometry/toothShape';

/**
 * Restoration material presets: starting values for the crown & bridge
 * parameters, taken from published manufacturer guidance. They are starting
 * points only: always check the instructions for use of the exact material.
 *
 * Connector areas are minimum cross-sections (mm²) for anterior and posterior
 * connectors of short spans (one pontic). Spans with two or more adjacent
 * pontics use the long-span values.
 */
export interface MaterialPreset {
  id: string;
  label: string;
  prep: Partial<PrepParams>;
  connector: {
    anterior: number;
    posterior: number;
    anteriorLong: number;
    posteriorLong: number;
  };
  /** whether bridges are indicated at all */
  bridges: 'yes' | 'anterior-premolar' | 'no';
  note: string;
}

export const MATERIALS: MaterialPreset[] = [
  {
    id: 'zirconia',
    label: 'Zirconia (monolithic)',
    prep: { cementGap: 0.06, marginSeal: 0.8, extraSpacing: 0.02, marginThickness: 0.4, axialThickness: 0.8, occlusalThickness: 1.0 },
    // Ivoclar zirconia IFU: 3-unit bridge 9 mm² anterior / 12 mm² posterior; larger spans more
    connector: { anterior: 9, posterior: 12, anteriorLong: 12, posteriorLong: 16 },
    bridges: 'yes',
    note: 'Connector minimums from zirconia IFUs (e.g. Ivoclar: 9 mm² anterior / 12 mm² posterior for 3-unit bridges).',
  },
  {
    id: 'lithium-disilicate',
    label: 'Lithium disilicate (e.g. e.max CAD)',
    prep: { cementGap: 0.08, marginSeal: 0.8, extraSpacing: 0.02, marginThickness: 0.6, axialThickness: 1.2, occlusalThickness: 1.5 },
    // Ivoclar exocad chart (IPS e.max CAD): 2-crown spans 7 / 9 mm², longer spans 12 / 16 mm²
    connector: { anterior: 12, posterior: 16, anteriorLong: 16, posteriorLong: 20 },
    bridges: 'anterior-premolar',
    note: 'Bridges only up to the second premolar as the distal retainer. Check the IFU for connector sizes per span.',
  },
  {
    id: 'pmma',
    label: 'PMMA (provisional)',
    prep: { cementGap: 0.1, marginSeal: 0.6, extraSpacing: 0, marginThickness: 0.5, axialThickness: 1.0, occlusalThickness: 1.5 },
    connector: { anterior: 12, posterior: 16, anteriorLong: 16, posteriorLong: 20 },
    bridges: 'yes',
    note: 'Provisional material: generous connectors and wall thickness.',
  },
  {
    id: 'printed-resin',
    label: 'Printed permanent resin',
    // SprintRay crown design guidelines (exocad settings): gap 0.12, extra 0.02, margin distance 0.2, min. 1.0 mm
    prep: { cementGap: 0.12, marginSeal: 0.2, extraSpacing: 0.02, marginThickness: 0.12, axialThickness: 1.0, occlusalThickness: 1.0 },
    connector: { anterior: 12, posterior: 16, anteriorLong: 16, posteriorLong: 20 },
    bridges: 'no',
    note: 'Values from a printed-resin manufacturer guideline (gap 0.12 mm, extra 0.02 mm, 1.0 mm minimum). Single crowns only for most resins.',
  },
];

export function materialById(id: string | undefined): MaterialPreset | undefined {
  return MATERIALS.find((m) => m.id === id);
}

/** Anterior connectors join teeth from canine to canine. */
export function isAnteriorConnector(fdiA: number, fdiB: number): boolean {
  return fdiA % 10 <= 3 && fdiB % 10 <= 3;
}

/** Minimum connector area for a connector between two units of a span. */
export function minimumConnectorArea(material: MaterialPreset, fdiA: number, fdiB: number, longSpan: boolean): number {
  const c = material.connector;
  if (isAnteriorConnector(fdiA, fdiB)) return longSpan ? c.anteriorLong : c.anterior;
  return longSpan ? c.posteriorLong : c.posterior;
}
