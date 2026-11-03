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
