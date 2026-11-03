import { describe, expect, it } from 'vitest';
import { fdiToUniversal, universalToFdi, getTooth, contiguousRuns, areAdjacent, archOrder } from '../src/core/teeth';

describe('tooth numbering', () => {
  it('maps FDI to Universal', () => {
    expect(fdiToUniversal(18)).toBe(1);
    expect(fdiToUniversal(11)).toBe(8);
    expect(fdiToUniversal(21)).toBe(9);
    expect(fdiToUniversal(28)).toBe(16);
    expect(fdiToUniversal(38)).toBe(17);
    expect(fdiToUniversal(31)).toBe(24);
    expect(fdiToUniversal(41)).toBe(25);
    expect(fdiToUniversal(48)).toBe(32);
  });

  it('round-trips all 32 teeth', () => {
    for (let u = 1; u <= 32; u++) expect(fdiToUniversal(universalToFdi(u))).toBe(u);
  });

  it('describes a tooth', () => {
    const t = getTooth(36);
    expect(t.jaw).toBe('lower');
    expect(t.side).toBe('left');
    expect(t.kind).toBe('molar');
    expect(t.universal).toBe(19);
  });

  it('rejects invalid numbers', () => {
    expect(() => getTooth(19)).toThrow();
    expect(() => getTooth(51)).toThrow();
  });
});

describe('arch helpers', () => {
  it('orders the arch from right to left', () => {
    expect(archOrder('upper').slice(6, 10)).toEqual([12, 11, 21, 22]);
    expect(archOrder('lower').slice(6, 10)).toEqual([42, 41, 31, 32]);
  });

  it('detects adjacency across the midline', () => {
    expect(areAdjacent(11, 21)).toBe(true);
    expect(areAdjacent(14, 15)).toBe(true);
    expect(areAdjacent(14, 16)).toBe(false);
    expect(areAdjacent(11, 41)).toBe(false);
  });

  it('groups contiguous runs (bridge spans)', () => {
    expect(contiguousRuns([14, 15, 16, 21, 36, 37])).toEqual([[16, 15, 14], [21], [36, 37]]);
  });
});

describe('numbering systems', () => {
  it('labels the same teeth in every system', async () => {
    const { toothLabel } = await import('../src/core/teeth');
    const cases: [number, Record<string, string>][] = [
      [11, { fdi: '11', universal: '8', palmer: '1┘', haderup: '1+', alphanumeric: 'UR1' }],
      [21, { fdi: '21', universal: '9', palmer: '└1', haderup: '+1', alphanumeric: 'UL1' }],
      [36, { fdi: '36', universal: '19', palmer: '┌6', haderup: '−6', alphanumeric: 'LL6' }],
      [48, { fdi: '48', universal: '32', palmer: '8┐', haderup: '8−', alphanumeric: 'LR8' }],
    ];
    for (const [fdi, labels] of cases) {
      for (const [system, expected] of Object.entries(labels)) {
        expect(toothLabel(fdi, system as 'fdi')).toBe(expected);
      }
    }
  });

  it('gives 32 distinct labels per system', async () => {
    const { toothLabel, archOrder, NUMBERING_LABELS } = await import('../src/core/teeth');
    const all = [...archOrder('upper'), ...archOrder('lower')];
    for (const system of Object.keys(NUMBERING_LABELS)) {
      expect(new Set(all.map((f) => toothLabel(f, system as 'fdi'))).size).toBe(32);
    }
  });
});
