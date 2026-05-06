/**
 * Stand-alone 2D car-physics demo.
 *
 * Goal: stress-test the rules that decide which random shapes are *physically
 * able* to drive forward.  No genetics, no scoring, no worker — just Rapier
 * and a deterministic world that you can stop, restart, and observe.
 *
 * The three rules that make a "bad" shape unable to drive:
 *
 *   1. Chassis is *slippery* (friction ≈ 0) — a car resting on its body has
 *      no traction, so the wheels (in the air) can't pull it forward.
 *   2. The motor only fires for wheels that are *actually touching* the
 *      track surface, sampled directly from the polyline.
 *   3. Rollover and prolonged body-on-ground contact disable the motor
 *      permanently — a flipped car drifts to a stop and stays there.
 *
 * Heavy chassis vs light wheels keeps the centre of gravity low so a
 * "good" shape (wheels at the bottom, wide base) is stable, while a "bad"
 * shape (wheels on top, narrow base, near-circular hull) is not.
 */

import RAPIER from '@dimforge/rapier2d-compat';

/* ─── Constants ─────────────────────────────────────────────────────────── */

export const SIM_DT = 1 / 60;
export const GRAVITY = 9.81;

/** Tunable knobs — change here to retune the whole demo. */
export const TUNING = {
  chassis: {
    minVertices: 5,
    maxVertices: 10,
    minRadius: 0.35,
    maxRadius: 1.0,
    minDensity: 250,
    maxDensity: 450,
    /** Slippery body: wheels are the only way to generate horizontal force. */
    friction: 0.05,
    restitution: 0.0,
    linearDamping: 0.4,
    angularDamping: 0.2,
  },
  wheel: {
    minCount: 1,
    maxCount: 4,
    minRadius: 0.18,
    maxRadius: 0.7,
    minDensity: 30,
    maxDensity: 80,
    friction: 1.6,
    restitution: 0.0,
    linearDamping: 0.05,
    angularDamping: 0.05,
  },
  motor: {
    minSpeed: 10,
    maxSpeed: 24,
    /** Multiplier on (mass × g × radius) — head-room above what's needed to climb. */
    torqueHeadroom: 1.8,
    /** Strength of the angular-velocity error term (higher = stiffer feel). */
    feedbackGain: 7,
  },
  contact: {
    /** Max distance from track surface to count a wheel as "on ground" (m). */
    wheelTolerance: 0.06,
    /** Max distance from track surface to count a chassis vertex as touching (m). */
    chassisTolerance: 0.05,
  },
  crash: {
    /** Body angle (rad) past which we start counting toward a rollover crash. */
    rolloverAngle: Math.PI / 2,
    /** Time (s) the angle must stay past the threshold to crash. */
    rolloverGrace: 0.4,
    /** Time (s) the chassis must touch ground continuously to crash. */
    bodyContactGrace: 0.7,
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
  // Layered sines: gives a wavy hill profile that's not too repetitive.
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
  radius: number;
  density: number;
  motorTorque: number;
};

export type Genome = {
  chassisVertexCount: number;
  /** Per-vertex radii on evenly-spaced rays around the centre, [0..1]. */
  chassisRadii: number[];
  chassisDensity: number;
  wheels: WheelGene[];
  /** Target angular speed of driven wheels, rad/s. */
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
      density: lerp(TUNING.wheel.minDensity, TUNING.wheel.maxDensity, rng()),
      motorTorque: lerp(0.4, 1.0, rng()),
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

/** Build the chassis vertices in body-local coords from a genome. */
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
  alive: boolean;
  crashed: boolean;
  crashReason: 'rollover' | 'body-down' | 'stalled' | null;
  rolloverTimer: number;
  bodyContactTimer: number;
  stallTimer: number;
  ageSec: number;
};

export type CarSnapshot = {
  index: number;
  alive: boolean;
  crashed: boolean;
  crashReason: 'rollover' | 'body-down' | 'stalled' | null;
  position: { x: number; y: number };
  angle: number;
  speed: number;
  travel: number;
  vertices: { x: number; y: number }[];
  wheels: {
    position: { x: number; y: number };
    angle: number;
    radius: number;
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
  destroy(): void;
};

export type CreateWorldOptions = {
  track: Track;
  genomes: Genome[];
  spawnX?: number;
  spawnYOffset?: number;
};

export async function createWorld(opts: CreateWorldOptions): Promise<WorldHandle> {
  await ensureRapier();
  const world = new RAPIER.World({ x: 0, y: -GRAVITY });
  world.timestep = SIM_DT;

  buildTrackColliders(world, opts.track);

  const sx = opts.spawnX ?? 8;
  // Spawn slightly above the track so wheels settle naturally.
  const sy = sampleTrackY(opts.track, sx) + 1.6 + (opts.spawnYOffset ?? 0);

  const cars: CarRuntime[] = opts.genomes.map((g, i) => buildCar(world, g, i, sx, sy));

  let time = 0;

  return {
    step(): void {
      // Apply motors before stepping so torques are integrated this tick.
      for (const car of cars) {
        if (!car.alive) continue;
        updateContacts(car, opts.track);
        if (car.crashed) continue;
        applyMotor(car);
      }
      world.step();
      time += SIM_DT;
      for (const car of cars) {
        if (!car.alive) continue;
        updateLifecycle(car);
      }
    },
    snapshot(): WorldSnapshot {
      return {
        time,
        cars: cars.map(snapshotCar),
      };
    },
    destroy(): void {
      world.free();
    },
  };
}

/* ─── Track colliders ──────────────────────────────────────────────────── */

function buildTrackColliders(world: RAPIER.World, track: Track): void {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
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

  // Back wall so a car bumped backwards doesn't roll off the world.
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

  // Filter wheels that overlap or share an attachment vertex — emulates
  // the main app's "no two wheels on the same point" rule.
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
    const wb = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawnX + anchor.x, spawnY + anchor.y)
        .setLinearDamping(TUNING.wheel.linearDamping)
        .setAngularDamping(TUNING.wheel.angularDamping)
        .setCcdEnabled(true),
    );
    world.createCollider(
      RAPIER.ColliderDesc.ball(wg.radius)
        .setDensity(wg.density)
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
      motorTorque: wg.motorTorque,
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
    alive: true,
    crashed: false,
    crashReason: null,
    rolloverTimer: 0,
    bodyContactTimer: 0,
    stallTimer: 0,
    ageSec: 0,
  };
}

