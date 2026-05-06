/**
 * Genome ↔ phenotype decoder.
 *
 * The wire-format `Genome` from @dnacars/shared stores everything in [0, 1].
 * Decoding maps those normalized values into real-world ranges (meters,
 * Hz, multipliers, etc.).  Keep this file as the single source of truth
 * for those ranges — physics tuning lives here.
 */

import type { Genome, WheelGene } from '@dnacars/shared';
import { rngInt, rngRange, type Rng } from './prng';

/** Hard physical limits used by the decoder. */
export const PHYSICS = {
  chassis: {
    minVertices: 6,
    maxVertices: 12,
    minRadius: 0.35,
    maxRadius: 1.0,
    minDensity: 60,
    maxDensity: 200,
    /** Maximum angular jitter as a fraction of the slot. ±0.4 keeps the polygon convex-ish. */
    angleJitterRange: 0.4,
  },
  wheel: {
    minCount: 1,
    maxCount: 4,
    minRadius: 0.18,
    maxRadius: 0.7,
    minDensity: 40,
    maxDensity: 120,
    minFriction: 0.6,
    maxFriction: 2.0,
    /** Suspension natural frequency in Hz. */
    minStiffness: 4,
    maxStiffness: 30,
    minDamping: 0.2,
    maxDamping: 1.2,
  },
  motor: {
    minSpeed: 8,
    maxSpeed: 28,
    minGear: 0.6,
    maxGear: 1.6,
    /** Torque multiplier — multiplied by mass*g/radius for headroom. */
    torqueHeadroom: 1.6,
  },
} as const;

export type DecodedChassis = {
  /** Counter-clockwise polygon vertices in body-local coordinates, meters. */
  vertices: { x: number; y: number }[];
  density: number;
};

export type DecodedWheel = {
  radius: number;
  density: number;
  friction: number;
  /** Vertex index this wheel is attached to. */
  attachVertex: number;
  /** Suspension natural frequency in Hz. */
  stiffnessHz: number;
  /** Damping ratio (0 = none, 1 = critical). */
  dampingRatio: number;
  /** Fraction of base motor torque this wheel applies (0..1). */
  motorTorqueFraction: number;
};

export type DecodedMotor = {
  baseSpeed: number;
  canReverse: boolean;
  gearRatio: number;
};

export type DecodedCar = {
  chassis: DecodedChassis;
  wheels: DecodedWheel[];
  motor: DecodedMotor;
};

/* ─── Decode ────────────────────────────────────────────────────────────── */

export function decodeGenome(g: Genome): DecodedCar {
  const chassis = decodeChassis(g);
  const wheels = g.wheels.map((w) => decodeWheel(w, chassis.vertices.length));
  const motor = decodeMotor(g);
  return { chassis, wheels, motor };
}

function decodeChassis(g: Genome): DecodedChassis {
  const c = g.chassis;
  const n = clampInt(c.vertexCount, PHYSICS.chassis.minVertices, PHYSICS.chassis.maxVertices);
  const radii = c.radii.slice(0, n);
  const jitter = c.angleJitter.slice(0, n);

  // Vertices distributed around a circle, with per-vertex jitter on the
  // angular slot and an evolved radius. Convex-ish but allowed to wobble.
  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const slot = (i + 0.5) / n;
    const jitterValue = (jitter[i] ?? 0.5) - 0.5;
    const angle = (slot + jitterValue * (PHYSICS.chassis.angleJitterRange / n)) * Math.PI * 2;
    const r = lerp(PHYSICS.chassis.minRadius, PHYSICS.chassis.maxRadius, clamp01(radii[i] ?? 0.5));
    vertices.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }

  return {
    vertices,
    density: lerp(PHYSICS.chassis.minDensity, PHYSICS.chassis.maxDensity, clamp01(c.density)),
  };
}

function decodeWheel(w: WheelGene, vertexCount: number): DecodedWheel {
  const v = clampInt(w.attachVertex, 0, vertexCount - 1);
  return {
    radius: lerp(PHYSICS.wheel.minRadius, PHYSICS.wheel.maxRadius, clamp01(w.radius)),
    density: lerp(PHYSICS.wheel.minDensity, PHYSICS.wheel.maxDensity, clamp01(w.density)),
    friction: lerp(PHYSICS.wheel.minFriction, PHYSICS.wheel.maxFriction, clamp01(w.friction)),
    attachVertex: v,
    stiffnessHz: lerp(
      PHYSICS.wheel.minStiffness,
      PHYSICS.wheel.maxStiffness,
      clamp01(w.suspensionStiffness),
    ),
    dampingRatio: lerp(
      PHYSICS.wheel.minDamping,
      PHYSICS.wheel.maxDamping,
      clamp01(w.suspensionDamping),
    ),
    motorTorqueFraction: clamp01(w.motorTorque),
  };
}

function decodeMotor(g: Genome): DecodedMotor {
  return {
    baseSpeed: lerp(PHYSICS.motor.minSpeed, PHYSICS.motor.maxSpeed, clamp01(g.motor.baseSpeed)),
    canReverse: g.motor.canReverse,
    gearRatio: lerp(PHYSICS.motor.minGear, PHYSICS.motor.maxGear, clamp01(g.motor.gearRatio)),
  };
}

/* ─── Random genome ─────────────────────────────────────────────────────── */

/**
 * Build a uniformly random genome.  Used for generation zero and for tests.
 * `rng` is required so that tests are deterministic.
 */
export function randomGenome(rng: Rng): Genome {
  const vertexCount = rngInt(rng, PHYSICS.chassis.minVertices, PHYSICS.chassis.maxVertices);
  const wheelCount = rngInt(rng, PHYSICS.wheel.minCount, PHYSICS.wheel.maxCount);

  const radii: number[] = [];
  const angleJitter: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    radii.push(rng());
    angleJitter.push(rng());
  }

  const wheels: WheelGene[] = [];
  for (let i = 0; i < wheelCount; i++) {
    wheels.push({
      radius: rng(),
      density: rng(),
      friction: rng(),
      attachVertex: rngInt(rng, 0, vertexCount - 1),
      suspensionStiffness: rng(),
      suspensionDamping: rng(),
      motorTorque: rngRange(rng, 0.4, 1.0),
    });
  }

  return {
    version: 1,
    chassis: {
      vertexCount,
      radii,
      angleJitter,
      density: rng(),
    },
    wheels,
    motor: {
      baseSpeed: rng(),
      canReverse: false,
      gearRatio: rng(),
    },
  };
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function clampInt(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(x)));
}
