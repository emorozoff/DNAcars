/**
 * Fitness function for car genomes.
 *
 * Multi-objective scalar: distance dominates, with smaller bonuses for
 * average speed and air-time penalty.  Keeping it as a single number for
 * the MVP — Pareto / NSGA-II is a v2 thing.
 */

import type { CarSnapshot } from '../sim/world';

export type FitnessConfig = {
  /** Weight applied to distance traveled (meters). */
  distanceWeight: number;
  /** Weight applied to average speed (m/s). */
  speedWeight: number;
  /** Penalty per second the car spent in the air. */
  airPenalty: number;
};

export const DEFAULT_FITNESS: FitnessConfig = {
  distanceWeight: 1.0,
  speedWeight: 0.4,
  airPenalty: 0.0,
};

/**
 * Compute fitness from a final car snapshot + total simulated seconds.
 * Distance is the leading term so longer trips always win.
 */
export function carFitness(
  snapshot: CarSnapshot,
  travel: number,
  durationSec: number,
  config: FitnessConfig = DEFAULT_FITNESS,
): number {
  const dist = Math.max(0, travel);
  const safeDur = Math.max(0.5, durationSec);
  const avgSpeed = dist / safeDur;
  const score = dist * config.distanceWeight + avgSpeed * config.speedWeight;
  return Math.max(0, score);
}
