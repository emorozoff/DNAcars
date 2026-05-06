/**
 * Genome ↔ phenotype decoder.
 *
 * The wire-format `Genome` from @dnacars/shared stores everything in [0, 1].
 * Decoding maps those normalized values into real-world ranges (meters,
 * densities).  Keep this file as the single source of truth for those
 * ranges — physics tuning lives here.
 *
 * v2 schema (since v0.6.0): only the traits visible on screen.
 *   - chassis: vertex count, per-vertex radius, density
 *   - wheels:  per-wheel radius, density, attach vertex, motor torque share
 *   - motor:   single base speed
 * No more suspension, friction or reverse genes — those just added noise.
 */

import type { Genome, WheelGene } from '@dnacars/shared';
import { rngInt, rngRange, type Rng } from './prng';

/** Hard physical limits used by the decoder. */
export const PHYSICS = {
  chassis: {
    minVertices: 5,
    maxVertices: 10,
    minRadius: 0.35,
    maxRadius: 1.0,
    /**
     * The body is *much* denser than a wheel.  Together with the small
     * wheel-density range below, this keeps the centre of gravity low
     * and gives flips a real physical cause (steep slopes, jumps),
     * not random body-on-tire spins.
     */
    minDensity: 250,
    maxDensity: 450,
  },
  wheel: {
    minCount: 1,
    maxCount: 4,
    minRadius: 0.18,
    maxRadius: 0.7,
    /** Wheels are deliberately light so the chassis dominates the moment. */
    minDensity: 25,
    maxDensity: 70,
    /** Constant friction for every wheel — no longer evolved. */
    friction: 1.4,
  },
  motor: {
    minSpeed: 8,
    maxSpeed: 24,
    /**
     * Headroom multiplier for the maximum torque the wheel can apply,
     * relative to (mass × g × radius).  Keeps even heavy cars climbing.
     */
    torqueHeadroom: 2.0,
  },
} as const;

export type DecodedChassis = {
  /** Vertices in body-local coordinates, meters, evenly spaced angles. */
  vertices: { x: number; y: number }[];
  density: number;
};

export type DecodedWheel = {
  radius: number;
  density: number;
  /** Vertex index this wheel is attached to. */
  attachVertex: number;
  /** Fraction of base motor torque this wheel applies (0..1). */
  motorTorqueFraction: number;
};

export type DecodedMotor = {
  baseSpeed: number;
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

  // Vertices on evenly-spaced rays around the centre — only the radius
  // varies, never the angle.  Result is always a non-self-intersecting
  // (and therefore convex-hullable) polygon.
  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const angle = ((i + 0.5) / n) * Math.PI * 2;
    const r = lerp(
      PHYSICS.chassis.minRadius,
      PHYSICS.chassis.maxRadius,
      clamp01(c.radii[i] ?? 0.5),
    );
    vertices.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }

  return {
    vertices,
    density: lerp(PHYSICS.chassis.minDensity, PHYSICS.chassis.maxDensity, clamp01(c.density)),
  };
}

function decodeWheel(w: WheelGene, vertexCount: number): DecodedWheel {
  return {
    radius: lerp(PHYSICS.wheel.minRadius, PHYSICS.wheel.maxRadius, clamp01(w.radius)),
    density: lerp(PHYSICS.wheel.minDensity, PHYSICS.wheel.maxDensity, clamp01(w.density)),
    attachVertex: clampInt(w.attachVertex, 0, vertexCount - 1),
    motorTorqueFraction: clamp01(w.motorTorque),
  };
}

function decodeMotor(g: Genome): DecodedMotor {
  return {
    baseSpeed: lerp(PHYSICS.motor.minSpeed, PHYSICS.motor.maxSpeed, clamp01(g.motor.baseSpeed)),
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
  for (let i = 0; i < vertexCount; i++) radii.push(rng());

  const wheels: WheelGene[] = [];
  for (let i = 0; i < wheelCount; i++) {
    wheels.push({
      radius: rng(),
      density: rng(),
      attachVertex: rngInt(rng, 0, vertexCount - 1),
      motorTorque: rngRange(rng, 0.4, 1.0),
    });
  }

  return {
    version: 2,
    chassis: {
      vertexCount,
      radii,
      density: rng(),
    },
    wheels,
    motor: { baseSpeed: rng() },
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
