/**
 * World wrapper around Rapier2D.
 *
 * The whole simulation (track + cars) lives inside one Rapier `World`.
 * This module is intentionally headless — no rendering, no DOM.  It can run
 * in the main thread or in a Web Worker and is fully deterministic given
 * the same seed and same genomes.
 */

import RAPIER from '@dimforge/rapier2d-compat';
import type { Genome } from '@dnacars/shared';
import type { Track } from './track';
import { decodeGenome, type DecodedCar } from './genome';

/* ─── Constants ─────────────────────────────────────────────────────────── */

/** Fixed timestep matching the world's physics clock. */
export const SIM_DT = 1 / 60;

/**
 * Health rules — mirrors the spirit of the original "if you stop, you die",
 * but expressed in seconds rather than raw frames so it adapts to dt.
 */
export const HEALTH = {
  initialSeconds: 8,
  /** When the car advances by at least this much in meters, refill. */
  progressEpsilon: 0.02,
  /** Linear velocity below which we count the car as stalled. */
  stallSpeed: 0.1,
  /** Health drained per second when stalled. */
  stallDrainPerSecond: 5,
} as const;

/** Collision group bitmasks (membership / filter). */
const GROUP = {
  TRACK: 0x0001,
  CAR_BODY: 0x0002,
  CAR_WHEEL: 0x0004,
} as const;

/* ─── Public types ──────────────────────────────────────────────────────── */

export type WorldHandle = {
  /** Advances the world one fixed timestep. */
  step(): void;
  /** Per-car snapshot suitable for rendering or scoring. */
  snapshot(): WorldSnapshot;
  /** Disposes Rapier resources. Call once you no longer need the world. */
  destroy(): void;
};

export type WorldSnapshot = {
  time: number;
  cars: CarSnapshot[];
};

export type CarSnapshot = {
  index: number;
  alive: boolean;
  /** Final score in meters.  Equal to maxX when alive, frozen on death. */
  score: number;
  health: number;
  position: { x: number; y: number };
  angle: number;
  wheels: WheelSnapshot[];
  vertices: { x: number; y: number }[];
};

export type WheelSnapshot = {
  position: { x: number; y: number };
  angle: number;
  radius: number;
};

export type CreateWorldOptions = {
  track: Track;
  genomes: Genome[];
  gravity?: number;
  /** Spawn x position in meters (negative = before start of track). */
  spawnX?: number;
  spawnY?: number;
};

/* ─── Module init ───────────────────────────────────────────────────────── */

let initPromise: Promise<void> | null = null;

/**
 * Initialise Rapier WASM once per process.  Subsequent calls return the
 * same in-flight promise.
 */
export function ensureRapier(): Promise<void> {
  if (!initPromise) {
    initPromise = RAPIER.init();
  }
  return initPromise;
}

/* ─── Implementation ────────────────────────────────────────────────────── */

type CarRuntime = {
  index: number;
  decoded: DecodedCar;
  chassis: RAPIER.RigidBody;
  wheels: { body: RAPIER.RigidBody; joint: RAPIER.ImpulseJoint; radius: number }[];
  health: number;
  alive: boolean;
  score: number;
  maxX: number;
  vertices: { x: number; y: number }[];
};

