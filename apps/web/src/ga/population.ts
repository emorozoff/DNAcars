/**
 * Generation-to-generation orchestration.
 *
 * Generic enough to plug in non-genome individuals for tests.  In
 * production we instantiate it with `Genome` and the operators from
 * ./genome-ops.ts.
 */

import type { Rng } from '../sim/prng';
import { rankByFitness, tournamentSelect } from './selection';
import type { CrossoverFn, MutationFn, Scored } from './types';

export type EvolveConfig<T> = {
  populationSize: number;
  eliteCount: number;
  tournamentSize: number;
  crossover: CrossoverFn<T>;
  mutate: MutationFn<T>;
  rng: Rng;
};

/**
 * Build the next generation given a scored previous one.
 * Top `eliteCount` individuals copy through unchanged.  The rest are
 * produced by tournament selection × crossover × mutation.
 */
export function nextGeneration<T>(scored: Scored<T>[], config: EvolveConfig<T>): T[] {
  if (scored.length === 0) {
    throw new Error('nextGeneration: empty population');
  }
  const ranked = rankByFitness(scored);
  const elites = ranked.slice(0, Math.max(0, config.eliteCount)).map((s) => s.individual);
  const out: T[] = [...elites];

  while (out.length < config.populationSize) {
    const a = tournamentSelect(ranked, config.tournamentSize, config.rng);
    const b = tournamentSelect(ranked, config.tournamentSize, config.rng);
    const child = config.mutate(config.crossover(a, b, config.rng), config.rng);
    out.push(child);
  }
  return out;
}

export type GenerationStats = {
  generation: number;
  best: number;
  mean: number;
  median: number;
  worst: number;
  topGenome?: unknown;
};

export function summarizeGeneration<T>(scored: Scored<T>[], generation: number): GenerationStats {
  if (scored.length === 0) {
    return { generation, best: 0, mean: 0, median: 0, worst: 0 };
  }
  const sorted = [...scored].sort((a, b) => b.fitness - a.fitness);
  const sum = sorted.reduce((acc, s) => acc + s.fitness, 0);
  return {
    generation,
    best: sorted[0]!.fitness,
    worst: sorted[sorted.length - 1]!.fitness,
    mean: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)]!.fitness,
    topGenome: sorted[0]!.individual,
  };
}
