/**
 * Population — orchestrates one generation → next generation.
 *
 * Pipeline:
 *
 *   1. Sort everyone by fitness, descending.
 *   2. Take the top `eliteCount` straight through to the next gen
 *      unchanged (deep cloned so future mutations don't smear them).
 *   3. Fill the rest by repeatedly: pick two parents via roulette,
 *      crossover them, mutate the child.
 *
 * Pure function — given the same prev/params/rng it produces the
 * same population every time.  This makes it cheap to test and
 * lets a single master seed deterministically replay an entire run.
 */

import type { Genome, Rng } from '../sim/world';
import { rouletteSelect, topNIndices } from './selection';
import { crossoverGenomes } from './crossover';
import { mutateGenome } from './mutation';

export type Scored = {
  genome: Genome;
  fitness: number;
};

export type GAParams = {
  populationSize: number;
  eliteCount: number;
  /** Per-gene probability of mutation, [0..1]. */
  mutationRate: number;
};

export function nextGeneration(prev: Scored[], params: GAParams, rng: Rng): Genome[] {
  if (prev.length === 0) return [];

  const fitnesses = prev.map((p) => p.fitness);
  const eliteIdx = topNIndices(fitnesses, params.eliteCount);
  const next: Genome[] = eliteIdx.map((i) => deepClone(prev[i]!.genome));

  const pool = prev.map((p) => p.genome);
  while (next.length < params.populationSize) {
    const a = rouletteSelect(pool, fitnesses, rng);
    const b = rouletteSelect(pool, fitnesses, rng);
    const child = crossoverGenomes(a, b, rng);
    next.push(mutateGenome(child, params.mutationRate, rng));
  }
  return next;
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
