/**
 * Per-generation aggregate collector.
 *
 * After each generation finishes, the host hands us the
 * `Scored[]` (genome + fitness, one per car) and how long the
 * generation took.  We squeeze it into a flat row of summary
 * statistics that's cheap to plot.  The charts module then keeps a
 * running history of these rows and renders sparklines from them.
 *
 * Add new metrics here and they become a new line on the dashboard
 * with no other plumbing.
 */

import type { Scored } from '../ga/population';

export type GenerationStats = {
  generation: number;
  /** Wall-clock seconds the generation actually took.  At ×8 speed-up
   *  this is real seconds, not simulated. */
  durationSec: number;
  /** Furthest distance any car achieved this generation, m. */
  best: number;
  /** Arithmetic mean of all fitnesses, m. */
  mean: number;
  /** Median fitness, m — robust against the few outliers. */
  median: number;
  /** Worst (i.e. lowest) fitness, m. */
  worst: number;
  /** Standard deviation of fitness — a coarse "diversity" signal. */
  stdev: number;
  /** Number of cars that travelled more than 1 m (i.e. actually moved). */
  alive: number;
  /** Population size this generation. */
  total: number;
  /** Average chassis vertex count across the population. */
  avgVertexCount: number;
  /** Average wheel count across the population. */
  avgWheelCount: number;
  /** Average wheel power gene value (0..1) across all wheels of all cars. */
  avgWheelPower: number;
  /** Average motor speed gene (rad/s) across the population. */
  avgMotorSpeed: number;
  /** Average chassis density (kg/m²) across the population. */
  avgChassisDensity: number;
  /** Average of each genome's mean chassis radius (the "size" of the body). */
  avgChassisRadius: number;
};

export function collectStats(
  generation: number,
  durationSec: number,
  results: Scored[],
): GenerationStats {
  const total = results.length;
  if (total === 0) {
    return zeroStats(generation, durationSec);
  }

  const fitnesses = results.map((r) => r.fitness).sort((a, b) => a - b);
  const best = fitnesses[total - 1] ?? 0;
  const worst = fitnesses[0] ?? 0;
  const mean = fitnesses.reduce((a, b) => a + b, 0) / total;
  const median = fitnesses[Math.floor(total / 2)] ?? 0;
  const variance = fitnesses.reduce((acc, f) => acc + (f - mean) ** 2, 0) / total;
  const stdev = Math.sqrt(variance);
  const alive = fitnesses.reduce((c, f) => (f > 1 ? c + 1 : c), 0);

  let totalVerts = 0;
  let totalWheelCount = 0;
  let totalWheelPower = 0;
  let totalMotorSpeed = 0;
  let totalChassisDensity = 0;
  let totalChassisRadius = 0;

  for (const r of results) {
    const g = r.genome;
    totalVerts += g.chassisVertexCount;
    totalWheelCount += g.wheels.length;
    for (const w of g.wheels) totalWheelPower += w.power;
    totalMotorSpeed += g.motorSpeed;
    totalChassisDensity += g.chassisDensity;
    const radii = g.chassisRadii;
    if (radii.length > 0) {
      totalChassisRadius += radii.reduce((a, b) => a + b, 0) / radii.length;
    }
  }

  const allWheels = totalWheelCount || 1;

  return {
    generation,
    durationSec,
    best,
    mean,
    median,
    worst,
    stdev,
    alive,
    total,
    avgVertexCount: totalVerts / total,
    avgWheelCount: totalWheelCount / total,
    avgWheelPower: totalWheelPower / allWheels,
    avgMotorSpeed: totalMotorSpeed / total,
    avgChassisDensity: totalChassisDensity / total,
    avgChassisRadius: totalChassisRadius / total,
  };
}

function zeroStats(generation: number, durationSec: number): GenerationStats {
  return {
    generation,
    durationSec,
    best: 0,
    mean: 0,
    median: 0,
    worst: 0,
    stdev: 0,
    alive: 0,
    total: 0,
    avgVertexCount: 0,
    avgWheelCount: 0,
    avgWheelPower: 0,
    avgMotorSpeed: 0,
    avgChassisDensity: 0,
    avgChassisRadius: 0,
  };
}
