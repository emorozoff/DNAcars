/**
 * Sphere-function convergence test.
 *
 * The sphere function f(x) = -Σ xᵢ²  has a unique maximum at the origin.
 * A correctly wired GA should drive a population from random points in
 * [-5, 5]ⁿ toward the origin within tens of generations.  This is a sanity
 * check on selection × crossover × mutation, independent of physics.
 */

import { describe, expect, it } from 'vitest';
import { makeRng, rngRange, type Rng } from '../../sim/prng';
import { nextGeneration, summarizeGeneration } from '../population';
import type { Scored } from '../types';

type Vec = number[];

function sphere(v: Vec): number {
  return -v.reduce((acc, x) => acc + x * x, 0);
}

function randomVec(rng: Rng, dim: number, range: number): Vec {
  return Array.from({ length: dim }, () => rngRange(rng, -range, range));
}

function uniformCrossover(a: Vec, b: Vec, rng: Rng): Vec {
  return a.map((x, i) => (rng() < 0.5 ? x : (b[i] ?? x)));
}

function gaussianMutation(v: Vec, rng: Rng, sigma: number, rate: number): Vec {
  return v.map((x) => {
    if (rng() >= rate) return x;
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    const noise = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
    return x + noise;
  });
}

describe('sphere convergence', () => {
  it('drives mean fitness up over generations', () => {
    const rng = makeRng('sphere');
    const dim = 5;
    const populationSize = 60;
    const generations = 80;

    let pop: Vec[] = Array.from({ length: populationSize }, () => randomVec(rng, dim, 5));

    let firstMean = 0;
    let lastMean = 0;
    let lastBest = -Infinity;

    for (let gen = 0; gen < generations; gen++) {
      const scored: Scored<Vec>[] = pop.map((v) => ({ individual: v, fitness: sphere(v) }));
      const stats = summarizeGeneration(scored, gen);
      if (gen === 0) firstMean = stats.mean;
      lastMean = stats.mean;
      lastBest = stats.best;
      pop = nextGeneration(scored, {
        populationSize,
        eliteCount: 2,
        tournamentSize: 4,
        crossover: uniformCrossover,
        mutate: (v, r) => gaussianMutation(v, r, 0.4, 0.3),
        rng,
      });
    }

    // Fitness is negative, so "improving" means closer to 0.
    expect(lastMean).toBeGreaterThan(firstMean);
    // The best individual should be near the optimum: |x|² < 1.5.
    expect(lastBest).toBeGreaterThan(-1.5);
  });
});
