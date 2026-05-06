/**
 * Stand-alone 2D car-physics demo.
 *
 * Random polygonal cars on a long, hilly track.  Every car always
 * holds full throttle.  There is *no* death, no crash detection — bad
 * shapes simply fail to drive.  The physics rules that filter "good"
 * shapes from "bad" ones are:
 *
 *   1. High-friction chassis (0.8) brakes a toppled body hard against
 *      the track, so a car that's fallen on its hull stops moving
 *      instead of sliding along.
 *   2. The motor only fires for wheels actually touching the polyline
 *      (sampled directly from the track curve).
 *   3. The motor requires *two* grounded wheels, with a real wheelbase
 *      (≥0.4 m) between them.  A single contact point lets the wheel
 *      motor's reaction torque on the chassis (Newton 3 via the joint)
 *      cancel gravity at some tilt — the car drives on one wheel
 *      forever.  Two contact points constrain that DOF away, but only
 *      if they're far enough apart to actually act as a wheelbase.
 *   4. Heavy chassis (250–450 kg/m²) vs light wheels (30–80) keeps
 *      the centre of gravity low.  Balanced shapes are stable;
 *      narrow-base shapes flip naturally on slopes.
 */

import RAPIER from '@dimforge/rapier2d-compat';

/* ─── Constants ─────────────────────────────────────────────────────────── */

export const SIM_DT = 1 / 60;
export const GRAVITY = 9.81;

export const TUNING = {
  chassis: {
    minVertices: 5,
    maxVertices: 10,
    minRadius: 0.35,
    maxRadius: 1.0,
    minDensity: 250,
    maxDensity: 450,
    /**
     * High body friction so a toppled car drags against the track and
     * stops moving instead of sliding indefinitely down a slope.  The
     * motor never engages from the body anyway (only grounded wheels
     * apply torque), so this is purely a brake.
     */
    friction: 0.8,
    restitution: 0.0,
    linearDamping: 0.4,
    angularDamping: 0.2,
  },
  wheel: {
    minCount: 1,
    maxCount: 4,
    minRadius: 0.18,
    maxRadius: 0.7,
    /**
     * Per-wheel "power" gene (0..1) drives mass, motor strength and
     * visual stroke width together — the trio of {light, weak, thin}
     * vs {heavy, strong, thick}.  A car can't pick "powerful but
     * light" or "heavy but weak"; the three traits are bound so the
     * player can read a wheel's power off its line thickness alone.
     */
    minDensity: 50,
    maxDensity: 400,
    minMotorFrac: 0.2,
    maxMotorFrac: 1.0,
    /** Visual stroke width range (world metres, multiplied by render zoom). */
    minStroke: 0.03,
    maxStroke: 0.12,
    friction: 1.6,
    restitution: 0.0,
    linearDamping: 0.05,
    angularDamping: 0.05,
  },
  motor: {
    minSpeed: 10,
    maxSpeed: 24,
    torqueHeadroom: 1.8,
    feedbackGain: 7,
    /** Beyond this chassis tilt the motor is gated off. */
    maxChassisTilt: (45 * Math.PI) / 180,
    /**
     * Minimum span between any two grounded wheels (m) for the motor to
     * fire.  Two wheels attached to nearby chassis vertices both touch
     * the ground at almost the same point and form a near-zero
     * "wheelbase".  Geometrically the two contact points lock the
     * chassis orientation perfectly — the car can't tip over no matter
     * what — and the engine pushes it along forever.  Requiring a real
     * wheelbase rejects this degenerate shape.
     */
    minGroundedSpan: 0.4,
  },
  contact: {
    /** Max distance from track surface to count a wheel as "on ground". */
    wheelTolerance: 0.06,
  },
  lifecycle: {
    /** Speed below which a car counts as "not moving" (m/s). */
    stallSpeed: 0.15,
    /** Continuous stall time after which a car's run is finished (s). */
    stallSeconds: 5,
    /**
     * Hard cap on a single generation's wall time (s).  If for any
     * reason cars keep moving for this long without anyone finishing,
     * we force-finish all of them and move on so evolution doesn't
     * grind to a halt on a degenerate seed.
     */
    maxGenerationSec: 60,
    /** Grace period at the start of each car's run before stall logic kicks in (s). */
    graceSeconds: 1.5,
  },
} as const;

const GROUP = {
  TRACK: 0x0001,
  CHASSIS: 0x0002,
  WHEEL: 0x0004,
} as const;

