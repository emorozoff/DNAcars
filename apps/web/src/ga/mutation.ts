/**
 * Mutation — perturb each gene of a genome with probability `rate`.
 *
 * Continuous genes (radii, density, power, motor speed, angle offsets,
 * ballast, grip, bounce) get a small gaussian-ish kick.  Structural
 * genes (vertex count, wheel count, wheel attachment vertex, ballast
 * vertex) mutate more rarely — they tend to break the body plan rather
 * than refine it, so a high rate would just drown out useful local
 * search.
 */

import {
  pruneOverlappingWheels,
  TUNING,
  type Genome,
  type Rng,
  type WheelGene,
} from '../sim/world';

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
  const angleOffsets: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const rSrc = g.chassisRadii[i] ?? lerp(TUNING.chassis.minRadius, TUNING.chassis.maxRadius, 0.5);
    radii.push(nudge(rSrc, 0.12, TUNING.chassis.minRadius, TUNING.chassis.maxRadius));
    // Angle offset defaults to 0.5 (= uniform) when growing the
    // polygon — so a brand-new vertex starts in the same place a
    // pre-v1.50 genome would have placed it.
    const aSrc = g.chassisAngleOffsets?.[i] ?? 0.5;
    angleOffsets.push(nudge(aSrc, 0.12, 0, 1));
  }

  // Per-wheel: nudge radius, power, grip and bounce.  attachVertex
  // shifts to a random valid vertex with low probability.
  const wheels: WheelGene[] = g.wheels.map((w) => {
    let attach = w.attachVertex;
    if (rng() < rate * 0.25) attach = Math.floor(rng() * vertexCount);
    attach = clamp(attach, 0, Math.max(0, vertexCount - 1));
    return {
      attachVertex: attach,
      radius: nudge(w.radius, 0.12, TUNING.wheel.minRadius, TUNING.wheel.maxRadius),
      power: nudge(w.power, 0.15, 0, 1),
      grip: nudge(w.grip ?? 0.5, 0.12, 0, 1),
      bounce: nudge(w.bounce ?? 0, 0.12, 0, 1),
      offsetX: nudge(w.offsetX ?? 0.5, 0.1, 0, 1),
      offsetY: nudge(w.offsetY ?? 0.5, 0.1, 0, 1),
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
      grip: 0.3 + 0.5 * rng(),
      // Quadratic bias toward zero — new wheels start non-bouncy.
      // Same convention as world.randomGenome.
      bounce: rng() * rng() * 0.4,
      offsetX: 0.4 + 0.2 * rng(),
      offsetY: 0.4 + 0.2 * rng(),
    });
  }

  // Ballast: vertex hops occasionally (like wheel attach), size and
  // density nudge as continuous genes.  Default fallbacks make
  // pre-v1.50 genomes mutate-clean.
  let ballastVertex = g.ballastVertex ?? 0;
  if (rng() < rate * 0.2) ballastVertex = Math.floor(rng() * vertexCount);
  ballastVertex = clamp(ballastVertex, 0, Math.max(0, vertexCount - 1));

  const mutated: Genome = {
    chassisVertexCount: vertexCount,
    chassisRadii: radii,
    chassisAngleOffsets: angleOffsets,
    chassisDensity: nudge(
      g.chassisDensity,
      (TUNING.chassis.maxDensity - TUNING.chassis.minDensity) * 0.15,
      TUNING.chassis.minDensity,
      TUNING.chassis.maxDensity,
    ),
    ballastVertex,
    ballastSize: nudge(g.ballastSize ?? 0, 0.12, 0, 1),
    ballastDensity: nudge(g.ballastDensity ?? 0.5, 0.12, 0, 1),
    wheels,
    motorSpeed: nudge(
      g.motorSpeed,
      (TUNING.motor.maxSpeed - TUNING.motor.minSpeed) * 0.15,
      TUNING.motor.minSpeed,
      TUNING.motor.maxSpeed,
    ),
    aero: nudge(g.aero ?? 0, 0.1, 0, 1),
    stabilizer: nudge(g.stabilizer ?? 0, 0.1, 0, 1),
    driveBias: nudge(g.driveBias ?? 0.5, 0.1, 0, 1),
    // Hue mutates faster than physics genes — drift in colour space
    // is desirable for visualising lineage, and unlike physical
    // genes there's no fitness penalty for landing on any value.
    hue: nudge(g.hue ?? 0, 0.25, 0, 1),
  };
  // Mutation can shift a wheel's radius/offset enough to push it
  // into another wheel's footprint.  Prune so the genome that
  // crossover / fitness sees actually matches what buildCar will
  // build, not a phantom-wheel ghost count.
  return pruneOverlappingWheels(mutated);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
