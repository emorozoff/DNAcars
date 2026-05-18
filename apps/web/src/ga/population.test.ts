import { describe, expect, it } from 'vitest';
import { makeRng, randomGenome, type Genome } from '../sim/world';
import { nextGeneration, type GAParams, type Scored } from './population';

function makeScored(count: number, seed: number): Scored[] {
  const rng = makeRng(seed);
  const out: Scored[] = [];
  for (let i = 0; i < count; i++) {
    const genome = randomGenome(rng);
    // Distinct, strictly increasing fitness so the elite ranking is
    // unambiguous: the last entry is always the fittest.
    out.push({ genome, fitness: (i + 1) * 10, travel: (i + 1) * 10, finishTime: null });
  }
  return out;
}

const PARAMS: GAParams = {
  populationSize: 24,
  eliteCount: 3,
  mutationRate: 0.15,
  selectionPressure: 1,
};

describe('nextGeneration', () => {
  it('returns an empty array for an empty population', () => {
    expect(nextGeneration([], PARAMS, makeRng(1))).toEqual([]);
  });

  it('produces exactly populationSize genomes', () => {
    const next = nextGeneration(makeScored(24, 1), PARAMS, makeRng(99));
    expect(next).toHaveLength(PARAMS.populationSize);
  });

  it('carries the fittest genomes through as elites', () => {
    const prev = makeScored(24, 2);
    const next = nextGeneration(prev, PARAMS, makeRng(99));
    // makeScored gives index 23 the highest fitness, 22 next, etc.
    expect(next[0]).toEqual(prev[23]!.genome);
    expect(next[1]).toEqual(prev[22]!.genome);
    expect(next[2]).toEqual(prev[21]!.genome);
  });

  it('deep-clones elites so later mutations cannot smear them', () => {
    const prev = makeScored(24, 3);
    const next = nextGeneration(prev, PARAMS, makeRng(99));
    const elite = next[0]!;
    const source = prev[23]!.genome;
    expect(elite).toEqual(source);
    // A clone, not a shared reference.
    expect(elite).not.toBe(source);
    expect(elite.chassisRadii).not.toBe(source.chassisRadii);
    elite.chassisRadii[0] = -999;
    expect(source.chassisRadii[0]).not.toBe(-999);
  });

  it('is deterministic for a fixed (population, params, seed)', () => {
    const prev = makeScored(24, 4);
    const a = nextGeneration(prev, PARAMS, makeRng(777));
    const b = nextGeneration(prev, PARAMS, makeRng(777));
    expect(a).toEqual(b);
  });

  it('still produces a full valid population under high selection pressure', () => {
    const prev = makeScored(24, 5);
    const next = nextGeneration(prev, { ...PARAMS, selectionPressure: 5 }, makeRng(1));
    expect(next).toHaveLength(PARAMS.populationSize);
    for (const g of next as Genome[]) {
      expect(g.wheels.length).toBeGreaterThan(0);
      expect(g.chassisRadii).toHaveLength(g.chassisVertexCount);
    }
  });

  it('respects eliteCount = 0 (whole population is offspring)', () => {
    const prev = makeScored(24, 6);
    const next = nextGeneration(prev, { ...PARAMS, eliteCount: 0 }, makeRng(2));
    expect(next).toHaveLength(PARAMS.populationSize);
  });
});