export async function createWorld(opts: CreateWorldOptions): Promise<WorldHandle> {
  await ensureRapier();

  const gravity = { x: 0, y: -(opts.gravity ?? 9.81) };
  const world = new RAPIER.World(gravity);
  // Match SIM_DT.  Rapier's default is also 1/60 but be explicit for parity
  // across versions.
  world.timestep = SIM_DT;

  buildTrack(world, opts.track);

  // Stagger cars horizontally so they don't pile up at spawn.  Each car gets
  // its own slot ~1.5m wide.  All cars race on the same track but start
  // their counter from their own spawnX.
  const baseSpawnX = opts.spawnX ?? 0;
  const baseSpawnY = (opts.spawnY ?? 0) + 1.6;
  const SLOT = 1.5;

  const cars: CarRuntime[] = opts.genomes.map((genome, index) => {
    const sx = baseSpawnX + index * SLOT;
    const sy = baseSpawnY + sampleTrackY(opts.track, sx);
    return buildCar(world, genome, index, sx, sy);
  });

  let time = 0;

  const gravityMag = Math.abs(gravity.y);

  return {
    step(): void {
      for (const car of cars) {
        if (!car.alive) continue;
        applyMotor(car, gravityMag);
      }
      world.step();
      time += SIM_DT;
      for (const car of cars) {
        if (!car.alive) continue;
        const updated = updateLifecycle(car);
        if (!updated.alive) destroyCar(world, car);
      }
    },

    snapshot(): WorldSnapshot {
      return {
        time,
        cars: cars.map((c) => snapshotCar(c)),
      };
    },

    destroy(): void {
      world.free();
    },
  };
}

/* ─── Track construction ────────────────────────────────────────────────── */

/** Linear sample of track height at world x. */
function sampleTrackY(track: Track, x: number): number {
  const { step } = track.options;
  if (x <= 0) return 0;
  const i = Math.floor(x / step);
  const a = track.points[i];
  const b = track.points[i + 1];
  if (!a) return 0;
  if (!b) return a.y;
  const t = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

function buildTrack(world: RAPIER.World, track: Track): void {
  const groundDesc = RAPIER.RigidBodyDesc.fixed();
  const ground = world.createRigidBody(groundDesc);

  const flat = new Float32Array(track.points.length * 2);
  for (let i = 0; i < track.points.length; i++) {
    const p = track.points[i]!;
    flat[i * 2] = p.x;
    flat[i * 2 + 1] = p.y;
  }

  const colliderDesc = RAPIER.ColliderDesc.polyline(flat)
    .setFriction(0.85)
    .setRestitution(0.05)
    .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CAR_BODY | GROUP.CAR_WHEEL));

  world.createCollider(colliderDesc, ground);
}

/* ─── Car construction ──────────────────────────────────────────────────── */

function buildCar(
  world: RAPIER.World,
  genome: Genome,
  index: number,
  spawnX: number,
  spawnY: number,
): CarRuntime {
  const decoded = decodeGenome(genome);

  // Chassis ────────────────────────────────────────────────────────────
  const chassisBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawnX, spawnY)
    .setLinearDamping(0.0)
    .setAngularDamping(0.0)
    .setCcdEnabled(true);
  const chassis = world.createRigidBody(chassisBodyDesc);

  const flatVerts = new Float32Array(decoded.chassis.vertices.length * 2);
  for (let i = 0; i < decoded.chassis.vertices.length; i++) {
    const v = decoded.chassis.vertices[i]!;
    flatVerts[i * 2] = v.x;
    flatVerts[i * 2 + 1] = v.y;
  }

  const chassisColliderDesc =
    RAPIER.ColliderDesc.convexHull(flatVerts) ??
    RAPIER.ColliderDesc.ball(0.5); /* hull may be null on degenerate input */

  chassisColliderDesc
    .setDensity(decoded.chassis.density)
    .setFriction(0.9)
    .setRestitution(0.05)
    .setCollisionGroups(packGroups(GROUP.CAR_BODY, GROUP.TRACK));

  world.createCollider(chassisColliderDesc, chassis);

  // Wheels ─────────────────────────────────────────────────────────────
  const wheels: CarRuntime['wheels'] = [];
  for (const wheelGene of decoded.wheels) {
    const anchor = decoded.chassis.vertices[wheelGene.attachVertex] ?? { x: 0, y: 0 };

    const wheelBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX + anchor.x, spawnY + anchor.y)
      .setLinearDamping(0.0)
      .setAngularDamping(0.05)
      .setCcdEnabled(true);
    const wheelBody = world.createRigidBody(wheelBodyDesc);

    const wheelColliderDesc = RAPIER.ColliderDesc.ball(wheelGene.radius)
      .setDensity(wheelGene.density)
      .setFriction(wheelGene.friction)
      .setRestitution(0.05)
      .setCollisionGroups(packGroups(GROUP.CAR_WHEEL, GROUP.TRACK));

    world.createCollider(wheelColliderDesc, wheelBody);

    const jointParams = RAPIER.JointData.revolute({ x: anchor.x, y: anchor.y }, { x: 0, y: 0 });
    const joint = world.createImpulseJoint(jointParams, chassis, wheelBody, true);

    wheels.push({ body: wheelBody, joint, radius: wheelGene.radius });
  }

  return {
    index,
    decoded,
    chassis,
    wheels,
    health: HEALTH.initialSeconds,
    alive: true,
    score: 0,
    maxX: spawnX,
    vertices: decoded.chassis.vertices,
  };
}

