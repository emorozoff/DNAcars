/**
 * GA primitives, kept generic so they can be re-used for non-genome data
 * in tests (e.g. sphere function, vector individuals).
 */

import type { Rng } from '../sim/prng';

/** A scored individual at the end of a round. */
export type Scored<T> = {
  individual: T;
  /** Raw fitness — higher is better. */
  fitness: number;
};

export type SelectionFn<T> = (population: Scored<T>[], rng: Rng) => T;
export type CrossoverFn<T> = (a: T, b: T, rng: Rng) => T;
export type MutationFn<T> = (individual: T, rng: Rng) => T;

export type GAConfig = {
  /** How many top individuals carry over unchanged. */
  eliteCount: number;
  /** Mutation rate per gene, 0..1. */
  mutationRate: number;
  /** Mutation sigma — standard deviation of the change in [0,1] space. */
  mutationSigma: number;
  /** Tournament size for selection.  k=1 reduces to random sampling. */
  tournamentSize: number;
  /** RNG used for stochastic operators. */
  rng: Rng;
};