/* ─── Per-tick logic ───────────────────────────────────────────────────── */

function updateContacts(car: CarRuntime, track: Track): void {
  // Wheel ground contacts (one per wheel, used by motor + render).
  for (const w of car.wheels) {
    w.onGround = wheelOnGround(w.body, w.radius, track);
  }
  // Chassis vertex closest to the surface — anything within tolerance
  // counts as "the body is touching".
  car.chassis.translation();
  if (chassisTouchesGround(car, track)) {
    car.bodyContactTimer += SIM_DT;
    if (car.bodyContactTimer >= TUNING.crash.bodyContactGrace && !car.crashed) {
      car.crashed = true;
      car.crashReason = 'body-down';
    }
  } else {
    car.bodyContactTimer = Math.max(0, car.bodyContactTimer - SIM_DT * 2);
  }

  // Rollover.
  const angle = normalizeAngle(car.chassis.rotation());
  if (Math.abs(angle) > TUNING.crash.rolloverAngle) {
    car.rolloverTimer += SIM_DT;
    if (car.rolloverTimer >= TUNING.crash.rolloverGrace && !car.crashed) {
      car.crashed = true;
      car.crashReason = 'rollover';
    }
  } else {
    car.rolloverTimer = Math.max(0, car.rolloverTimer - SIM_DT * 2);
  }
}

function applyMotor(car: CarRuntime): void {
  const targetOmega = -car.genome.motorSpeed; // negative ⇒ clockwise ⇒ forward
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

function updateLifecycle(car: CarRuntime): void {
  car.ageSec += SIM_DT;
  const pos = car.chassis.translation();
  if (pos.x > car.maxX) car.maxX = pos.x;

  // Stalled: no progress for 5 seconds after a 3-second grace period.
  const vel = car.chassis.linvel();
  const speed = Math.hypot(vel.x, vel.y);
  if (speed < 0.15 && car.ageSec > 3) {
    car.stallTimer += SIM_DT;
  } else {
    car.stallTimer = 0;
  }
  if (car.stallTimer > 5 && !car.crashed) {
    car.crashed = true;
    car.crashReason = 'stalled';
  }

  // "Alive" stays true even when crashed — we keep simulating the body so
  // it visibly slides to a stop, but the motor is off.  The flag we use
  // for stats is `crashed`.
}

/* ─── Geometry helpers ─────────────────────────────────────────────────── */

function wheelOnGround(body: RAPIER.RigidBody, radius: number, track: Track): boolean {
  const t = body.translation();
  if (t.x < 0 || t.x > track.options.length) return false;
  const groundY = sampleTrackY(track, t.x);
  const bottom = t.y - radius;
  return Math.abs(bottom - groundY) <= TUNING.contact.wheelTolerance;
}

function chassisTouchesGround(car: CarRuntime, track: Track): boolean {
  const pos = car.chassis.translation();
  const ang = car.chassis.rotation();
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const tol = TUNING.contact.chassisTolerance;
  for (const v of car.vertices) {
    const wx = pos.x + v.x * cos - v.y * sin;
    const wy = pos.y + v.x * sin + v.y * cos;
    if (wx < 0 || wx > track.options.length) continue;
    const gy = sampleTrackY(track, wx);
    if (wy - gy < tol) return true;
  }
  return false;
}

function totalMassOf(car: CarRuntime): number {
  let m = car.chassis.mass();
  for (const w of car.wheels) m += w.body.mass();
  return m;
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
    alive: car.alive,
    crashed: car.crashed,
    crashReason: car.crashReason,
    position: { x: pos.x, y: pos.y },
    angle: car.chassis.rotation(),
    speed: Math.hypot(vel.x, vel.y),
    travel: Math.max(0, car.maxX - car.spawnX),
    vertices: car.vertices,
    wheels: car.wheels.map((w) => {
      const wp = w.body.translation();
      return {
        position: { x: wp.x, y: wp.y },
        angle: w.body.rotation(),
        radius: w.radius,
        onGround: w.onGround,
      };
    }),
  };
}
