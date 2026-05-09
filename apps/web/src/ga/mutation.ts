/**
 * Mutation — perturb each gene of a genome with probability `rate`.
 *
 * Continuous genes (radii, density, power, motor speed) get a small
 * gaussian-ish kick.  Structural genes (vertex count, wheel count,
 * wheel attachment vertex) mutate more rarely — they tend to break
 * the body plan rather than refine it, so a high rate would just
 * drown out useful local search.
 */

import { TUNING, type Genome, type Rng, type WheelGene } from '../sim/world';

export function mutateGenome(g: Genome, rate: number, rng: Rng): Genome {
  // Continuous-axis nudge: with probability `rate` push the value by
  // ±scale within the legal range.  The scale is half the legal range
  // by default — we want mutations to be large enough to matter on a
  // small population but rarely big enough to teleport the genome.
  const nudge = (current: number, scale: number, lo: number, hi: number): number => {
    if (rng() >= rate) return current;
    const next = current + (rng() * 2 - 1) * scale;
    return clamp(next, lo, hi);
  };

  // Vertex count mutates rarely — at rate × 0.15 — and only by ±1.
  // Bigger jumps tend to wreck a body that was almost-good.
  let vertexCount = g.chassisVertexCount;
  if (rng() < rate * 0.15) {
    vertexCount += rng() < 0.5 ? -1 : 1;
    vertexCount = clamp(vertexCount, TUNING.chassis.minVertices, TUNING.chassis.maxVertices);
  }

  const radii: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const src = g.chassisRadii[i] ?? lerp(TUNING.chassis.minRadius, TUNING.chassis.maxRadius, 0.5);
    radii.push(nudge(src, 0.12, TUNING.chassis.minRadius, TUNING.chassis.maxRadius));
  }

  // Per-wheel: nudge radius and power.  attachVertex shifts to a
  // random valid vertex with low probability.
  const wheels: WheelGene[] = g.wheels.map((w) => {
    let attach = w.attachVertex;
    if (rng() < rate * 0.25) attach = Math.floor(rng() * vertexCount);
    attach = clamp(attach, 0, Math.max(0, vertexCount - 1));
    return {
      attachVertex: attach,
      radius: nudge(w.radius, 0.12, TUNING.wheel.minRadius, TUNING.wheel.maxRadius),
      power: nudge(w.power, 0.15, 0, 1),
    };
  });

  // Structural: rarely add or drop a wheel.
  if (rng() < rate * 0.1 && wheels.length > TUNING.wheel.minCount) {
    wheels.splice(Math.floor(rng() * wheels.length), 1);
  } else if (rng() < rate * 0.1 && wheels.length < TUNING.wheel.maxCount) {
    wheels.push({
      attachVertex: Math.floor(rng() * vertexCount),
      radius: lerp(TUNING.wheel.minRadius, TUNING.wheel.maxRadius, rng()),
      power: rng(),
    });
  }

  return {
    chassisVertexCount: vertexCount,
    chassisRadii: radii,
    chassisDensity: nudge(
      g.chassisDensity,
      (TUNING.chassis.maxDensity - TUNING.chassis.minDensity) * 0.15,
      TUNING.chassis.minDensity,
      TUNING.chassis.maxDensity,
    ),
    wheels,
    motorSpeed: nudge(
      g.motorSpeed,
      (TUNING.motor.maxSpeed - TUNING.motor.minSpeed) * 0.15,
      TUNING.motor.minSpeed,
      TUNING.motor.maxSpeed,
    ),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