/* ─── Rapier init ──────────────────────────────────────────────────────── */

let initPromise: Promise<void> | null = null;
export function ensureRapier(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

/* ─── PRNG ─────────────────────────────────────────────────────────────── */

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/* ─── Track ────────────────────────────────────────────────────────────── */

export type TrackOptions = {
  length: number;
  step: number;
  warmup: number;
  amplitude: number;
};

export type Track = {
  options: TrackOptions;
  points: { x: number; y: number }[];
};

const DEFAULT_TRACK: TrackOptions = {
  length: 1500,
  step: 0.6,
  warmup: 25,
  amplitude: 5.0,
};

export function generateTrack(seed: number, opts: Partial<TrackOptions> = {}): Track {
  const o: TrackOptions = { ...DEFAULT_TRACK, ...opts };
  const rng = makeRng(seed);
  const layers = [
    { freq: 0.16, phase: rng() * Math.PI * 2, weight: 0.55 },
    { freq: 0.16 * 1.618, phase: rng() * Math.PI * 2, weight: 0.3 },
    { freq: 0.16 * 1.618 * 1.618, phase: rng() * Math.PI * 2, weight: 0.18 },
  ];
  const drift = { freq: 0.018, phase: rng() * Math.PI * 2, weight: 0.7 };

  const points: { x: number; y: number }[] = [];
  for (let x = 0; x <= o.length + 1e-4; x += o.step) {
    const ramp = smoothstep(0, o.warmup, x);
    let y = 0;
    for (const l of layers) y += Math.sin(x * l.freq + l.phase) * l.weight;
    y += Math.sin(x * drift.freq + drift.phase) * drift.weight;
    y *= ramp * o.amplitude;
    points.push({ x, y });
  }
  if (points[0]) points[0].y = 0;
  return { options: o, points };
}

function smoothstep(a: number, b: number, x: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

export function sampleTrackY(track: Track, x: number): number {
  const { step, length } = track.options;
  if (x <= 0) return track.points[0]?.y ?? 0;
  if (x >= length) return track.points[track.points.length - 1]?.y ?? 0;
  const i = Math.floor(x / step);
  const a = track.points[i];
  const b = track.points[i + 1];
  if (!a) return 0;
  if (!b) return a.y;
  const t = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

/* ─── Genome (random car shape) ───────────────────────────────────────── */

export type WheelGene = {
  attachVertex: number;
  /** Wheel radius in metres — independent gene. */
  radius: number;
  /**
   * Single power scalar in [0,1] that decides mass, motor strength
   * and visual line thickness all at once.  0 = thin/weak/light,
   * 1 = thick/strong/heavy.  See TUNING.wheel for the absolute ranges
   * each axis is mapped to.
   */
  power: number;
};

export type Genome = {
  chassisVertexCount: number;
  chassisRadii: number[];
  chassisDensity: number;
  wheels: WheelGene[];
  motorSpeed: number;
};

export function randomGenome(rng: Rng): Genome {
  const n = randInt(rng, TUNING.chassis.minVertices, TUNING.chassis.maxVertices);
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    radii.push(lerp(TUNING.chassis.minRadius, TUNING.chassis.maxRadius, rng()));
  }
  const wheelCount = randInt(rng, TUNING.wheel.minCount, TUNING.wheel.maxCount);
  const wheels: WheelGene[] = [];
  for (let i = 0; i < wheelCount; i++) {
    wheels.push({
      attachVertex: randInt(rng, 0, n - 1),
      radius: lerp(TUNING.wheel.minRadius, TUNING.wheel.maxRadius, rng()),
      power: rng(),
    });
  }
  return {
    chassisVertexCount: n,
    chassisRadii: radii,
    chassisDensity: lerp(TUNING.chassis.minDensity, TUNING.chassis.maxDensity, rng()),
    wheels,
    motorSpeed: lerp(TUNING.motor.minSpeed, TUNING.motor.maxSpeed, rng()),
  };
}

function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function chassisVertices(g: Genome): { x: number; y: number }[] {
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < g.chassisVertexCount; i++) {
    const angle = ((i + 0.5) / g.chassisVertexCount) * Math.PI * 2;
    const r = g.chassisRadii[i] ?? 0.5;
    verts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  return verts;
}

/* ─── Per-car runtime ──────────────────────────────────────────────────── */

type WheelRuntime = {
  body: RAPIER.RigidBody;
  joint: RAPIER.ImpulseJoint;
  radius: number;
  /** Cached genome power scalar 0..1, surfaced on snapshot for the renderer. */
  power: number;
  /** Pre-computed motor-torque fraction (mapped from power at build time). */
  motorTorque: number;
  onGround: boolean;
};

type CarRuntime = {
  index: number;
  genome: Genome;
  vertices: { x: number; y: number }[];
  chassis: RAPIER.RigidBody;
  wheels: WheelRuntime[];
  spawnX: number;
  maxX: number;
  /** Total simulated time the car has been in the world (s). */
  ageSec: number;
  /** Continuous stall time (s) — reset when the car makes progress. */
  stallTimer: number;
  /** Once true, motor is off and bodies are pinned in place forever. */
  finished: boolean;
};

export type CarSnapshot = {
  index: number;
  position: { x: number; y: number };
  angle: number;
  speed: number;
  /** Distance from spawn, in metres.  Frozen at the moment the car finished. */
  travel: number;
  finished: boolean;
  vertices: { x: number; y: number }[];
  wheels: {
    position: { x: number; y: number };
    angle: number;
    radius: number;
    /** 0..1 power scalar — drives wheel-stroke thickness in the renderer. */
    power: number;
    onGround: boolean;
  }[];
};

export type WorldSnapshot = {
  time: number;
  cars: CarSnapshot[];
};

/* ─── World ────────────────────────────────────────────────────────────── */

export type WorldHandle = {
  step(): void;
  snapshot(): WorldSnapshot;
  allFinished(): boolean;
  forceFinishAll(): void;
  destroy(): void;
};

export type CreateWorldOptions = {
  track: Track;
  genomes: Genome[];
  spawnX?: number;
};

export async function createWorld(opts: CreateWorldOptions): Promise<WorldHandle> {
  await ensureRapier();
  const world = new RAPIER.World({ x: 0, y: -GRAVITY });
  world.timestep = SIM_DT;

  buildTrackColliders(world, opts.track);

  const sx = opts.spawnX ?? 8;
  const sy = sampleTrackY(opts.track, sx) + 1.6;

  const cars: CarRuntime[] = opts.genomes.map((g, i) => buildCar(world, g, i, sx, sy));

  let time = 0;

  return {
    step(): void {
      for (const car of cars) {
        if (car.finished) {
          // Pinned: zero out velocities so the wreckage doesn't drift.
          freezeCar(car);
          continue;
        }
        updateWheelContacts(car, opts.track);
        applyMotor(car);
      }
      world.step();
      time += SIM_DT;
      for (const car of cars) {
        if (car.finished) continue;
        car.ageSec += SIM_DT;
        const x = car.chassis.translation().x;
        if (x > car.maxX) car.maxX = x;
        updateLifecycle(car);
      }
    },
    snapshot(): WorldSnapshot {
      return { time, cars: cars.map(snapshotCar) };
    },
    /**
     * True when no car can still earn distance — every one has either
     * stalled out or rolled past the finish line.  The caller uses this
     * to know it's safe to start the next generation.
     */
    allFinished(): boolean {
      for (const car of cars) if (!car.finished) return false;
      return true;
    },
    /**
     * Force every still-running car to finish *now*.  Used by the host
     * tick loop as a hard cap on generation length, so a degenerate
     * seed where everyone keeps drifting can't stall evolution.
     */
    forceFinishAll(): void {
      for (const car of cars) {
        if (!car.finished) car.finished = true;
      }
    },
    destroy(): void {
      world.free();
    },
  };
}

/* ─── Track colliders ──────────────────────────────────────────────────── */

function buildTrackColliders(world: RAPIER.World, track: Track): void {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // Track surface is a thin polyline.  CCD on the chassis and wheels
  // is enough to prevent tunneling at our speeds and step size — no
  // need for a thicker ground volume.
  const flat = new Float32Array(track.points.length * 2);
  for (let i = 0; i < track.points.length; i++) {
    const p = track.points[i]!;
    flat[i * 2] = p.x;
    flat[i * 2 + 1] = p.y;
  }
  world.createCollider(
    RAPIER.ColliderDesc.polyline(flat)
      .setFriction(1.0)
      .setRestitution(0.05)
      .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CHASSIS | GROUP.WHEEL)),
    ground,
  );

  // Back wall at x=0 so a car bumped backwards can't roll off the world.
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.05, 8)
      .setTranslation(-0.05, 8)
      .setFriction(0)
      .setRestitution(0)
      .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CHASSIS | GROUP.WHEEL)),
    ground,
  );
}

