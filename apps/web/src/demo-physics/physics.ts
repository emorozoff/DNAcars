/**
 * Stand-alone 2D car-physics demo.
 *
 * Random polygonal cars on a long, hilly track.  Every car always
 * holds full throttle.  There is *no* death, no crash detection — bad
 * shapes simply fail to drive.  The physics rules that filter "good"
 * shapes from "bad" ones are:
 *
 *   1. Slippery chassis (friction ≈ 0).  A body resting on its hull
 *      can't generate traction, so wheels in the air can't propel it.
 *   2. The motor only fires for wheels actually touching the polyline
 *      (sampled directly from the track curve).
 *   3. The motor requires *two* grounded wheels.  With a single
 *      contact point, the wheel motor's reaction torque on the
 *      chassis (Newton 3 via the joint) cancels gravity at some tilt
 *      and the car drives forever on one wheel — exactly what we
 *      don't want.  Two contact points kill that degree of freedom.
 *   4. Heavy chassis (250–450 kg/m²) vs light wheels (30–80) keeps
 *      the centre of gravity low.  Balanced shapes are stable;
 *      narrow-base shapes flip naturally on slopes.
 *
 * Solver: 8 iterations per step (default 4) for cleaner contact
 * resolution between the polygonal chassis and the trapezoid ground.
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
    torqueHeadroom: 1.8,
    feedbackGain: 7,
    /** Beyond this chassis tilt the motor is gated off. */
    maxChassisTilt: (45 * Math.PI) / 180,
  },
  contact: {
    /** Max distance from track surface to count a wheel as "on ground". */
    wheelTolerance: 0.06,
  },
  solver: {
    /** Constraint solver iterations per step (Rapier default is 4). */
    numIterations: 8,
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
  radius: number;
  density: number;
  motorTorque: number;
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
};

export type CarSnapshot = {
  index: number;
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
  world.integrationParameters.numSolverIterations = TUNING.solver.numIterations;

  buildTrackColliders(world, opts.track);

  const sx = opts.spawnX ?? 8;
  const sy = sampleTrackY(opts.track, sx) + 1.6 + (opts.spawnYOffset ?? 0);

  const cars: CarRuntime[] = opts.genomes.map((g, i) => buildCar(world, g, i, sx, sy));

  let time = 0;

  return {
    step(): void {
      for (const car of cars) {
        updateWheelContacts(car, opts.track);
        applyMotor(car);
      }
      world.step();
      time += SIM_DT;
      // Track furthest position so the leaderboard / camera stays meaningful.
      for (const car of cars) {
        const x = car.chassis.translation().x;
        if (x > car.maxX) car.maxX = x;
      }
    },
    snapshot(): WorldSnapshot {
      return { time, cars: cars.map(snapshotCar) };
    },
    destroy(): void {
      world.free();
    },
  };
}

/* ─── Track colliders ──────────────────────────────────────────────────── */

function buildTrackColliders(world: RAPIER.World, track: Track): void {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // Thick "earth" — each track segment becomes a trapezoid extending
  // 100 m down to a virtual floor.  Adjacent trapezoids share an edge
  // so the surface is gap-free; bodies cannot tunnel through a thin
  // line at speed and end up underneath.
  const floorY = -100;
  for (let i = 0; i < track.points.length - 1; i++) {
    const a = track.points[i]!;
    const b = track.points[i + 1]!;
    const verts = new Float32Array([a.x, a.y, b.x, b.y, b.x, floorY, a.x, floorY]);
    const desc = RAPIER.ColliderDesc.convexHull(verts);
    if (!desc) continue;
    desc
      .setFriction(1.0)
      .setRestitution(0.05)
      .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CHASSIS | GROUP.WHEEL));
    world.createCollider(desc, ground);
  }

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

  // Need ≥2 grounded wheels.  With a single contact point the wheel
  // motor's reaction torque on the chassis (Newton 3 via the joint)
  // can perfectly balance gravity at some tilt and the car drives
  // forever on one wheel.  Two contact points constrain that DOF away.
  let groundedCount = 0;
  for (const w of car.wheels) {
    if (w.onGround) groundedCount++;
  }
  if (groundedCount < 2) return;

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
