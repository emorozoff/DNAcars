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
import { decodeGenome, PHYSICS, type DecodedCar } from './genome';

/* ─── Constants ─────────────────────────────────────────────────────────── */

/** Fixed timestep matching the world's physics clock. */
export const SIM_DT = 1 / 60;

/**
 * Health rules.  A car dies if any of these hold:
 *   (a) full stop      — speed near zero for `initialSeconds` of stall.
 *   (b) no progress    — less than `progressWindowMin` over a sliding
 *                        `progressWindowSec` window (catches creeping cars).
 *   (c) rolled over    — |chassis.angle| > 110° for `rolledLimitSec` seconds.
 *
 * "Body dragging" no longer needs its own rule: the chassis is now
 * frictionless, so a car on its roof simply slides until it stalls and
 * dies via (a) or (b).
 */
export const HEALTH = {
  initialSeconds: 5,
  progressEpsilon: 0.02,
  stallSpeed: 0.2,
  stallDrainPerSecond: 8,
  progressWindowSec: 4,
  progressWindowMin: 1.5,
  graceSec: 2.5,
  /** |angle| above this counts as rolled-over (rad). 100° = 1.745rad. */
  rolledAngleRad: (100 * Math.PI) / 180,
  /** Allowed time rolled over before death. */
  rolledLimitSec: 0.5,
  /**
   * If no wheel has touched the ground for this long, the car dies.
   * Catches "drives without wheels on the road" cases that the slippery
   * chassis still allowed (e.g. coasting on a slope after a flip).
   */
  noWheelContactLimitSec: 2.5,
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
  /** Distance traveled from this car's spawn point, in meters. */
  travel: number;
  /** Same as travel but frozen at death. */
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
  chassisCollider: RAPIER.Collider;
  wheels: {
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    joint: RAPIER.ImpulseJoint;
    radius: number;
  }[];
  health: number;
  alive: boolean;
  /** Once true, never read from chassis/wheel bodies again. */
  bodiesReleased: boolean;
  score: number;
  spawnX: number;
  maxX: number;
  /** Total simulated time the car has been alive, seconds. */
  ageSec: number;
  /** Sim time at which the current sliding progress window started. */
  windowStartTime: number;
  /** maxX recorded at the start of the current window. */
  windowStartX: number;
  /** Seconds spent rolled over (|angle| > 110°). */
  rolledSec: number;
  /** Sim time when at least one wheel last touched the ground. */
  lastWheelContactSec: number;
  vertices: { x: number; y: number }[];
  /** Frozen snapshot taken at the moment of death — read forever after. */
  finalSnapshot: CarSnapshot | null;
};

