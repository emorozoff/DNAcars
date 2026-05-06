/**
 * Genome-specific crossover and mutation.
 *
 * The wire-format `Genome` from @dnacars/shared has a flat list of numbers
 * in [0,1] for every gene plus structural integers (vertex count, attach
 * vertex, wheel count, etc.).  Crossover treats every gene as
 * independently swappable; mutation perturbs floats by gaussian noise and
 * resamples integers occasionally.
 */

import type { Genome, WheelGene } from '@dnacars/shared';
import { rngInt, type Rng } from '../sim/prng';
import { PHYSICS } from '../sim/genome';

/* ─── Crossover ─────────────────────────────────────────────────────────── */

/**
 * Uniform per-gene crossover.  Float arrays are mixed coordinate by
 * coordinate; structural integers (vertexCount, wheelCount, etc.) are taken
 * from one parent or the other; downstream arrays are truncated/extended
 * to match the chosen structure.
 */
export function crossoverGenomes(a: Genome, b: Genome, rng: Rng): Genome {
  const pickA = (): boolean => rng() < 0.5;

  const vertexCount = pickA() ? a.chassis.vertexCount : b.chassis.vertexCount;
  const wheelCount = pickA() ? a.wheels.length : b.wheels.length;

  const radii: number[] = [];
  const angleJitter: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    radii.push(pickGene(a.chassis.radii[i], b.chassis.radii[i], rng));
    angleJitter.push(pickGene(a.chassis.angleJitter[i], b.chassis.angleJitter[i], rng));
  }

  const wheels: WheelGene[] = [];
  for (let i = 0; i < wheelCount; i++) {
    const aw = a.wheels[i];
    const bw = b.wheels[i];
    wheels.push(crossoverWheel(aw, bw, vertexCount, rng));
  }

  return {
    version: 1,
    chassis: {
      vertexCount,
      radii,
      angleJitter,
      density: pickGene(a.chassis.density, b.chassis.density, rng),
    },
    wheels,
    motor: {
      baseSpeed: pickGene(a.motor.baseSpeed, b.motor.baseSpeed, rng),
      canReverse: pickA() ? a.motor.canReverse : b.motor.canReverse,
      gearRatio: pickGene(a.motor.gearRatio, b.motor.gearRatio, rng),
    },
  };
}

function crossoverWheel(
  a: WheelGene | undefined,
  b: WheelGene | undefined,
  vertexCount: number,
  rng: Rng,
): WheelGene {
  if (!a && !b) return randomWheel(rng, vertexCount);
  if (!a) return clampWheelAttachment(b!, vertexCount);
  if (!b) return clampWheelAttachment(a, vertexCount);
  return {
    radius: pickGene(a.radius, b.radius, rng),
    density: pickGene(a.density, b.density, rng),
    friction: pickGene(a.friction, b.friction, rng),
    attachVertex: clampInt(rng() < 0.5 ? a.attachVertex : b.attachVertex, vertexCount),
    suspensionStiffness: pickGene(a.suspensionStiffness, b.suspensionStiffness, rng),
    suspensionDamping: pickGene(a.suspensionDamping, b.suspensionDamping, rng),
    motorTorque: pickGene(a.motorTorque, b.motorTorque, rng),
  };
}

/* ─── Mutation ──────────────────────────────────────────────────────────── */

export type MutationConfig = {
  /** Per-gene mutation probability, 0..1. */
  rate: number;
  /** Gaussian sigma applied to floats already in [0,1] space. */
  sigma: number;
  /** Probability of structural mutation per gene (vertex/wheel count). */
  structuralRate: number;
};

export const DEFAULT_MUTATION: MutationConfig = {
  rate: 0.08,
  sigma: 0.18,
  structuralRate: 0.04,
};

