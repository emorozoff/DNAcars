/**
 * Genome ↔ phenotype decoder.
 *
 * The wire-format `Genome` from @dnacars/shared stores everything in [0, 1].
 * Decoding maps those normalized values into real-world ranges (meters,
 * densities).  Keep this file as the single source of truth for those
 * ranges — physics tuning lives here.
 *
 * v3 schema (since v0.9.0):
 *   - chassis: vertex count, per-vertex radius, per-vertex angle offset,
 *              density, ballast (vertex + size + density)
 *   - wheels:  per-wheel radius, density, attach vertex, motor torque share,
 *              friction, restitution
 *   - motor:   single base speed
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
    /**
     * Maximum angular deviation from uniform vertex spacing, expressed
     * as a fraction of half the gap to a neighbour.  Anything < 1.0
     * keeps the polygon convex (vertices can never swap order).
     */
    angleJitterFraction: 0.45,
    /**
     * Optional ballast block: a heavy ball collider attached to the same
     * rigid body as the chassis at one of its vertices.  Shifts the
     * centre of mass without adding a new joint.
     */
    ballast: {
      /** Min decoded radius below which the ballast is omitted entirely. */
      offThreshold: 0.18,
      maxRadius: 0.45,
      minDensity: 600,
      maxDensity: 1500,
    },
  },
  wheel: {
    minCount: 1,
    maxCount: 4,
    minRadius: 0.18,
    maxRadius: 0.7,
    /**
     * Wider than v2 (was 25..70).  Wheels now carry meaningful mass —
     * adding a fourth wheel costs noticeable kilograms of body weight,
     * and motor power is budgeted off chassis mass alone (see world.ts),
     * so extra wheels become a real evolutionary trade-off.
     */
    minDensity: 50,
    maxDensity: 180,
    /** Friction band — wide enough to matter, narrow enough to stay stable. */
    minFriction: 0.6,
    maxFriction: 1.8,
    /** Restitution band — most of the time evolution should pick low values. */
    minRestitution: 0,
    maxRestitution: 0.35,
  },
  motor: {
    minSpeed: 8,
    maxSpeed: 24,
    /**
     * Headroom multiplier for the maximum torque the wheel can apply,
     * relative to (chassis_mass × g × radius).  Keeps even heavy cars
     * climbing.  See world.ts:applyMotor — extra wheels do NOT increase
     * the torque budget; they are a pure mass cost.
     */
    torqueHeadroom: 2.0,
  },
} as const;

export type DecodedChassis = {
  /** Vertices in body-local coordinates, meters, ordered ccw. */
  vertices: { x: number; y: number }[];
  density: number;
  /** Decoded ballast, or null if the genome chose to skip it. */
  ballast: DecodedBallast | null;
};

export type DecodedBallast = {
  /** World-local position of the ballast, in meters. */
  position: { x: number; y: number };
  radius: number;
  density: number;
};

export type DecodedWheel = {
  radius: number;
  density: number;
  /** Vertex index this wheel is attached to. */
  attachVertex: number;
  /** Fraction of base motor torque this wheel applies (0..1). */
  motorTorqueFraction: number;
  friction: number;
  restitution: number;
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

  // Vertices on rays around the centre.  Each ray's angle starts at the
  // uniform position and is nudged by `angleOffsets` — the nudge is
  // bounded so vertices can never swap order, which keeps the polygon
  // non-self-intersecting (and therefore convex-hullable).
  const gap = (Math.PI * 2) / n;
  const maxJitter = gap * 0.5 * PHYSICS.chassis.angleJitterFraction;

  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const baseAngle = ((i + 0.5) / n) * Math.PI * 2;
    const offset01 = clamp01(c.angleOffsets?.[i] ?? 0.5);
    const angle = baseAngle + (offset01 - 0.5) * 2 * maxJitter;
    const r = lerp(
      PHYSICS.chassis.minRadius,
      PHYSICS.chassis.maxRadius,
      clamp01(c.radii[i] ?? 0.5),
    );
    vertices.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }

  const ballast = decodeBallast(c, vertices);

  return {
    vertices,
    density: lerp(PHYSICS.chassis.minDensity, PHYSICS.chassis.maxDensity, clamp01(c.density)),
    ballast,
  };
}

function decodeBallast(
  c: Genome['chassis'],
  vertices: { x: number; y: number }[],
): DecodedBallast | null {
  const sizeRaw = clamp01(c.ballastSize);
  // Map [0,1] linearly to [0, maxRadius].  Anything below `offThreshold`
  // means "no ballast" — gives evolution a clean way to disable it.
  const radius = sizeRaw * PHYSICS.chassis.ballast.maxRadius;
  if (radius < PHYSICS.chassis.ballast.offThreshold) return null;

  const idx = clampInt(c.ballastVertex, 0, vertices.length - 1);
  const anchor = vertices[idx] ?? { x: 0, y: 0 };

  return {
    position: { x: anchor.x, y: anchor.y },
    radius,
    density: lerp(
      PHYSICS.chassis.ballast.minDensity,
      PHYSICS.chassis.ballast.maxDensity,
      clamp01(c.ballastDensity),
    ),
  };
}

function decodeWheel(w: WheelGene, vertexCount: number): DecodedWheel {
  return {
    radius: lerp(PHYSICS.wheel.minRadius, PHYSICS.wheel.maxRadius, clamp01(w.radius)),
    density: lerp(PHYSICS.wheel.minDensity, PHYSICS.wheel.maxDensity, clamp01(w.density)),
    attachVertex: clampInt(w.attachVertex, 0, vertexCount - 1),
    motorTorqueFraction: clamp01(w.motorTorque),
    friction: lerp(PHYSICS.wheel.minFriction, PHYSICS.wheel.maxFriction, clamp01(w.friction)),
    restitution: lerp(
      PHYSICS.wheel.minRestitution,
      PHYSICS.wheel.maxRestitution,
      clamp01(w.restitution),
    ),
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
  const angleOffsets: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    radii.push(rng());
    angleOffsets.push(rng());
  }

  const wheels: WheelGene[] = [];
  for (let i = 0; i < wheelCount; i++) {
    wheels.push({
      radius: rng(),
      density: rng(),
      attachVertex: rngInt(rng, 0, vertexCount - 1),
      motorTorque: rngRange(rng, 0.4, 1.0),
      // Mid-band defaults so the very first generation has middle-of-the-road
      // grip — evolution should explore from there, not from random extremes.
      friction: rngRange(rng, 0.3, 0.8),
      restitution: rngRange(rng, 0.0, 0.4),
    });
  }

  return {
    version: 3,
    chassis: {
      vertexCount,
      radii,
      angleOffsets,
      density: rng(),
      ballastVertex: rngInt(rng, 0, vertexCount - 1),
      // Half of generation zero is born with no ballast — the threshold
      // is at 0.4 in normalized space.
      ballastSize: rng(),
      ballastDensity: rng(),
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