/**
 * Drive each wheel via a P-controller on its angular velocity, applied
 * directly through `applyTorqueImpulse`.  This is more portable across
 * Rapier versions than relying on the joint motor.
 */
function applyMotor(car: CarRuntime, gravity: number): void {
  const m = car.decoded.motor;
  const targetOmega = -m.baseSpeed * m.gearRatio;
  const totalMass = totalMassOf(car);

  for (let i = 0; i < car.wheels.length; i++) {
    const w = car.wheels[i]!;
    const wheelGene = car.decoded.wheels[i]!;
    if (wheelGene.motorTorqueFraction <= 0) continue;

    const currentOmega = w.body.angvel();
    const error = targetOmega - currentOmega;
    // Max torque sized to be able to lift the whole car on a slope.
    const maxTorque =
      wheelGene.motorTorqueFraction * totalMass * gravity * Math.max(0.15, w.radius) * 2.5;
    // Aggressive P-gain so the wheel reaches target speed within ~0.3s.
    const torque = clamp(error * 8, -maxTorque, maxTorque);
    w.body.addTorque(torque, true);
    // Reaction on the chassis — slight body roll on acceleration.
    car.chassis.addTorque(-torque * 0.15, true);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function totalMassOf(car: CarRuntime): number {
  let m = car.chassis.mass();
  for (const w of car.wheels) m += w.body.mass();
  return m;
}

function updateLifecycle(car: CarRuntime): { alive: boolean } {
  const pos = car.chassis.translation();
  const vel = car.chassis.linvel();
  const speed = Math.hypot(vel.x, vel.y);

  if (pos.x > car.maxX + HEALTH.progressEpsilon) {
    car.maxX = pos.x;
    car.health = HEALTH.initialSeconds;
  } else {
    if (speed < HEALTH.stallSpeed) {
      car.health -= HEALTH.stallDrainPerSecond * SIM_DT;
    } else {
      car.health -= SIM_DT;
    }
  }

  if (car.health <= 0) {
    car.alive = false;
    car.score = car.maxX;
  }
  return { alive: car.alive };
}

function destroyCar(world: RAPIER.World, car: CarRuntime): void {
  for (const w of car.wheels) {
    world.removeImpulseJoint(w.joint, true);
    world.removeRigidBody(w.body);
  }
  world.removeRigidBody(car.chassis);
}

function snapshotCar(car: CarRuntime): CarSnapshot {
  const pos = car.chassis.translation();
  return {
    index: car.index,
    alive: car.alive,
    score: car.alive ? car.maxX : car.score,
    health: car.health,
    position: { x: pos.x, y: pos.y },
    angle: car.chassis.rotation(),
    vertices: car.vertices,
    wheels: car.wheels.map((w) => {
      const wp = w.body.translation();
      return {
        position: { x: wp.x, y: wp.y },
        angle: w.body.rotation(),
        radius: w.radius,
      };
    }),
  };
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

/** Rapier interaction groups: high 16 bits = membership, low 16 bits = filter. */
function packGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}