export async function createWorld(opts: CreateWorldOptions): Promise<WorldHandle> {
  await ensureRapier();

  const gravity = { x: 0, y: -(opts.gravity ?? 9.81) };
  const world = new RAPIER.World(gravity);
  // Match SIM_DT.  Rapier's default is also 1/60 but be explicit for parity
  // across versions.
  world.timestep = SIM_DT;

  // We keep the ground collider for collision but no longer query it for
  // ground checks — sampleTrackY is the source of truth.
  buildTrack(world, opts.track);

  // All cars share the same spawn coordinate.  We start them well clear
  // of the left edge of the track (12 m by default) so a car that gets
  // bumped backwards has somewhere safe to fall instead of off the world.
  const sx = opts.spawnX ?? 12;
  const sy = (opts.spawnY ?? 0) + sampleTrackY(opts.track, sx) + 2;

  const cars: CarRuntime[] = opts.genomes.map((genome, index) =>
    buildCar(world, genome, index, sx, sy),
  );

  let time = 0;

  const gravityMag = Math.abs(gravity.y);

  return {
    step(): void {
      for (const car of cars) {
        if (!car.alive) continue;
        applyMotor(car, gravityMag, opts.track);
      }
      world.step();
      time += SIM_DT;
      for (const car of cars) {
        if (!car.alive) continue;
        const updated = updateLifecycle(car);
        if (!updated.alive) {
          // Freeze the last visible state, then release Rapier resources.
          car.finalSnapshot = snapshotLiveCar(car);
          destroyCar(world, car);
        }
      }
    },

    snapshot(): WorldSnapshot {
      return {
        time,
        cars: cars.map((c) =>
          c.bodiesReleased ? (c.finalSnapshot ?? deadStub(c)) : snapshotLiveCar(c),
        ),
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
    .setFriction(1.0)
    .setRestitution(0.05)
    .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CAR_BODY | GROUP.CAR_WHEEL))
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  world.createCollider(colliderDesc, ground);

  // Back wall at x = 0 so cars that get bumped backwards can't roll off
  // the start of the track and rack up "negative distance".
  const startWallHalfHeight = 6;
  const startWallHalfThickness = 0.05;
  const startWallDesc = RAPIER.ColliderDesc.cuboid(startWallHalfThickness, startWallHalfHeight)
    .setTranslation(-startWallHalfThickness, startWallHalfHeight)
    .setFriction(0)
    .setRestitution(0)
    .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CAR_BODY | GROUP.CAR_WHEEL));
  world.createCollider(startWallDesc, ground);

  // Finish wall: a tall vertical cuboid right at the finish line, so cars
  // can't run off the end of the world and "earn" infinite distance.  The
  // wall is in the same TRACK collision group, so wheels and the chassis
  // both bounce off it.
  const last = track.points[track.points.length - 1]!;
  const wallHalfHeight = 4;
  const wallHalfThickness = 0.05;
  const wallDesc = RAPIER.ColliderDesc.cuboid(wallHalfThickness, wallHalfHeight)
    .setTranslation(last.x + wallHalfThickness, last.y + wallHalfHeight)
    .setFriction(0.4)
    .setRestitution(0)
    .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CAR_BODY | GROUP.CAR_WHEEL));
  world.createCollider(wallDesc, ground);
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
  // Linear damping is high so a car without traction loses momentum
  // quickly — the user shouldn't see "inertial coast on the roof".
  // Angular damping is moderate: enough to calm out random wobble, but
  // not enough to magically keep the car upright.
  const chassisBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawnX, spawnY)
    .setLinearDamping(0.5)
    .setAngularDamping(0.3)
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

  // Friction = 0 on purpose: only wheels are allowed to push the car
  // forward.  A perfectly slippery body cannot grip the track, so a
  // toppled car simply slides instead of "scrubbing" itself along.
  chassisColliderDesc
    .setDensity(decoded.chassis.density)
    .setFriction(0)
    .setRestitution(0)
    .setCollisionGroups(packGroups(GROUP.CAR_BODY, GROUP.TRACK));

  const chassisCollider = world.createCollider(chassisColliderDesc, chassis);

  // Wheels ─────────────────────────────────────────────────────────────
  const wheels: CarRuntime['wheels'] = [];
  // Filter wheel genes so that no two wheels share an attachment vertex
  // and no two wheels overlap geometrically.  Caps total wheels at 4.
  const usedAnchors: { x: number; y: number; r: number }[] = [];
  const acceptedWheelGenes: typeof decoded.wheels = [];
  for (const wheelGene of decoded.wheels) {
    if (acceptedWheelGenes.length >= 4) break;
    const anchor = decoded.chassis.vertices[wheelGene.attachVertex];
    if (!anchor) continue;
    let conflict = false;
    for (const u of usedAnchors) {
      const dx = anchor.x - u.x;
      const dy = anchor.y - u.y;
      const dist = Math.hypot(dx, dy);
      // 0.85 leaves a small visual gap between wheels.
      if (dist < (wheelGene.radius + u.r) * 0.85) {
        conflict = true;
        break;
      }
    }
    if (conflict) continue;
    usedAnchors.push({ x: anchor.x, y: anchor.y, r: wheelGene.radius });
    acceptedWheelGenes.push(wheelGene);
  }

  for (const wheelGene of acceptedWheelGenes) {
    const anchor = decoded.chassis.vertices[wheelGene.attachVertex] ?? { x: 0, y: 0 };

    const wheelBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX + anchor.x, spawnY + anchor.y)
      .setLinearDamping(0.05)
      .setAngularDamping(0.05)
      .setCcdEnabled(true);
    const wheelBody = world.createRigidBody(wheelBodyDesc);

    const wheelColliderDesc = RAPIER.ColliderDesc.ball(wheelGene.radius)
      .setDensity(wheelGene.density)
      .setFriction(PHYSICS.wheel.friction)
      .setRestitution(0)
      .setCollisionGroups(packGroups(GROUP.CAR_WHEEL, GROUP.TRACK))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    const wheelCollider = world.createCollider(wheelColliderDesc, wheelBody);

    const jointParams = RAPIER.JointData.revolute({ x: anchor.x, y: anchor.y }, { x: 0, y: 0 });
    const joint = world.createImpulseJoint(jointParams, chassis, wheelBody, true);

    wheels.push({ body: wheelBody, collider: wheelCollider, joint, radius: wheelGene.radius });
  }

  return {
    index,
    decoded,
    chassis,
    chassisCollider,
    wheels,
    health: HEALTH.initialSeconds,
    alive: true,
    bodiesReleased: false,
    score: 0,
    spawnX,
    maxX: spawnX,
    ageSec: 0,
    windowStartTime: 0,
    windowStartX: spawnX,
    rolledSec: 0,
    lastWheelContactSec: 0,
    vertices: decoded.chassis.vertices,
    finalSnapshot: null,
  };
}

/**
 * Forward-only motor.  For each wheel:
 *   1. Compare the wheel's bottom (centre.y - radius) to the track height
 *      at the wheel's x position.  Within 6 cm tolerance → wheel on ground.
 *   2. If on ground, apply torque toward the target angular velocity.
 *   3. Otherwise the engine produces no force.
 *
 * Why a height-sample instead of a raycast?  `castRay` in
 * @dimforge/rapier2d-compat occasionally fails to register hits on the
 * polyline track, causing the motor to spin freely and "pull" the car.
 * Sampling the track polyline directly is a few cycles slower but
 * 100 % deterministic — which is what the user is asking for.
 */