/* ─── Car builder ──────────────────────────────────────────────────────── */

function buildCar(
  world: RAPIER.World,
  genome: Genome,
  index: number,
  spawnX: number,
  spawnY: number,
): CarRuntime {
  const verts = chassisVertices(genome);

  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX, spawnY)
      .setLinearDamping(TUNING.chassis.linearDamping)
      .setAngularDamping(TUNING.chassis.angularDamping)
      .setCcdEnabled(true),
  );

  const flatVerts = new Float32Array(verts.length * 2);
  for (let i = 0; i < verts.length; i++) {
    flatVerts[i * 2] = verts[i]!.x;
    flatVerts[i * 2 + 1] = verts[i]!.y;
  }
  const hullDesc = RAPIER.ColliderDesc.convexHull(flatVerts) ?? RAPIER.ColliderDesc.ball(0.5);
  hullDesc
    .setDensity(genome.chassisDensity)
    .setFriction(TUNING.chassis.friction)
    .setRestitution(TUNING.chassis.restitution)
    .setCollisionGroups(packGroups(GROUP.CHASSIS, GROUP.TRACK));
  world.createCollider(hullDesc, chassis);

  // De-duplicate wheels: skip those sharing an attachment vertex with an
  // already-accepted wheel, or those that overlap geometrically.
  const accepted: WheelGene[] = [];
  const usedAnchors: { x: number; y: number; r: number }[] = [];
  for (const wg of genome.wheels) {
    const anchor = verts[wg.attachVertex];
    if (!anchor) continue;
    let conflict = false;
    for (const u of usedAnchors) {
      const d = Math.hypot(anchor.x - u.x, anchor.y - u.y);
      if (d < (wg.radius + u.r) * 0.85) {
        conflict = true;
        break;
      }
    }
    if (conflict) continue;
    usedAnchors.push({ x: anchor.x, y: anchor.y, r: wg.radius });
    accepted.push(wg);
  }

  const wheels: WheelRuntime[] = accepted.map((wg) => {
    const anchor = verts[wg.attachVertex]!;
    // Map the single 0..1 power gene onto the three concrete physical
    // axes — mass, motor strength, visual stroke width.
    const density = lerp(TUNING.wheel.minDensity, TUNING.wheel.maxDensity, wg.power);
    const motorTorque = lerp(TUNING.wheel.minMotorFrac, TUNING.wheel.maxMotorFrac, wg.power);
    const wb = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawnX + anchor.x, spawnY + anchor.y)
        .setLinearDamping(TUNING.wheel.linearDamping)
        .setAngularDamping(TUNING.wheel.angularDamping)
        .setCcdEnabled(true),
    );
    world.createCollider(
      RAPIER.ColliderDesc.ball(wg.radius)
        .setDensity(density)
        .setFriction(TUNING.wheel.friction)
        .setRestitution(TUNING.wheel.restitution)
        .setCollisionGroups(packGroups(GROUP.WHEEL, GROUP.TRACK)),
      wb,
    );
    const joint = world.createImpulseJoint(
      RAPIER.JointData.revolute({ x: anchor.x, y: anchor.y }, { x: 0, y: 0 }),
      chassis,
      wb,
      true,
    );
    return {
      body: wb,
      joint,
      radius: wg.radius,
      power: wg.power,
      motorTorque,
      onGround: false,
    };
  });

  return {
    index,
    genome,
    vertices: verts,
    chassis,
    wheels,
    spawnX,
    maxX: spawnX,
    ageSec: 0,
    stallTimer: 0,
    finished: false,
  };
}

