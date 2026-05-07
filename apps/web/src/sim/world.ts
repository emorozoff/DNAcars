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
/**
 * Physics sub-steps per game tick.  At 1/60 s a heavy fast wheel
 * crosses ~30 cm per step — fast enough that a single big impulse on
 * a steep hill corner can launch the chassis several metres before
 * the constraint solver gets another chance to balance.  Halving the
 * step (= 2 substeps) gives the solver twice as many opportunities
 * to converge each frame, and CCD has half as much work to do per
 * call.  The cost is doubling physics CPU, which is fine for our
 * ≤ 100 dynamic bodies.
 */
const PHYSICS_SUBSTEPS = 2;

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
    /**
     * Linear damping bumped 0.5 → 0.65 in v0.9.7: with smaller
     * substeps and lower wheel mass, top speeds were going to drift
     * down anyway, but a touch more drag means a downhill car
     * reaches its terminal speed faster and so doesn't accumulate
     * as much extra momentum into the next uphill collision.
     */
    linearDamping: 0.65,
    angularDamping: 0.2,
    /**
     * Damping bumps that kick in only when no wheel is grounded
     * (i.e. the chassis is airborne).  Real cars experience
     * aerodynamic drag; ours is a 2D simulation so we emulate it
     * with elevated linear + angular damping while in flight.
     *
     * The point isn't realism — it's that a chassis tumbling
     * uncontrollably in the air keeps its angular velocity in
     * check, so when it lands the body isn't stabbing into the
     * track *edge-first* at high angular velocity.  Edge-first
     * impacts are the failure mode that produces the explosive
     * solver-ejection we see in the timeline (0.14 s impulse of
     * +15 m/s vy that velocity-clamp catches at 22 m/s and the
     * car ends up flying ballistic).
     */
    airborneLinearDamping: 1.5,
    airborneAngularDamping: 2.0,
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
     *
     * maxDensity dropped from 400 to 250 in v0.9.7: a 0.7 m radius
     * wheel at density 400 is ≈ 615 kg — heavy enough that hitting a
     * hill corner at 20 m/s produces a vertical impulse the chassis
     * just rides up into the sky.  250 caps the heaviest wheel at
     * ≈ 385 kg; cars still need to "earn" extra wheels but the
     * collision impulses are tractable.
     */
    minDensity: 50,
    maxDensity: 250,
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
    /**
     * Wheel angular speed range, rad/s.  Lowered in v0.9.4 from
     * 10..24 to 8..18 — the upper end was producing chassis surface
     * speeds around 14 m/s on flats, which combined with the (then
     * 5 m amplitude) terrain to launch heavy cars metres above the
     * highest hill.  18 rad/s ≈ 11 m/s on average — quick enough to
     * feel dynamic, gentle enough that bumps don't trampoline.
     */
    minSpeed: 8,
    maxSpeed: 18,
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
  solver: {
    /**
     * Constraint solver iterations per step (Rapier default is 4).
     * Tried 4 in v0.8.6 thinking it was "phantom-chase" complexity,
     * but with heavy chassis + heavy wheels (densities up to 400)
     * the default just isn't enough to keep the polygonal chassis
     * out of the polyline ground.  Bumping to 8 gives the solver
     * twice as many passes to resolve all contact / joint
     * constraints to convergence each step.
     */
    numIterations: 8,
  },
  safety: {
    /**
     * Hard upper bound on the chassis's linear-velocity magnitude.
     * Top normal driving speed is ≈ 11 m/s, so 22 is still plenty of
     * head room for legitimate downhill bursts.
     */
    maxLinvel: 22,
    /**
     * Maximum chassis velocity change in m/s per *substep* (= 1/120 s)
     * that we accept as a normal physics interaction.  At 2 m/s this
     * corresponds to 240 m/s² of acceleration in a single substep —
     * already well above gravity (10) or hard friction-braking (~50),
     * but comfortably below the explosive ejections we observe when a
     * polygonal chassis lands edge-first into the polygonal ground
     * (those are 8 m/s+ in one substep, > 1000 m/s²).
     *
     * When |dv| exceeds this we scale the velocity change back to
     * the threshold and dampen the chassis's angular velocity by
     * half — together this prevents the post-impact "kicked
     * sideways at random angle" behaviour we saw at t=22.45 in the
     * v0.9.19 user-reported timeline (vx flipped +4.23 → -3.91 in
     * one game-tick).
     */
    maxDvPerSubstep: 2,
  },
  lifecycle: {
    /**
     * Continuous time (s) without forward progress (no growth in
     * maxX) after which a car's run is finished.  Was speed-based in
     * earlier versions but speed-based fired on cars that were
     * legitimately mid-jump (vy != 0); progress-based correctly
     * captures the intended meaning of "stalled" — "not getting any
     * further along the track".
     */
    stallSeconds: 5,
    /**
     * Minimum forward progress (m) that counts as "real" progress —
     * sub-mm physics noise drift mustn't reset the stall timer.
     * Without this threshold, an upside-down chassis micro-drifting
     * forward at ~1 mm/s never stalls (every tick its x grows by
     * ε > 0, lastProgressTime resets, the timer never accumulates).
     * v0.9.22 stall worked but couldn't catch this case — see the
     * gen-2 carIndex-9 timeline that lived 86 sim-seconds with
     * |v|<0.02 m/s.
     *
     * At stallSeconds=5 the implied minimum average speed to stay
     * alive is `progressEpsilon / stallSeconds` = 2 cm/s.  Any
     * legitimate driving is *much* faster than that.
     */
    progressEpsilon: 0.1,
    /**
     * If a car rolls back this far from its peak `maxX` we finish
     * it on the spot.  Catches the "leader lands upside-down after
     * a jump" case: tilt-gate disables the motor, gravity then
     * skids the chassis back down the hill.  Without this, an
     * elite car can visibly slide 10–20 m back from its high-water
     * mark before the stall timer fires (looks broken; observed in
     * the v0.9.22 gen-3 carIndex-55 timeline at +6.7 m of regression
     * and the gen-4 carIndex-0 timeline at +16 m).  `maxX` is still
     * what the GA scores on, so fitness is unaffected.
     */
    rollbackThreshold: 5,
    /**
     * Absolute hard cap on a single generation's *simulated* time
     * (s).  Per-car stall detection (above) is the primary mechanism
     * for ending a generation; this cap exists only as a fail-safe
     * for hypothetical bugs where some car keeps creeping forward
     * forever without anyone stalling.  Bumped 60 → 600 in v0.9.22:
     * 60 was firing during normal play once cars evolved enough to
     * drive far, killing 20+ moving cars at once.  10 minutes of sim
     * time is plenty for any legitimate run.
     */
    maxGenerationSec: 600,
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
  /**
   * Distance (m) over which the track ramps from "easy" (low
   * amplitude, no high-freq chatter) to its full configured
   * difficulty.  Lets the population earn fitness even from
   * mediocre genomes early in the run, while still presenting
   * brutal terrain to whatever survives long enough to reach it.
   *
   * Inside this window:
   *   - Overall amplitude scales linearly from 25 % to 100 %.
   *   - The two highest-frequency octaves (sharp bumps) are
   *     gated entirely to 0 until x = 80 m, then ramp up.
   *
   * Beyond `warmup + difficultyDistance` the track plays at full
   * specced amplitude and full chaos.
   */
  difficultyDistance: number;
};

