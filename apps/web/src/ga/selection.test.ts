import { describe, expect, it } from 'vitest';
import { makeRng } from '../sim/world';
import { rouletteSelect, topNIndices } from './selection';

describe('rouletteSelect', () => {
  it('throws on an empty pool', () => {
    expect(() => rouletteSelect([], [], makeRng(1))).toThrow();
  });

  it('always returns the only item in a single-item pool', () => {
    const rng = makeRng(42);
    for (let i = 0; i < 20; i++) {
      expect(rouletteSelect(['x'], [5], rng)).toBe('x');
    }
  });

  it('falls back to uniform when every weight is zero', () => {
    const rng = makeRng(7);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(rouletteSelect(['a', 'b', 'c'], [0, 0, 0], rng));
    }
    // With a uniform fallback all three items must appear.
    expect(seen).toEqual(new Set(['a', 'b', 'c']));
  });

  it('picks proportionally to weight', () => {
    const rng = makeRng(123);
    const counts = [0, 0];
    for (let i = 0; i < 2000; i++) {
      const pick = rouletteSelect([0, 1], [1, 99], rng);
      counts[pick] = (counts[pick] ?? 0) + 1;
    }
    // The 99×-heavier item must dominate by a wide margin.
    expect(counts[1]).toBeGreaterThan(counts[0]! * 10);
  });

  it('treats negative weights as zero', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 100; i++) {
      // Item 0 has a negative weight; only item 1 is selectable.
      expect(rouletteSelect(['neg', 'pos'], [-10, 4], rng)).toBe('pos');
    }
  });
});

describe('topNIndices', () => {
  it('returns the indices of the top n scores, best first', () => {
    expect(topNIndices([3, 9, 1, 7], 2)).toEqual([1, 3]);
  });

  it('clamps n to the array length', () => {
    expect(topNIndices([5, 2], 10)).toEqual([0, 1]);
  });

  it('returns an empty array for n = 0', () => {
    expect(topNIndices([5, 2, 8], 0)).toEqual([]);
  });

  it('handles an empty score array', () => {
    expect(topNIndices([], 3)).toEqual([]);
  });
});