/* ─── Per-tick logic ───────────────────────────────────────────────────── */

function updateWheelContacts(car: CarRuntime, track: Track): void {
  for (const w of car.wheels) {
    w.onGround = wheelOnGround(w.body, w.radius, track);
  }
}

function applyMotor(car: CarRuntime): void {
  // No throttle input: every car always pushes forward at full power.
  // It's the physics rules below that decide whether that effort
  // translates into motion.

  // Tilt gate: at extreme angles the car has clearly fallen on its side.
  const tilt = Math.abs(normalizeAngle(car.chassis.rotation()));
  if (tilt > TUNING.motor.maxChassisTilt) return;

  // Need ≥2 grounded wheels, AND those wheels must span a real
  // wheelbase.  With a single contact point the wheel motor's reaction
  // torque on the chassis (Newton 3 via the joint) can perfectly
  // balance gravity at some tilt and the car drives forever on one
  // wheel.  Two contact points spread apart constrain that DOF away.
  // But two wheels attached to nearby chassis vertices share almost
  // the same contact point — a "near-zero" wheelbase that locks the
  // chassis perfectly upright via geometry alone, again driving
  // unphysically forever.  Reject those too.
  const groundedPositions: { x: number; y: number }[] = [];
  for (const w of car.wheels) {
    if (w.onGround) groundedPositions.push(w.body.translation());
  }
  if (groundedPositions.length < 2) return;
  let maxSpan = 0;
  for (let i = 0; i < groundedPositions.length; i++) {
    for (let j = i + 1; j < groundedPositions.length; j++) {
      const a = groundedPositions[i]!;
      const b = groundedPositions[j]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > maxSpan) maxSpan = d;
    }
  }
  if (maxSpan < TUNING.motor.minGroundedSpan) return;

  const targetOmega = -car.genome.motorSpeed; // negative ⇒ forward
  const totalMass = totalMassOf(car);
  for (const w of car.wheels) {
    if (!w.onGround) continue;
    if (w.motorTorque <= 0) continue;
    const cur = w.body.angvel();
    const err = targetOmega - cur;
    const maxTorque =
      w.motorTorque * totalMass * GRAVITY * Math.max(0.15, w.radius) * TUNING.motor.torqueHeadroom;
    const torque = clamp(err * TUNING.motor.feedbackGain, -maxTorque, maxTorque);
    w.body.addTorque(torque, true);
  }
}

