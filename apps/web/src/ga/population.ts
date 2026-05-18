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
  /**
   * Selection score the GA reads.  In normal mode this equals
   * `travel`; in speed mode it's an inverse-time bonus for finishers
   * while non-finishers still get `travel`.  Don't use this for
   * display — use `travel` so the chart axes stay in metres.
   */
  fitness: number;
  /** Distance the chassis actually travelled this gen, in metres.
   *  Always present, mode-independent — the canonical "how far
   *  did this car get" reading. */
  travel: number;
  /**
   * Sim seconds at which the chassis crossed the finish line during
   * this generation, or null if the car never finished.  Threaded
   * through here so the stats collector + speed-mode chart can read
   * the per-car timing without re-fetching the world snapshot.
   */
  finishTime: number | null;
};

export type GAParams = {
  populationSize: number;
  eliteCount: number;
  /** Per-gene probability of mutation, [0..1]. */
  mutationRate: number;
  /**
   * Selection-pressure exponent, ≥ 1.  Each fitness is raised to this
   * power before roulette selection, which sharpens the gap between
   * cars: k=1 is plain fitness-proportional selection; higher k lets
   * a big-margin leader claim a disproportionate share of parent
   * slots (a 3× lead becomes a 3^k× selection advantage), while a
   * near-tie stays near-even because (1.05)^k is still ≈ 1.
   */
  selectionPressure: number;
};

export function nextGeneration(prev: Scored[], params: GAParams, rng: Rng): Genome[] {
  if (prev.length === 0) return [];

  const fitnesses = prev.map((p) => p.fitness);
  const eliteIdx = topNIndices(fitnesses, params.eliteCount);
  const next: Genome[] = eliteIdx.map((i) => deepClone(prev[i]!.genome));

  // Roulette weights = fitness^k.  Elite picking above stays on raw
  // fitness — pressure only reshapes the random parent draw, not the
  // ranking (x^k is monotonic, so the top-N set is unchanged anyway).
  const k = params.selectionPressure;
  const weights = k === 1 ? fitnesses : fitnesses.map((f) => (f > 0 ? Math.pow(f, k) : 0));

  const pool = prev.map((p) => p.genome);
  while (next.length < params.populationSize) {
    const a = rouletteSelect(pool, weights, rng);
    const b = rouletteSelect(pool, weights, rng);
    const child = crossoverGenomes(a, b, rng);
    next.push(mutateGenome(child, params.mutationRate, rng));
  }
  return next;
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