export type Track = {
  options: TrackOptions;
  points: { x: number; y: number }[];
};

const DEFAULT_TRACK: TrackOptions = {
  length: 1500,
  step: 0.6,
  warmup: 25,
  /**
   * Cranked back up 2.8 → 5.0 in v0.9.11 by user request: more
   * dramatic hills make the evolutionary fitness landscape more
   * interesting (cars need to climb, jump, recover) and visually
   * the world looks more alive.
   */
  amplitude: 5.0,
  /**
   * 250 m ramp.  Picked so the visible "this is getting harder"
   * progression matches the timescale of an evolved population's
   * peak distance: gen-0 random cars die in ≈ 30–80 m, evolved
   * cars push past 200 m.  By the time evolution is doing its
   * job, cars start hitting full-amplitude terrain — exactly
   * when the player wants to see the harder challenges.
   */
  difficultyDistance: 250,
};

/** Frequency where the high-frequency "sharpness" octaves wake up (m). */
const SHARPNESS_START = 80;

export function generateTrack(seed: number, opts: Partial<TrackOptions> = {}): Track {
  const o: TrackOptions = { ...DEFAULT_TRACK, ...opts };
  const rng = makeRng(seed);
  // Four octaves now — added a higher-frequency layer in v0.9.11 for
  // sharper local roughness (small bumps + crevices on top of the
  // larger hill structure).  Frequencies climb by a golden-ratio
  // factor so harmonics don't visibly align.
  const layers = [
    { freq: 0.16, phase: rng() * Math.PI * 2, weight: 0.55 },
    { freq: 0.16 * 1.618, phase: rng() * Math.PI * 2, weight: 0.3 },
    { freq: 0.16 * 1.618 * 1.618, phase: rng() * Math.PI * 2, weight: 0.18 },
    { freq: 0.16 * 1.618 ** 3, phase: rng() * Math.PI * 2, weight: 0.1 },
  ];
  const drift = { freq: 0.018, phase: rng() * Math.PI * 2, weight: 0.85 };

  const points: { x: number; y: number }[] = [];
  const difficultyEnd = o.warmup + o.difficultyDistance;
  for (let x = 0; x <= o.length + 1e-4; x += o.step) {
    // Spawn-pad: 0 → 1 over warmup.  Guarantees the first 25 m is
    // perfectly flat for the cars to settle on under gravity.
    const baseRamp = smoothstep(0, o.warmup, x);
    // Difficulty ramp: 0.25 → 1.0 of the configured amplitude over
    // `difficultyDistance` past the spawn-pad.  Even the "easy"
    // floor of 0.25 isn't trivial — bad genomes still fail it, but
    // mediocre ones can get a few hundred metres before the terrain
    // hits full chaos.
    const difficulty = smoothstep(o.warmup, difficultyEnd, x);
    const ampScale = lerp(0.25, 1.0, difficulty);
    // Sharpness ramp: the two highest octaves (sharp local bumps)
    // are gated off entirely until x = SHARPNESS_START, then fade
    // in over the rest of the difficulty window.  The result is
    // smooth, long-period hills early on; sharper terrain only
    // emerges once the cars have already proven they can handle
    // the basics.
    const sharpness = smoothstep(SHARPNESS_START, difficultyEnd, x);
    let y = 0;
    y += Math.sin(x * layers[0]!.freq + layers[0]!.phase) * layers[0]!.weight;
    y += Math.sin(x * layers[1]!.freq + layers[1]!.phase) * layers[1]!.weight;
    y += Math.sin(x * layers[2]!.freq + layers[2]!.phase) * layers[2]!.weight * sharpness;
    y += Math.sin(x * layers[3]!.freq + layers[3]!.phase) * layers[3]!.weight * sharpness;
    y += Math.sin(x * drift.freq + drift.phase) * drift.weight;
    y *= baseRamp * ampScale * o.amplitude;
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
  /**
   * The wheel's ball collider.  Cached so we can ask Rapier directly
   * "is this collider in contact with anything right now" instead of
   * approximating with a vertical-distance-to-track formula (which
   * fails on slopes — see wheelOnGround docs for the geometry).
   */
  collider: RAPIER.Collider;
  joint: RAPIER.ImpulseJoint;
  radius: number;
  /** Cached genome power scalar 0..1, surfaced on snapshot for the renderer. */
  power: number;
  /** Pre-computed motor-torque fraction (mapped from power at build time). */
  motorTorque: number;
  onGround: boolean;
};

/**
 * Per-car timeline entry — a single point on the trajectory record.
 * Stored as a flat tuple to keep the JSON bundle compact when the
 * user copies a debug dump.
 *
 *   t       sim time, seconds (since this generation started)
 *   x, y    chassis position
 *   vx, vy  chassis linear velocity
 *   ang     chassis rotation, rad
 *   hAt     altitude above the local track surface (m)
 *   on      bitmask of which wheels were on the ground this tick
 *   ev      event code:
 *             0 = periodic sample (every TIMELINE_SAMPLE_SEC)
 *             1 = velocity clamp fired (|v| past safety.maxLinvel)
 *             3 = finish (car just stalled out)
 *             4 = impulse spike clipped (|dv| past safety.maxDvPerSubstep)
 *           (code 2 used to be the altitude-ceiling event;
 *           dropped in v0.9.17 — the ceiling was a band-aid, we
 *           now want the raw physics so we can find the real
 *           cause of any flying behaviour)
 */
export type TimelineEntry = [
  t: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  ang: number,
  hAt: number,
  on: number,
  ev: 0 | 1 | 2 | 3 | 4,
];

/** Periodic sample rate.  5 Hz → 150 entries per 30 s of sim. */
const TIMELINE_SAMPLE_SEC = 0.2;
/** Max entries kept per car.  At 5 Hz + a few events that's ≈ 60 s of history. */
const TIMELINE_MAX = 400;

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
  /**
   * Sim time (in this car's `ageSec` clock) of the last *meaningful*
   * forward step — i.e. the last time `lastProgressX` was bumped.
   * Stall fires when `ageSec - lastProgressTime ≥ stallSeconds`.
   */
  lastProgressTime: number;
  /**
   * The chassis x-position at which we last counted real progress.
   * Updated only when `x ≥ lastProgressX + progressEpsilon`, so
   * sub-mm drift (e.g. an upside-down chassis sliding forward at
   * 1 mm/s under gravity) does *not* reset the stall timer.  Note
   * this is intentionally separate from `maxX`, which still tracks
   * the absolute high-water mark and feeds the GA fitness.
   */
  lastProgressX: number;
  /** Once true, motor is off and bodies are pinned in place forever. */
  finished: boolean;
  /**
   * True when no wheel was grounded the last tick.  Used to switch
   * the chassis between "ground" damping (low) and "air" damping
   * (high) on transition, instead of writing damping every tick.
   */
  airborne: boolean;
  /** Trajectory record — periodic samples + immediate event entries. */
  timeline: TimelineEntry[];
  /** Sim time of the last periodic sample. */
  lastSampleT: number;
  /**
   * Chassis linear velocity at the end of the previous substep.
   * Compared against the current velocity post-step to detect
   * explosive impulse spikes (penetration ejections).
   */
  lastVelocity: { x: number; y: number };
  /** How many times each safety net has fired for this car. */
  eventCounts: { velClamp: number; spike: number };
};