function applyMotor(car: CarRuntime, gravity: number, track: Track): void {
  const targetOmega = -car.decoded.motor.baseSpeed;
  const totalMass = totalMassOf(car);
  let anyOnGround = false;

  for (let i = 0; i < car.wheels.length; i++) {
    const w = car.wheels[i]!;
    const wheelGene = car.decoded.wheels[i]!;

    const onGround = isWheelOnGround(w.body, w.radius, track);
    if (onGround) anyOnGround = true;

    if (wheelGene.motorTorqueFraction <= 0) continue;
    if (!onGround) continue;

    const currentOmega = w.body.angvel();
    const error = targetOmega - currentOmega;
    const maxTorque =
      wheelGene.motorTorqueFraction *
      totalMass *
      gravity *
      Math.max(0.15, w.radius) *
      PHYSICS.motor.torqueHeadroom;
    const torque = clamp(error * 8, -maxTorque, maxTorque);
    w.body.addTorque(torque, true);
  }

  if (anyOnGround) {
    car.lastWheelContactSec = car.ageSec;
  }
}

/**
 * True iff the wheel is *resting on* the track surface — within 6 cm of
 * it on either side.  Uses the polyline directly, no Rapier API.
 *
 * The two-sided check is on purpose: if a wheel ends up below the track
 * (joints can briefly push a wheel through a polyline because they
 * don't see contact constraints), we don't want the motor to keep
 * dragging the car along.  A real on-track wheel sits AT the surface,
 * not many centimetres under it.
 */
function isWheelOnGround(
  wheelBody: RAPIER.RigidBody,
  radius: number,
  track: Track,
): boolean {
  const t = wheelBody.translation();
  if (t.x < 0 || t.x > track.options.length) return false;
  const trackY = sampleTrackY(track, t.x);
  const wheelBottom = t.y - radius;
  return Math.abs(wheelBottom - trackY) <= 0.06;
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
  const angle = normalizeAngle(car.chassis.rotation());
  car.ageSec += SIM_DT;

  // (a) Stall-based health: refill on real progress, drain otherwise.
  if (pos.x > car.maxX + HEALTH.progressEpsilon) {
    car.maxX = pos.x;
    car.health = HEALTH.initialSeconds;
  } else if (speed < HEALTH.stallSpeed) {
    car.health -= HEALTH.stallDrainPerSecond * SIM_DT;
  } else {
    car.health -= SIM_DT;
  }

  // (b) Sliding-window check.
  if (car.ageSec > HEALTH.graceSec) {
    const windowAge = car.ageSec - car.windowStartTime;
    if (windowAge >= HEALTH.progressWindowSec) {
      const progress = car.maxX - car.windowStartX;
      if (progress < HEALTH.progressWindowMin) car.health = 0;
      car.windowStartTime = car.ageSec;
      car.windowStartX = car.maxX;
    }
  }

  // (c) Roll-over: chassis tipped past 100° → tick the rolled-over timer.
  if (Math.abs(angle) > HEALTH.rolledAngleRad) {
    car.rolledSec += SIM_DT;
    if (car.rolledSec >= HEALTH.rolledLimitSec) car.health = 0;
  } else {
    car.rolledSec = Math.max(0, car.rolledSec - SIM_DT * 2);
  }

  // (d) No wheel contact for too long → death.  After grace, if the car
  // hasn't had a single wheel touch the track in `noWheelContactLimitSec`
  // seconds, it isn't really driving — kill it.
  if (
    car.ageSec > HEALTH.graceSec &&
    car.ageSec - car.lastWheelContactSec >= HEALTH.noWheelContactLimitSec
  ) {
    car.health = 0;
  }

  if (car.health <= 0) {
    car.alive = false;
    car.score = Math.max(0, car.maxX - car.spawnX);
  }
  return { alive: car.alive };
}

function normalizeAngle(a: number): number {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function destroyCar(world: RAPIER.World, car: CarRuntime): void {
  if (car.bodiesReleased) return;
  for (const w of car.wheels) {
    world.removeImpulseJoint(w.joint, true);
    world.removeRigidBody(w.body);
  }
  world.removeRigidBody(car.chassis);
  car.bodiesReleased = true;
}

/** Snapshot from live Rapier bodies — only safe before destruction. */
function snapshotLiveCar(car: CarRuntime): CarSnapshot {
  const pos = car.chassis.translation();
  const travel = Math.max(0, car.maxX - car.spawnX);
  return {
    index: car.index,
    alive: car.alive,
    travel,
    score: car.alive ? travel : car.score,
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

/** Fallback used if a car somehow gets released before we cached its snapshot. */
function deadStub(car: CarRuntime): CarSnapshot {
  return {
    index: car.index,
    alive: false,
    travel: car.score,
    score: car.score,
    health: 0,
    position: { x: car.maxX, y: 0 },
    angle: 0,
    vertices: car.vertices,
    wheels: car.wheels.map((w) => ({
      position: { x: car.maxX, y: 0 },
      angle: 0,
      radius: w.radius,
    })),
  };
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

/** Rapier interaction groups: high 16 bits = membership, low 16 bits = filter. */
function packGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}