export function mutateGenome(
  genome: Genome,
  rng: Rng,
  config: MutationConfig = DEFAULT_MUTATION,
): Genome {
  // Structural mutation: occasionally bump vertex / wheel counts.
  let vertexCount = genome.chassis.vertexCount;
  if (rng() < config.structuralRate) {
    vertexCount = clamp(
      vertexCount + (rng() < 0.5 ? -1 : 1),
      PHYSICS.chassis.minVertices,
      PHYSICS.chassis.maxVertices,
    );
  }

  let wheelCount = genome.wheels.length;
  if (rng() < config.structuralRate) {
    wheelCount = clamp(
      wheelCount + (rng() < 0.5 ? -1 : 1),
      PHYSICS.wheel.minCount,
      PHYSICS.wheel.maxCount,
    );
  }

  const radii = adjustLength(genome.chassis.radii, vertexCount, rng).map((v) =>
    perturb(v, rng, config),
  );
  const angleJitter = adjustLength(genome.chassis.angleJitter, vertexCount, rng).map((v) =>
    perturb(v, rng, config),
  );

  const wheels: WheelGene[] = [];
  for (let i = 0; i < wheelCount; i++) {
    const w = genome.wheels[i] ?? randomWheel(rng, vertexCount);
    wheels.push(mutateWheel(w, vertexCount, rng, config));
  }

  return {
    version: 1,
    chassis: {
      vertexCount,
      radii,
      angleJitter,
      density: perturb(genome.chassis.density, rng, config),
    },
    wheels,
    motor: {
      baseSpeed: perturb(genome.motor.baseSpeed, rng, config),
      canReverse: rng() < config.rate ? !genome.motor.canReverse : genome.motor.canReverse,
      gearRatio: perturb(genome.motor.gearRatio, rng, config),
    },
  };
}

function mutateWheel(
  w: WheelGene,
  vertexCount: number,
  rng: Rng,
  config: MutationConfig,
): WheelGene {
  return {
    radius: perturb(w.radius, rng, config),
    density: perturb(w.density, rng, config),
    friction: perturb(w.friction, rng, config),
    attachVertex:
      rng() < config.rate ? rngInt(rng, 0, vertexCount - 1) : clampInt(w.attachVertex, vertexCount),
    suspensionStiffness: perturb(w.suspensionStiffness, rng, config),
    suspensionDamping: perturb(w.suspensionDamping, rng, config),
    motorTorque: perturb(w.motorTorque, rng, config),
  };
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function pickGene(a: number | undefined, b: number | undefined, rng: Rng): number {
  if (a === undefined && b === undefined) return rng();
  if (a === undefined) return b!;
  if (b === undefined) return a;
  return rng() < 0.5 ? a : b;
}

/** Gaussian-style perturb of a [0,1] value, clamped back into [0,1]. */
function perturb(value: number, rng: Rng, config: MutationConfig): number {
  if (rng() >= config.rate) return value;
  const noise = gaussian(rng) * config.sigma;
  return clamp01(value + noise);
}

/** Box-Muller from two uniform samples → one standard normal. */
function gaussian(rng: Rng): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function adjustLength(arr: number[], n: number, rng: Rng): number[] {
  if (arr.length === n) return arr.slice();
  if (arr.length > n) return arr.slice(0, n);
  const out = arr.slice();
  while (out.length < n) out.push(rng());
  return out;
}

function randomWheel(rng: Rng, vertexCount: number): WheelGene {
  return {
    radius: rng(),
    density: rng(),
    friction: rng(),
    attachVertex: rngInt(rng, 0, vertexCount - 1),
    suspensionStiffness: rng(),
    suspensionDamping: rng(),
    motorTorque: 0.4 + 0.6 * rng(),
  };
}

function clampWheelAttachment(w: WheelGene, vertexCount: number): WheelGene {
  return { ...w, attachVertex: clampInt(w.attachVertex, vertexCount) };
}

function clampInt(value: number, vertexCount: number): number {
  return Math.max(0, Math.min(vertexCount - 1, Math.floor(value)));
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
