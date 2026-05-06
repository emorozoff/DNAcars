import { describe, expect, it } from 'vitest';
import { makeRng } from '../../sim/prng';
import { rankByFitness, tournamentSelect } from '../selection';

describe('selection', () => {
  it('rankByFitness sorts descending by fitness', () => {
    const ranked = rankByFitness([
      { individual: 'a', fitness: 1 },
      { individual: 'b', fitness: 5 },
      { individual: 'c', fitness: 3 },
    ]);
    expect(ranked.map((r) => r.individual)).toEqual(['b', 'c', 'a']);
  });

  it('tournament selection prefers higher fitness as k grows', () => {
    const pop = Array.from({ length: 100 }, (_, i) => ({ individual: i, fitness: i }));
    const rng = makeRng('t');
    const winnersK1: number[] = [];
    const winnersK10: number[] = [];
    for (let i = 0; i < 1000; i++) {
      winnersK1.push(tournamentSelect(pop, 1, rng));
      winnersK10.push(tournamentSelect(pop, 10, rng));
    }
    const meanK1 = winnersK1.reduce((a, b) => a + b, 0) / winnersK1.length;
    const meanK10 = winnersK10.reduce((a, b) => a + b, 0) / winnersK10.length;
    // k=1 → uniform mean ~49.5; k=10 → strong bias toward high indices
    expect(meanK10).toBeGreaterThan(meanK1 + 20);
  });

  it('throws on empty population', () => {
    expect(() => tournamentSelect([], 3, makeRng('e'))).toThrow();
  });
});