/* ─── Geometry helpers ─────────────────────────────────────────────────── */

function wheelOnGround(body: RAPIER.RigidBody, radius: number, track: Track): boolean {
  const t = body.translation();
  if (t.x < 0 || t.x > track.options.length) return false;
  const groundY = sampleTrackY(track, t.x);
  const bottom = t.y - radius;
  return Math.abs(bottom - groundY) <= TUNING.contact.wheelTolerance;
}

function totalMassOf(car: CarRuntime): number {
  let m = car.chassis.mass();
  for (const w of car.wheels) m += w.body.mass();
  return m;
}

/**
 * Per-tick lifecycle: track how long the car has been "not moving" and
 * mark it finished once that exceeds the stall threshold.  Travel
 * distance (`maxX`) was already updated for this tick by the caller —
 * we just need to decide whether the car has stopped earning new
 * travel.  A short grace period at the start means a car that has just
 * spawned and is settling under gravity isn't immediately killed.
 */
function updateLifecycle(car: CarRuntime): void {
  if (car.ageSec < TUNING.lifecycle.graceSeconds) return;
  const v = car.chassis.linvel();
  const speed = Math.hypot(v.x, v.y);
  if (speed < TUNING.lifecycle.stallSpeed) {
    car.stallTimer += SIM_DT;
  } else {
    car.stallTimer = 0;
  }
  if (car.stallTimer >= TUNING.lifecycle.stallSeconds) {
    car.finished = true;
  }
}

/**
 * Pin a finished car in place so its bodies don't drift on slopes.
 * We zero linear+angular velocity every tick instead of converting
 * the bodies to kinematic so neighbouring still-running cars can
 * still bump into them.
 */
function freezeCar(car: CarRuntime): void {
  const z = { x: 0, y: 0 };
  car.chassis.setLinvel(z, true);
  car.chassis.setAngvel(0, true);
  for (const w of car.wheels) {
    w.body.setLinvel(z, true);
    w.body.setAngvel(0, true);
  }
}

function normalizeAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function packGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/* ─── Snapshot ─────────────────────────────────────────────────────────── */

function snapshotCar(car: CarRuntime): CarSnapshot {
  const pos = car.chassis.translation();
  const vel = car.chassis.linvel();
  return {
    index: car.index,
    position: { x: pos.x, y: pos.y },
    angle: car.chassis.rotation(),
    speed: Math.hypot(vel.x, vel.y),
    travel: Math.max(0, car.maxX - car.spawnX),
    finished: car.finished,
    vertices: car.vertices,
    wheels: car.wheels.map((w) => {
      const wp = w.body.translation();
      return {
        position: { x: wp.x, y: wp.y },
        angle: w.body.rotation(),
        radius: w.radius,
        power: w.power,
        onGround: w.onGround,
      };
    }),
  };
}
