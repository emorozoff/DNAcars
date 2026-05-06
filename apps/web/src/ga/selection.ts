/**
 * Tournament selection.
 *
 * Pick `k` random individuals, return the one with the highest fitness.
 * Larger k → more selection pressure (faster convergence, less diversity).
 */

import { rngInt } from '../sim/prng';
import type { Rng } from '../sim/prng';
import type { Scored } from './types';

export function tournamentSelect<T>(population: Scored<T>[], k: number, rng: Rng): T {
  if (population.length === 0) {
    throw new Error('tournamentSelect: population is empty');
  }
  let bestIndex = rngInt(rng, 0, population.length - 1);
  let bestFitness = population[bestIndex]!.fitness;
  for (let i = 1; i < k; i++) {
    const idx = rngInt(rng, 0, population.length - 1);
    const f = population[idx]!.fitness;
    if (f > bestFitness) {
      bestFitness = f;
      bestIndex = idx;
    }
  }
  return population[bestIndex]!.individual;
}

/** Sort by fitness descending — convenience used by elitism. */
export function rankByFitness<T>(population: Scored<T>[]): Scored<T>[] {
  return [...population].sort((a, b) => b.fitness - a.fitness);
}