export type CarSnapshot = {
  index: number;
  position: { x: number; y: number };
  /** Linear velocity of the chassis in world coords, m/s.  Useful for
   *  debug bundles ("car was moving (vx, vy) at (px, py) when it flew"). */
  velocity: { x: number; y: number };
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
  /** Return the recorded trajectory + event entries for car `idx`. */
  getCarTimeline(idx: number): TimelineEntry[];
  /** Return how many times each safety net has fired for car `idx`. */
  getCarEventCounts(idx: number): { velClamp: number; spike: number };
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
  // Each physics call advances by SIM_DT / SUBSTEPS so the per-game-
  // tick total is still SIM_DT, just split across multiple solver
  // passes for smoother contact resolution.
  world.timestep = SIM_DT / PHYSICS_SUBSTEPS;
  // More iterations than the default 4: a stiff scene of heavy
  // chassis + heavy wheels + revolute joints needs the extra passes
  // to converge each step and avoid the explosive ejections that
  // launch cars to the moon.
  world.integrationParameters.numSolverIterations = TUNING.solver.numIterations;

  buildTrackColliders(world, opts.track);

  const sx = opts.spawnX ?? 8;
  const sy = sampleTrackY(opts.track, sx) + 1.6;

  const cars: CarRuntime[] = opts.genomes.map((g, i) => buildCar(world, g, i, sx, sy));

  let time = 0;

  return {
    step(): void {
      // Run PHYSICS_SUBSTEPS sub-steps per game tick.  Motor torque is
      // applied before each sub-step so the "addTorque" accumulator
      // gets properly integrated over the smaller dt, instead of
      // applying one frame's worth of torque to one of two sub-steps.
      for (let s = 0; s < PHYSICS_SUBSTEPS; s++) {
        for (const car of cars) {
          if (car.finished) {
            freezeCar(car);
            continue;
          }
          updateWheelContacts(car, world);
          updateAirborneDamping(car);
          applyMotor(car);
        }
        world.step();
        // Detect explosive impulses INSIDE the substep loop so the
        // clipped velocity feeds back into the next substep — if we
        // only checked once per game-tick, the spike could propagate
        // chassis position by ~17 cm before being caught.
        for (const car of cars) {
          if (!car.finished)
            clampImpulseSpike(car, opts.track, time + (s + 1) * (SIM_DT / PHYSICS_SUBSTEPS));
        }
      }
      time += SIM_DT;
      for (const car of cars) {
        if (car.finished) continue;
        car.ageSec += SIM_DT;
        const x = car.chassis.translation().x;
        // maxX is the absolute peak — feeds GA fitness, must stay precise.
        if (x > car.maxX) car.maxX = x;
        // lastProgressX/Time only advance on a meaningful step (10 cm
        // by default), so noise-level drift can't keep the stall
        // timer from accumulating.
        if (x >= car.lastProgressX + TUNING.lifecycle.progressEpsilon) {
          car.lastProgressX = x;
          car.lastProgressTime = car.ageSec;
        }
        clampInsaneVelocity(car, opts.track, time);
        const wasFinished = car.finished;
        updateLifecycle(car);
        // Record a periodic sample for this car.  If updateLifecycle
        // just promoted us to "finished", record an event entry too
        // so the timeline ends with a clear "this is when it stopped"
        // marker.
        if (!wasFinished && car.finished) {
          recordTimeline(car, opts.track, time, 3);
        } else {
          recordTimeline(car, opts.track, time, 0);
        }
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
    getCarTimeline(idx): TimelineEntry[] {
      return cars[idx]?.timeline ?? [];
    },
    getCarEventCounts(idx): { velClamp: number; spike: number } {
      return cars[idx]?.eventCounts ?? { velClamp: 0, spike: 0 };
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
  // so the surface is gap-free.  Crucial for heavy bodies: a thin
  // polyline + heavy chassis can get tunneled-into at sharp corners
  // even with CCD, and the constraint solver then ejects the body
  // with an explosive vertical impulse (we observed 30 + m altitudes
  // above the highest hill).  With a solid volume below the surface
  // the body can't penetrate into geometry — it's pushed back out
  // along the surface normal, smoothly, by accumulated contacts.
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
      // Spawn airborne, so use the higher airborne damping.  Switches
      // to ground damping in step() when the first wheel makes
      // contact (handled by updateAirborneDamping).
      .setLinearDamping(TUNING.chassis.airborneLinearDamping)
      .setAngularDamping(TUNING.chassis.airborneAngularDamping)
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
    const wheelCollider = world.createCollider(
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
      collider: wheelCollider,
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
    lastProgressTime: 0,
    lastProgressX: spawnX,
    finished: false,
    // Cars spawn ≈ 1.6 m above the track surface, so they're literally
    // airborne for the first beat.  Initial damping is set to the
    // airborne values below in buildCar so the spawn drop is gentle;
    // the very first updateAirborneDamping call after the wheels touch
    // down switches them back to ground damping.
    airborne: true,
    timeline: [],
    lastSampleT: -Infinity,
    lastVelocity: { x: 0, y: 0 },
    eventCounts: { velClamp: 0, spike: 0 },
  };
}

/* ─── Per-tick logic ───────────────────────────────────────────────────── */

function updateWheelContacts(car: CarRuntime, world: RAPIER.World): void {
  for (const w of car.wheels) {
    w.onGround = wheelOnGround(world, w.collider);
  }
}

/**
 * Switch the chassis between "ground" and "airborne" damping
 * profiles only when the airborne state actually changes.  Setting
 * Rapier damping every tick is cheap but pointless; this also keeps
 * the diff small (one body update at takeoff and one at landing).
 *
 * Reading: airborne when no wheel of the car is currently inside the
 * ground tolerance.  See updateWheelContacts for the per-wheel test.
 */
function updateAirborneDamping(car: CarRuntime): void {
  let grounded = false;
  for (const w of car.wheels) {
    if (w.onGround) {
      grounded = true;
      break;
    }
  }
  const isAirborne = !grounded;
  if (isAirborne === car.airborne) return;
  car.airborne = isAirborne;
  if (isAirborne) {
    car.chassis.setLinearDamping(TUNING.chassis.airborneLinearDamping);
    car.chassis.setAngularDamping(TUNING.chassis.airborneAngularDamping);
  } else {
    car.chassis.setLinearDamping(TUNING.chassis.linearDamping);
    car.chassis.setAngularDamping(TUNING.chassis.angularDamping);
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

/**
 * "Is this wheel touching the track right now?"
 *
 * Asks Rapier's narrow-phase directly — any contact pair that
 * involves the wheel collider must, by collision-group filtering,
 * be a track collider (wheels are masked to collide only with
 * GROUP.TRACK).  We then check that the pair has at least one
 * actual contact point on its manifold; broad-phase pairs with
 * separated manifolds get rejected.
 *
 * Why not the old geometric "bottom of wheel ≈ sampleTrackY(x)"
 * test?  On a slope at angle θ a wheel of radius r centred above
 * the surface has its lowest point at `groundY + r·(1/cos θ - 1)`
 * vertically — i.e. *above* the surface.  At 30° + r=0.5 m that's
 * already 7.7 cm, well past our old 6 cm tolerance, so the wheel
 * is wrongly reported as airborne.  Three player-visible bugs all
 * traced back to that:
 *   1. Wheels not turning green on hills (cosmetic).
 *   2. The motor-gate ("≥2 grounded wheels") refusing to fire on
 *      crests, so the car loses thrust mid-climb.
 *   3. Leader cars sliding back several metres from peak position
 *      because, with no thrust on the climb, gravity wins.
 *
 * The contact-query has none of those failure modes — it's the same
 * information Rapier itself uses to apply collision impulses, so by
 * construction it agrees with the physics.
 */
function wheelOnGround(world: RAPIER.World, collider: RAPIER.Collider): boolean {
  let touching = false;
  world.contactPairsWith(collider, (other) => {
    if (touching) return;
    world.contactPair(collider, other, (manifold) => {
      if (touching) return;
      if (manifold.numContacts() > 0) touching = true;
    });
  });
  return touching;
}

function totalMassOf(car: CarRuntime): number {
  let m = car.chassis.mass();
  for (const w of car.wheels) m += w.body.mass();
  return m;
}

/**
 * Per-tick lifecycle.  Two ways to be done with a car:
 *
 *   1. Rolled back from peak.  If the chassis is now `rollbackThreshold`
 *      metres or more behind its all-time `maxX`, finish immediately.
 *      This is the "leader skidding back down the hill" case — the car
 *      is clearly never reaching its peak again, and dragging it out
 *      until the stall timer fires looks broken on screen.
 *
 *   2. Stalled.  No meaningful forward progress for `stallSeconds`
 *      (where "meaningful" = at least `progressEpsilon` of x growth
 *      since the last reset).  Catches both pinned cars and ones
 *      drifting by sub-mm increments.
 *
 * A short grace period at the very start lets a freshly-spawned
 * car settle under gravity before either test arms.
 */
function updateLifecycle(car: CarRuntime): void {
  if (car.ageSec < TUNING.lifecycle.graceSeconds) return;
  const x = car.chassis.translation().x;
  if (car.maxX - x >= TUNING.lifecycle.rollbackThreshold) {
    car.finished = true;
    return;
  }
  if (car.ageSec - car.lastProgressTime >= TUNING.lifecycle.stallSeconds) {
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

/**
 * Safety net: even with thick ground + 8 solver iterations, the
 * solver can still occasionally hand a body an explosive impulse on
 * a sharp track corner, sending it tens of metres into the air.
 * Top realistic chassis speed is ≈ 11 m/s; anything beyond
 * `maxLinvel` is a known glitch state, not gameplay.  Scale velocity
 * back to the cap and warn so we can see how often this fires.
 */
function clampInsaneVelocity(car: CarRuntime, track: Track, time: number): void {
  const v = car.chassis.linvel();
  const sp = Math.hypot(v.x, v.y);
  if (sp <= TUNING.safety.maxLinvel) return;
  const scale = TUNING.safety.maxLinvel / sp;
  car.chassis.setLinvel({ x: v.x * scale, y: v.y * scale }, true);
  car.eventCounts.velClamp++;
  recordTimeline(car, track, time, 1);
  console.warn(
    `[safety] car ${car.index} clamped from ${sp.toFixed(1)} m/s to ${TUNING.safety.maxLinvel}`,
  );
}

/**
 * Per-substep impulse-spike detector.
 *
 * Compares the chassis's velocity now against the value at the end
 * of the previous substep; if the change in one 1/120-s step exceeds
 * `maxDvPerSubstep` we treat it as an explosive ejection (typically
 * the solver pushing the polygonal chassis out of the polygonal
 * ground after a deep edge-first penetration), scale the change back
 * to the threshold, and dampen angular velocity by half so the
 * post-impact heading isn't a random spin.
 *
 * Compared to clampInsaneVelocity (which catches absolute |v| > 22
 * m/s), this catches the *moderate* impulses that produced the
 * "sudden reverse" behaviour the user observed in v0.9.19 — vx
 * flipping from +4 to -4 in one game tick.  The full magnitude of
 * post-clamp velocity stays below 22 m/s so clampInsaneVelocity
 * never fired, but the change-per-tick is plainly impossible from
 * normal physics.
 *
 * Called once per substep, after world.step(), before the chassis's
 * velocity feeds into the next substep.
 */
function clampImpulseSpike(car: CarRuntime, track: Track, time: number): void {
  const v = car.chassis.linvel();
  const dvx = v.x - car.lastVelocity.x;
  const dvy = v.y - car.lastVelocity.y;
  const dv = Math.hypot(dvx, dvy);
  const limit = TUNING.safety.maxDvPerSubstep;
  if (dv > limit) {
    const scale = limit / dv;
    car.chassis.setLinvel(
      {
        x: car.lastVelocity.x + dvx * scale,
        y: car.lastVelocity.y + dvy * scale,
      },
      true,
    );
    // Halve angular velocity too — explosion-ejections almost
    // always come with a spin component; without this the chassis
    // emerges from the clamp moving slower but still rotating
    // wildly.
    car.chassis.setAngvel(car.chassis.angvel() * 0.5, true);
    car.eventCounts.spike++;
    recordTimeline(car, track, time, 4);
  }
  // Cache for the next substep's comparison — read fresh because
  // we may have just modified it above.
  const nv = car.chassis.linvel();
  car.lastVelocity.x = nv.x;
  car.lastVelocity.y = nv.y;
}

// (`clampAirHeight` removed in v0.9.17 — see commit log.  We want the
// raw physics so that any flying behaviour reveals its real cause in
// the timeline log instead of being masked by a band-aid ceiling.)

/**
 * Append a timeline entry for this car.  Called periodically (every
 * TIMELINE_SAMPLE_SEC sim seconds) and immediately on safety events.
 *
 * Entries are kept in a flat tuple so the JSON bundle that the user
 * pastes back to me stays compact and readable.  We cap at
 * TIMELINE_MAX entries — older ones drop off the front of the queue
 * so the buffer is always "the most recent N moments of this car".
 *
 * `eventCode` 0 means "this is a periodic sample"; non-zero codes
 * (1=velClamp, 3=finish) mean "an event happened this tick" and the
 * entry was forced regardless of sample timing.
 */
function recordTimeline(
  car: CarRuntime,
  track: Track,
  time: number,
  eventCode: 0 | 1 | 2 | 3 | 4,
): void {
  if (eventCode === 0 && time - car.lastSampleT < TIMELINE_SAMPLE_SEC) return;
  car.lastSampleT = time;
  const pos = car.chassis.translation();
  const vel = car.chassis.linvel();
  const trackY = pos.x >= 0 && pos.x <= track.options.length ? sampleTrackY(track, pos.x) : 0;
  let onBits = 0;
  for (let i = 0; i < car.wheels.length && i < 8; i++) {
    if (car.wheels[i]!.onGround) onBits |= 1 << i;
  }
  car.timeline.push([
    Number(time.toFixed(2)),
    Number(pos.x.toFixed(2)),
    Number(pos.y.toFixed(2)),
    Number(vel.x.toFixed(2)),
    Number(vel.y.toFixed(2)),
    Number(car.chassis.rotation().toFixed(3)),
    Number((pos.y - trackY).toFixed(2)),
    onBits,
    eventCode,
  ]);
  if (car.timeline.length > TIMELINE_MAX) car.timeline.shift();
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
    velocity: { x: vel.x, y: vel.y },
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
