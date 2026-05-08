/**
 * Population — orchestrates one generation → next generation.
 *
 * Pipeline (default):
 *
 *   1. Sort everyone by fitness, descending.
 *   2. Take the top `eliteCount` straight through to the next gen
 *      unchanged (deep cloned so future mutations don't smear them).
 *   3. Fill the rest by repeatedly: pick two parents via roulette,
 *      crossover them, mutate the child.
 *
 * Pipeline (pureMutation): same elite step, then every remaining
 * child is `mutate(clone(top))` — no roulette, no crossover.  The
 * single best car is the only "teacher".  See GAParams.pureMutation
 * for the rationale.
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
   * Pure-mutation mode (a.k.a. (1+λ)-ES): drop crossover + roulette
   * selection entirely.  Top `eliteCount` cars are still cloned
   * through unchanged; every other child is `mutate(clone(top))` —
   * the single best car is the only "teacher" for the next gen.
   * Trades crossover-driven gene-block recombination for a much
   * simpler "the winner trains everyone" mental model.  Risk:
   * premature convergence — population can collapse into 60 near-
   * identical clones if mutation is too low.
   */
  pureMutation: boolean;
};

export function nextGeneration(prev: Scored[], params: GAParams, rng: Rng): Genome[] {
  if (prev.length === 0) return [];

  const fitnesses = prev.map((p) => p.fitness);
  const eliteIdx = topNIndices(fitnesses, params.eliteCount);
  const next: Genome[] = eliteIdx.map((i) => deepClone(prev[i]!.genome));

  if (params.pureMutation) {
    // Single teacher — top-1 by fitness, regardless of eliteCount.
    // Falls back to prev[0] only if every fitness is non-positive
    // (topNIndices still returns indices in that case via stable
    // sort, so this is just a TS-narrowing safety net).
    const topIdx = topNIndices(fitnesses, 1)[0] ?? 0;
    const teacher = prev[topIdx]!.genome;
    while (next.length < params.populationSize) {
      next.push(mutateGenome(deepClone(teacher), params.mutationRate, rng));
    }
    return next;
  }

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
