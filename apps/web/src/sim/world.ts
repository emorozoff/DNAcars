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
    /**
     * Bumped 1.8 → 3.5 in v1.28 by player request: even at 1.8 m
     * (≈ 3.6 m wide chassis) the cap still bottle-necked a real
     * "monster truck" body that could span a 1 m cliff via sheer
     * wheelbase, or roll a wall by sitting on top of it.  Letting
     * the radius reach 3.5 m (≈ 7 m chassis) opens the search
     * space to genuinely huge silhouettes — the GA only chooses
     * them when the track rewards them, so on flat tracks small
     * bodies still dominate.
     */
    maxRadius: 3.5,
    minDensity: 250,
    /**
     * Dropped 450 → 300 in v1.11 to compensate for the larger
     * radius range.  Mass scales with area (≈ r²), so a 1.8 m
     * chassis at the old 450 kg/m² density would be ≈ 3× heavier
     * than the previous heaviest.  300 keeps the new max in the
     * same ballpark as the old.
     */
    maxDensity: 300,
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
    /**
     * Bumped 1.2 → 2.5 in v1.28.  Lets a single wheel diameter (5 m)
     * span comfortably past a 1 m cliff or roll over a 1 m wall on
     * its own — at 1.2 m the wheel only just cleared and the GA had
     * to find a working chassis-wheelbase combo to bridge wider
     * gaps.  Now huge "balloon-tyre" cars are a viable strategy if
     * the track punishes small wheels.
     */
    maxRadius: 2.5,
    /**
     * Per-wheel "power" gene (0..1) drives mass, motor strength and
     * visual stroke width together — the trio of {light, weak, thin}
     * vs {heavy, strong, thick}.  A car can't pick "powerful but
     * light" or "heavy but weak"; the three traits are bound so the
     * player can read a wheel's power off its line thickness alone.
     *
     * maxDensity dropped 250 → 130 in v1.11 to compensate for the
     * 0.7 → 1.2 m radius bump.  Wheel mass = density × π × r², so a
     * 1.2 m wheel at the old 250 kg/m² density would be 1131 kg —
     * a single max-size max-density wheel weighing more than the
     * whole rest of the car.  130 caps the heaviest wheel at
     * ≈ 588 kg; still substantial but tractable for the solver.
     */
    minDensity: 50,
    maxDensity: 130,
    minMotorFrac: 0.2,
    maxMotorFrac: 1.0,
    /** Visual stroke width range (world metres, multiplied by render zoom). */
    minStroke: 0.03,
    maxStroke: 0.12,
    friction: 1.6,
    restitution: 0.0,
    linearDamping: 0.05,
    /**
     * Baseline wheel angular damping.  Per-wheel damping in
     * buildCar() scales this *inversely* with the wheel's radius —
     * a rolling-resistance proxy that gives bigger wheels a real
     * energy advantage and tilts evolution away from the
     * "everything tiny" attractor.  See buildCar for the formula.
     */
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
     * Minimum forward progress (m) that counts as "real" progress.
     * The stall timer only resets when the chassis x grows by at
     * least this much beyond `lastProgressX`.  Combined with
     * `stallSeconds=5` this means the implied minimum average
     * speed to stay alive is `progressEpsilon / stallSeconds`.
     *
     *   0.1 m  → 0.02 m/s — caught zombie drift but missed slow
     *                       crawlers (a car oscillating forward at
     *                       0.2 m/s would trigger the threshold
     *                       every ~0.5 s, never stalling).  The
     *                       v1.7.0 user-reported bug: a car that
     *                       averaged 0.224 m/s for 80 s stayed
     *                       alive because each oscillation crossed
     *                       the 10 cm mark before the 5 s timer
     *                       could fire.
     *   4.0 m  → 0.8 m/s   — catches zombie drift AND slow
     *                       oscillators.  Real evolved cars
     *                       cruise at 5–10 m/s, so a 0.8 m/s
     *                       cutoff is well below normal driving
     *                       and only kills cars that aren't
     *                       meaningfully going anywhere.
     */
    progressEpsilon: 4,
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
  /**
   * Obstacle intensities, each in 0..1.  Zero means "off"; one
   * means full-strength (very deep pits, very tall bumps).  These
   * are overlaid on top of the procedural sine terrain — at low
   * intensities the obstacles are subtle modulation; at high
   * intensities they dominate the local profile.
   *
   * Obstacles are placed deterministically from the same seed so
   * a fixed-track run reproduces the same layout every gen.  None
   * appear inside the warmup pad.
   */
  obstacles: ObstacleConfig;
};

export type ObstacleConfig = {
  /**
   * Vertical wall intensity, 0..1.  At full strength: ≈ 2 m tall
   * thin posts that the chassis must climb over or jump.  Walls
   * are real Rapier colliders, not Y-profile modulation, so they
   * present a hard barrier with friction = wheel friction (cars
   * with strong wheels can lever themselves over).
   */
  wall: number;
  /**
   * Low-overhead ceiling intensity, 0..1.  At full strength: a
   * 4-m-wide horizontal beam ≈ 2.5 m above the local track surface.
   * Counters jumpy strategies — a chassis launching into the air
   * crashes into it.  Cars hugging the surface fit underneath.
   */
  ceiling: number;
  /**
   * Cliff (deep vertical-walled pit) intensity, 0..1.  Y-profile
   * only.  At low intensity: a narrow shallow dip a car bounces
   * over.  At full intensity: a 4-m-wide pit ≈ 8 m deep that a
   * small chassis falls straight into and can't climb out of.
   */
  cliff: number;
  /**
   * Slick-patch intensity, 0..1.  Track segments inside a slick
   * region have friction reduced from 1.0 to ≈ 0.05 — wheels lose
   * grip and slide.  Higher intensity = longer/denser regions.
   */
  slick: number;
};

/**
 * A physical obstacle placed by `placeObstacles` that needs its
 * own Rapier collider beyond the procedural ground polyline.
 * Position fields are in world coordinates.
 */
export type PhysicalObstacle =
  | { kind: 'wall'; x: number; height: number }
  | { kind: 'ceiling'; xCenter: number; halfWidth: number; y: number }
  | { kind: 'slick'; x1: number; x2: number }
  | {
      /**
       * The finish line at the very end of every track — a tall
       * vertical wall with a flag on top.  Always present (not
       * controlled by sliders); the renderer draws it with a
       * checkered finish-line stripe instead of the regular wall
       * red so the player reads it as "the goal" not "another
       * obstacle".
       */
      kind: 'finish';
      x: number;
      yBase: number;
      height: number;
    };

export type Track = {
  options: TrackOptions;
  points: { x: number; y: number }[];
  /**
   * X coordinate of the visual finish line — sits a few metres in
   * front of the finish wall in the basin.  Cars cross this x to
   * register a finishTime; the wall (at x = length) just stops them
   * physically afterwards.  Renderer draws a checkered marker here
   * so the player sees the "achievement" line clearly.
   */
  finishLineX: number;
  /**
   * Discrete physical obstacles (walls, ceilings) that need their
   * own Rapier colliders.  Computed in generateTrack alongside the
   * Y-profile and consumed by buildTrackColliders.  Pure-Y
   * obstacles (pits, bumps) are folded into `points` directly and
   * don't appear here.
   */
  physicalObstacles: PhysicalObstacle[];
};

const DEFAULT_TRACK: TrackOptions = {
  // 200 m default in v1.27 — short enough that gen 0's random
  // bodies still have a real shot at finishing, which gives the GA
  // a strong fitness signal almost immediately.  The Track-length
  // slider can crank it up to 2000 m if you want a longer haul.
  length: 200,
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
  /**
   * Obstacles default to off — turning them on at non-zero
   * intensities is a player choice via the track-tuning sliders.
   * This keeps the baseline track identical for anyone who hasn't
   * touched the new controls.
   */
  obstacles: {
    wall: 0,
    ceiling: 0,
    cliff: 0,
    slick: 0,
  },
};

/** Frequency where the high-frequency "sharpness" octaves wake up (m). */
const SHARPNESS_START = 80;
/**
 * Horizontal width (m) of the linear-blend zone at each pit edge.
 * Smaller = closer to a true vertical wall but more brittle for
 * the polyline-trapezoid colliders to handle.  At 0.05 m, the
 * standard 0.6 m sample step + a typical 4 m pit depth produces
 * a slope of ≈ tan⁻¹(4 / 0.6) = 81° — visually vertical, and
 * steep enough that a chassis can't push past horizontally.
 */
const CLIFF_EDGE_M = 0.05;
/**
 * Earliest world-x at which obstacles can spawn.  Same as the
 * sharpness gate — first 80 m is always smooth so cars get a
 * fair shot at building speed before facing local hazards.
 */
const OBSTACLE_START = 80;
/**
 * Finish-zone layout — kept deliberately simple after the v1.31.x
 * cliff + basin experiments.  Ambient terrain runs all the way to
 * the very end of the track, where a vertical wall blocks anything
 * past the finish line.  The visible finish marker sits a long
 * way *before* the wall so the wall reads as "here's where the
 * track ends" rather than "the wall and the finish are the same
 * thing".
 *
 *     0 ─────────── ambient terrain ────────── finishLineX ── runout ── length (wall)
 *                                                  │             │         ║
 *                                                  ▼             ▼         ║ wall (90°)
 *                                          dashed marker     run-out       ║
 */
/** Distance (m) from the visible finish-line marker to the wall at
 *  the very end of the track.  25 m gives finishers a generous
 *  run-out so the wall + finish marker read as separate elements;
 *  cars also get a comfortable braking / coasting distance after
 *  registering their finish. */
const WALL_RUNOUT_M = 25;
/** Vertical wall height (m) above the ambient ground at the
 *  track's end — tall enough that a chassis launching at full
 *  speed off any preceding hill can't clear it. */
const WALL_HEIGHT_M = 18;

/**
 * One placed terrain obstacle.  Currently only cliffs — deep
 * vertical-walled pits.  Folded directly into the `points`
 * array (Y-profile only); the polyline's near-vertical edges
 * give Rapier the vertical-wall behaviour for free, no extra
 * collider needed.  At 0.6 m sample step + 0.05 m edge
 * transition the resulting trapezoid sides slope at ≈ 86°
 * which a chassis can't easily climb.
 */
type PlacedObstacle = {
  kind: 'cliff';
  /** World-x of the pit's left edge. */
  x: number;
  /** Pit horizontal extent in metres. */
  width: number;
  /** Pit depth below ambient surface, metres. */
  depth: number;
};

/**
 * Lay out the obstacle list deterministically from `rng`.  Density
 * scales linearly with intensity: at 1.0 the average gap between
 * obstacles of one kind is ≈ 35 m; at 0.1 it's ≈ 350 m.  Each
 * obstacle's magnitude is a fraction of its kind's full strength
 * times a small RNG jitter so they aren't all identical.
 *
 * Obstacles never spawn inside the warmup pad or the early sharpness
 * window (first OBSTACLE_START metres) — same logic as the
 * procedural difficulty ramp: cars need a runway to evolve into
 * before they get punished by local hazards.
 *
 * Returns two lists: `terrain` (Y-profile pits/bumps that the
 * generateTrack loop folds into points) and `physical` (walls,
 * ceilings — anything that needs its own Rapier collider).
 */
function placeObstacles(
  rng: Rng,
  obstacles: ObstacleConfig,
  trackLength: number,
): { terrain: PlacedObstacle[]; physical: PhysicalObstacle[] } {
  const terrain: PlacedObstacle[] = [];
  const physical: PhysicalObstacle[] = [];
  // Average gap between obstacles of one kind, m.  Linear lerp
  // from 200 m (sparse hint at 1 % intensity) down to 12 m at
  // full strength — at 100 % a 1500 m track gets ≈ 125 obstacles
  // of that kind.
  const gapFor = (intensity: number): number => lerp(200, 12, intensity);

  // Cliffs — deep vertical-walled pits.  At low intensity: narrow
  // shallow dimples a car bounces over.  At full intensity: 8 m
  // wide × 8 m deep traps that even a 5 m wheel diameter can't
  // span on its own — the GA has to evolve a long-wheelbase chassis
  // (front + back wheel together bridging the gap) to cross.
  // Y-profile only — the polyline's near-vertical sides give the
  // wall behaviour for free.
  if (obstacles.cliff > 0) {
    const meanGap = gapFor(obstacles.cliff);
    let x = OBSTACLE_START + rng() * meanGap;
    while (x < trackLength - 8) {
      const intensity = obstacles.cliff;
      const width = lerp(0.5, 8.0, intensity) * (0.7 + rng() * 0.3);
      const depth = lerp(0.3, 8.0, intensity) * (0.7 + rng() * 0.3);
      terrain.push({ kind: 'cliff', x, width, depth });
      x += width + meanGap * (0.55 + rng() * 0.9);
    }
  }

  // Walls — vertical thin colliders.  Height scales 0.3..5 m with
  // intensity (low intensity = curb-sized bumps; full = a real
  // barrier only big-wheeled cars can roll over — a 5 m wall meets
  // the limit of the v1.28 wheel-diameter cap, so it's a
  // size-discriminating obstacle by design).  We don't pin them to
  // the track surface here because we don't have point Y at this
  // point in the pipeline; buildTrackColliders does the lookup.
  if (obstacles.wall > 0) {
    const meanGap = gapFor(obstacles.wall);
    let x = OBSTACLE_START + rng() * meanGap;
    while (x < trackLength - 5) {
      const height = lerp(0.3, 5.0, obstacles.wall) * (0.7 + rng() * 0.3);
      physical.push({ kind: 'wall', x, height });
      x += meanGap * (0.55 + rng() * 0.9);
    }
  }

  // Ceilings — horizontal beams above the track surface.  A car
  // hugging the ground passes underneath; one launching into the
  // air at this x slams into it.  Width and clearance both scale
  // with intensity: low = wide and high (easy to slip under), full
  // = narrow and low (must hit just right).
  if (obstacles.ceiling > 0) {
    const meanGap = gapFor(obstacles.ceiling);
    let x = OBSTACLE_START + rng() * meanGap;
    while (x < trackLength - 5) {
      const halfWidth = lerp(2.5, 1.0, obstacles.ceiling) * (0.8 + rng() * 0.4);
      // Clearance above local track surface, m.  Lower at higher
      // intensity → harder to pass.  At full intensity the
      // clearance floor is 0.9 m — a typical chassis is ≈ 1 m
      // tall, so 100 % ceilings are *meant* to be borderline
      // impossible to pass without hugging the surface exactly.
      const clearance = lerp(4.0, 0.9, obstacles.ceiling) * (0.85 + rng() * 0.3);
      // We stash clearance in `y` here — buildTrackColliders adds
      // the local track surface y so the absolute world-y can be
      // computed.  Mild abuse of the field but keeps the type
      // small; renderer treats this as the relative offset until
      // it samples the surface.
      physical.push({ kind: 'ceiling', xCenter: x, halfWidth, y: clearance });
      x += meanGap * (0.55 + rng() * 0.9);
    }
  }

  // Slick surface patches — span of x where the surface segments
  // get friction lowered to ~ 0.05 (near-ice).  Region length
  // scales 5..22 m with intensity.
  if (obstacles.slick > 0) {
    const meanGap = gapFor(obstacles.slick);
    let x = OBSTACLE_START + rng() * meanGap;
    while (x < trackLength - 5) {
      const length = lerp(5, 22, obstacles.slick) * (0.7 + rng() * 0.5);
      const x2 = Math.min(trackLength - 1, x + length);
      physical.push({ kind: 'slick', x1: x, x2 });
      x = x2 + meanGap * (0.55 + rng() * 0.9);
    }
  }

  // Drop walls that fall under (or right next to) a ceiling.  A wall
  // directly beneath a low ceiling is unbeatable: the car can't jump
  // over the wall (the ceiling blocks the arc) and can't drive under
  // the ceiling (the wall blocks the floor).  At max intensity walls
  // are now 5 m tall (v1.45) and ceilings hang 0.9 m above the
  // surface — the gap is hugely negative.  Even at moderate
  // intensities the geometry leaves the car nowhere to go.  Buffer
  // by 1 m on each side of the ceiling so the car has landing room
  // when exiting the ceiling tunnel before having to lever over a
  // wall.
  const CEILING_WALL_BUFFER_M = 1.0;
  for (let i = physical.length - 1; i >= 0; i--) {
    const p = physical[i]!;
    if (p.kind !== 'wall') continue;
    for (const c of physical) {
      if (c.kind !== 'ceiling') continue;
      if (
        p.x >= c.xCenter - c.halfWidth - CEILING_WALL_BUFFER_M &&
        p.x <= c.xCenter + c.halfWidth + CEILING_WALL_BUFFER_M
      ) {
        physical.splice(i, 1);
        break;
      }
    }
  }

  // Sort terrain by x so the per-track-point loop can stop scanning early.
  terrain.sort((a, b) => a.x - b.x);
  return { terrain, physical };
}

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
  // Obstacle list is built from the same RNG stream so placement is
  // a pure function of the seed.  This is intentional: a fixed-track
  // run reproduces the exact same hazard layout every generation,
  // which is how the GA gets to optimise against them.  Cap the
  // upper bound at `finishZoneStart` so no obstacles spawn inside
  // the cliff/basin/wall region — that area is reserved for the
  // finish line.
  // Keep procedurally-placed obstacles out of the run-out zone so
  // the player can read the finish-line + wall transition cleanly.
  const finishZoneStart = o.length - WALL_RUNOUT_M;
  const placed = placeObstacles(rng, o.obstacles, finishZoneStart);
  const obstacles = placed.terrain;
  const physicalObstacles = placed.physical;

  const points: { x: number; y: number }[] = [];
  // Captured the first time the loop crosses into the run-out zone;
  // re-used for every later sample so the polyline is a clean flat
  // line instead of inheriting the sine-wave Y.  Also feeds the
  // wall's `yBase` so the wall sits on the run-out surface.
  let yAtFinishZoneStart: number | null = null;
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
    // Cliffs are deep vertical-walled pits — when x is inside a
    // pit's [start, start + width] range, the surface drops to
    // -depth (relative to ambient).  At the very narrow edges
    // (CLIFF_EDGE_M wide on each side) we lerp from the ambient
    // y down to -depth so the polyline doesn't have a literal
    // discontinuity, but the slope is steep enough (≈ 86° at
    // 0.05 m edge × 0.6 m sample step × typical depths) that
    // visually it reads as a vertical wall and a small chassis
    // can fall straight in without climbing back out.
    for (const ob of obstacles) {
      if (ob.kind !== 'cliff') continue;
      const d = x - ob.x;
      if (d < 0 || d > ob.width) continue;
      const distFromLeftEdge = d;
      const distFromRightEdge = ob.width - d;
      if (distFromLeftEdge < CLIFF_EDGE_M) {
        const t = distFromLeftEdge / CLIFF_EDGE_M;
        y = lerp(y, -ob.depth, t) * baseRamp + (1 - baseRamp) * y;
      } else if (distFromRightEdge < CLIFF_EDGE_M) {
        const t = distFromRightEdge / CLIFF_EDGE_M;
        y = lerp(y, -ob.depth, t) * baseRamp + (1 - baseRamp) * y;
      } else {
        y = -ob.depth * baseRamp + (1 - baseRamp) * y;
      }
      // A point can be inside at most one cliff in normal
      // placement (gaps ≥ pit width), so it's safe to break.
      break;
    }
    // Run-out zone: from `finishZoneStart` to `length` the track
    // is held flat at whatever Y the terrain happened to be at the
    // start of the zone.  Gives a stable platform for finishers to
    // coast onto + a clear "here's the end" silhouette without a
    // dramatic cliff.
    if (x >= finishZoneStart) {
      if (yAtFinishZoneStart === null) yAtFinishZoneStart = y;
      y = yAtFinishZoneStart;
    }
    points.push({ x, y });
  }
  if (points[0]) points[0].y = 0;
  // Vertical wall at x = length, sitting on whatever Y the run-out
  // zone settled at.  Pushed onto the physical-obstacle list so
  // buildTrackColliders builds a real cuboid for it; the renderer
  // draws a matching grey vertical line so it reads as "the track
  // bends 90° upward".
  const wallY = yAtFinishZoneStart ?? 0;
  physicalObstacles.push({
    kind: 'finish',
    x: o.length,
    yBase: wallY,
    height: WALL_HEIGHT_M,
  });
  // Resolve absolute world-y for ceilings (their `y` field carries
  // the *relative* clearance during placement; we add the local
  // surface height now that the points array exists).
  //
  // Use the *maximum* surface height across the ceiling's full
  // [xCenter - halfWidth, xCenter + halfWidth] span — not just the
  // centre — so the configured clearance gene is the actual minimum
  // gap to the track everywhere under the beam.  Sampling at the
  // centre alone fails on rising terrain: a 5 m-wide beam over a
  // hill that climbs 1.5 m across that span ends up touching (or
  // below) the surface on the high side, becoming an impassable
  // hard wall instead of the intended overhead obstacle.
  const sampleStep = points.length > 1 ? points[1]!.x - points[0]!.x : 0.6;
  const resolved: PhysicalObstacle[] = physicalObstacles.map((p) => {
    if (p.kind === 'ceiling') {
      const left = p.xCenter - p.halfWidth;
      const right = p.xCenter + p.halfWidth;
      let maxSurfaceY = Math.max(sampleY(points, left), sampleY(points, right));
      const iLeft = Math.max(0, Math.floor(left / sampleStep));
      const iRight = Math.min(points.length - 1, Math.ceil(right / sampleStep));
      for (let i = iLeft; i <= iRight; i++) {
        const tp = points[i]!;
        if (tp.x < left) continue;
        if (tp.x > right) break;
        if (tp.y > maxSurfaceY) maxSurfaceY = tp.y;
      }
      return { ...p, y: maxSurfaceY + p.y };
    }
    return p;
  });
  return {
    options: o,
    points,
    finishLineX: o.length - WALL_RUNOUT_M,
    physicalObstacles: resolved,
  };
}

/** Linear-interpolated y at a given world-x against an even-spaced point list. */
function sampleY(points: { x: number; y: number }[], x: number): number {
  if (points.length < 2) return 0;
  const step = points[1]!.x - points[0]!.x;
  const idx = Math.floor(x / step);
  if (idx < 0) return points[0]!.y;
  if (idx >= points.length - 1) return points[points.length - 1]!.y;
  const a = points[idx]!;
  const b = points[idx + 1]!;
  const t = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
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

/**
 * The car's vertical reach below its chassis centre at spawn pose
 * (angle = 0).  Used to pick a safe spawn-Y above the track surface
 * — too-small a clearance lands the wheels inside the polyline and
 * the player sees them visibly clip through it on every gen-start.
 *
 * Returned as a positive distance.  Considers both the lowest
 * chassis vertex and every wheel's bottom extent (`anchor.y -
 * wheel.radius`).
 */
function carBottomExtent(g: Genome): number {
  const verts = chassisVertices(g);
  let minLocalY = 0;
  for (const v of verts) if (v.y < minLocalY) minLocalY = v.y;
  for (const wg of g.wheels) {
    const anchor = verts[wg.attachVertex];
    if (!anchor) continue;
    const wheelBottom = anchor.y - wg.radius;
    if (wheelBottom < minLocalY) minLocalY = wheelBottom;
  }
  return -minLocalY;
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
  /** True for cars that came in as a deep-cloned elite from the
   *  prev gen.  Read by the renderer for chassis tint + minimap
   *  tick colour. */
  isElite: boolean;
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
  /**
   * Sim time (in `ageSec` units) at which the chassis first crossed
   * the finish line at `track.options.length`, or null if it never
   * did.  Used by the speed-mode fitness function to reward fast
   * finishers; the car keeps physically running after this point
   * (it'll bump into the finish wall and stall normally), but its
   * time is recorded once and never updated again.
   *
   * Stored at sub-tick precision: when the chassis crosses the
   * line, we linearly interpolate between the previous-tick x
   * (lastTickX) and the current-tick x to find the fractional
   * moment within the tick when the crossing happened.  This lets
   * 0.01-s differences between two close finishers actually rank
   * apart instead of both snapping to the same 1/60-s tick boundary.
   */
  finishTime: number | null;
  /**
   * Chassis-centre x at the end of the previous game tick.  Used
   * for stall detection / progress tracking that doesn't care
   * about chassis size.
   */
  lastTickX: number;
  /**
   * Leading-edge world-x at the end of the previous game tick —
   * the maximum +x extent across all transformed chassis vertices
   * and all wheel rims.  When the leading edge crosses
   * `track.finishLineX` we lerp between this and the current
   * leading edge for sub-tick precision on `finishTime`.
   */
  lastTickLeadingX: number;
  /**
   * First snapshot built after the chassis + wheels were converted
   * to Fixed bodies (frozen).  Once latched, snapshotCar() returns
   * this object instead of re-reading every chassis/wheel field
   * each tick — the bodies are pinned so the values can't change.
   * Cleared back to null on world rebuild (next gen).
   */
  cachedSnap: CarSnapshot | null;
  /** Once true, motor is off and bodies are pinned in place forever. */
  finished: boolean;
  /**
   * True after the chassis + wheels have been converted to Fixed
   * bodies (one-shot transition, see freezeCar).  Lets the per-
   * substep loop detect "already frozen" without re-issuing the
   * Rapier setBodyType calls.
   */
  frozen: boolean;
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
  /**
   * Sim seconds from spawn at which the chassis first crossed the
   * track-end x.  null if the car never reached the finish.  Used
   * by the speed-mode fitness function (faster crossing = higher
   * fitness for the GA).
   */
  finishTime: number | null;
  /**
   * True for cars that started this gen as an elite carryover from
   * the previous gen.  Renderer tints these chassis warm so the
   * player can spot when last gen's champions are still on top vs
   * being overtaken by mutated children.
   */
  isElite: boolean;
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

/**
 * Per-step tuning, picked by the host based on the current speed
 * tier.  Lets ×64 / ×128 trade simulation precision for throughput
 * while ×1 / ×8 / ×32 stay on the v0.9.6 stable defaults.
 */
export type StepOptions = {
  /** Solver substeps per game tick (2 = stable, 1 = fast). */
  substeps?: number;
  /** Rapier per-step constraint iterations (8 = stable, 4 = fast). */
  solverIterations?: number;
  /**
   * When false, skip the periodic timeline-sample writes inside
   * step() — saves ~60 cars × ~5 entries / sim-second of allocation
   * + push/shift work that nobody will read at headless tiers (the
   * timeline is only useful when the player clicks a car for a
   * debug bundle, which they can't do without rendering).  Safety
   * events (velClamp / impulse-spike / finish) still record — those
   * are rare and matter for the post-hoc bundle if the player ever
   * drops back to ×1 to debug a car.
   */
  recordTimeline?: boolean;
};

export type WorldHandle = {
  step(opts?: StepOptions): void;
  snapshot(): WorldSnapshot;
  allFinished(): boolean;
  /**
   * Lightweight per-tick check used by the strict-det shortcut:
   * "is every still-alive car an elite (i.e. index < eliteCount)?"
   * Avoids building the full snapshot at high speeds where the
   * snapshot itself is the limiting cost.  Returns false if no cars
   * are alive (gen has ended).
   */
  allAliveAreElites(eliteCount: number): boolean;
  /** Number of cars currently still moving.  Cheap — no snapshot. */
  aliveCount(): number;
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
  /**
   * Strict-determinism mode: give each car its own isolated Rapier
   * world (with its own copy of all track colliders) so the same seed
   * produces bit-identical results across runs.
   *
   * Why this matters: Rapier's broadphase iterates contact pairs in
   * an order that depends on body insertion sequence and the current
   * position of every body in the world.  With 60 cars sharing one
   * world the FP paths of pairwise contact tests subtly diverge from
   * run to run — even though chassis-vs-chassis contacts are filtered
   * out by collision groups, each car's contact-with-track resolution
   * still observes a slightly different float graph.  The leader of
   * gen 5 can travel 200 m one run and 65 m the next on the same
   * (trackSeed, generation, gaSeed) inputs.
   *
   * Per-car worlds break that coupling: each car sees only its own
   * bodies + the track, so its trajectory is purely a function of its
   * genome.  Determinism becomes complete.
   *
   * Cost: ~60× the track colliders (still small in absolute terms —
   * ≈ 36 MB at 600 colliders × 60 cars), and 1.5–2× CPU per game tick
   * (each world has its own broadphase + integrator).  Default OFF;
   * the player toggles it via the UI when they want repeatable runs.
   */
  isolated?: boolean;
  /**
   * How many of the leading genomes are deep-cloned elite carryover
   * from the previous generation.  By construction (population.ts /
   * nextGeneration), these are at indices 0..eliteCount-1 of the
   * `genomes` array.  Used purely for rendering — the per-car
   * `isElite` flag in CarSnapshot lets the renderer tint elite
   * chassis warm so the player can see whether last gen's champions
   * are still leading or being overtaken.  Pass 0 for gen 0 (no
   * carryover from anywhere).
   */
  eliteCount?: number;
};

export async function createWorld(opts: CreateWorldOptions): Promise<WorldHandle> {
  await ensureRapier();
  const isolated = opts.isolated ?? false;

  // `worlds` is the set of unique Rapier worlds we own (1 in shared
  // mode, N in isolated mode).  `carWorld[i]` maps each car index
  // to its world — same reference for every i in shared mode, a
  // distinct world per i in isolated mode.  Step / contact / destroy
  // all key off these two arrays so the rest of the code path is
  // mode-agnostic.
  const worlds: RAPIER.World[] = [];
  const carWorld: RAPIER.World[] = [];

  const makeWorld = (): RAPIER.World => {
    const w = new RAPIER.World({ x: 0, y: -GRAVITY });
    // Each physics call advances by SIM_DT / SUBSTEPS so the per-game-
    // tick total is still SIM_DT, just split across multiple solver
    // passes for smoother contact resolution.
    w.timestep = SIM_DT / PHYSICS_SUBSTEPS;
    // More iterations than the default 4: a stiff scene of heavy
    // chassis + heavy wheels + revolute joints needs the extra passes
    // to converge each step and avoid the explosive ejections that
    // launch cars to the moon.
    w.integrationParameters.numSolverIterations = TUNING.solver.numIterations;
    buildTrackColliders(w, opts.track);
    return w;
  };

  if (isolated) {
    for (let i = 0; i < opts.genomes.length; i++) {
      const w = makeWorld();
      worlds.push(w);
      carWorld.push(w);
    }
  } else {
    const w = makeWorld();
    worlds.push(w);
    for (let i = 0; i < opts.genomes.length; i++) carWorld.push(w);
  }

  const sx = opts.spawnX ?? 8;
  const trackY = sampleTrackY(opts.track, sx);

  const eliteCount = opts.eliteCount ?? 0;
  const cars: CarRuntime[] = opts.genomes.map((g, i) => {
    // Per-car spawn-Y clearance.  A global "3.2 m above the track"
    // (the old v1.11 value) was sized for chassis radius ≤ 1.8 m
    // and wheel radius ≤ 1.2 m.  Since the v1.28 size envelope
    // bumped both caps (chassis 3.5, wheel 2.5), a max-size car's
    // lowest point can sit ≈ 6 m below the chassis centre — at
    // 3.2 m clearance the wheels spawned *inside* the polyline
    // and visually clipped through it before the impulse-spike
    // clamp could nudge them up.  Compute the actual bottom
    // extent from the genome and add a small air-gap so every
    // car spawns with the same little gap above the surface
    // regardless of size.  Small cars therefore start close to
    // the ground; huge cars start higher and drop in.
    const sy = trackY + carBottomExtent(g) + 0.5;
    return buildCar(carWorld[i]!, g, i, sx, sy, i < eliteCount);
  });

  let time = 0;

  return {
    step(stepOpts): void {
      // Per-tier physics knobs: lower substeps + iterations on
      // ×64 / ×128 for ~2-3× throughput; ×1..×32 use the stable
      // v0.9.6 defaults (2 substeps, 8 iterations).
      const substeps = stepOpts?.substeps ?? PHYSICS_SUBSTEPS;
      const solverIter = stepOpts?.solverIterations ?? TUNING.solver.numIterations;
      const wantTimeline = stepOpts?.recordTimeline ?? true;
      const subDt = SIM_DT / substeps;
      for (const w of worlds) {
        w.timestep = subDt;
        w.integrationParameters.numSolverIterations = solverIter;
      }
      for (let s = 0; s < substeps; s++) {
        for (let i = 0; i < cars.length; i++) {
          const car = cars[i]!;
          if (car.finished) {
            freezeCar(car);
            continue;
          }
          updateWheelContacts(car, carWorld[i]!);
          updateAirborneDamping(car);
          applyMotor(car);
        }
        for (const w of worlds) w.step();
        for (const car of cars) {
          if (!car.finished) clampImpulseSpike(car, opts.track, time + (s + 1) * subDt);
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
        // First time the *leading edge* of the car crosses the
        // visual finish line: stamp the finish time.  Players read
        // the screen and expect the timer to fire when the visible
        // nose touches the line, not when the chassis centre does
        // — at chassis radius 3.5 m + wheel 2.5 m the centre can
        // be 5+ m behind the visible front.
        //
        // Sub-tick interpolation: the leading edge moves several cm
        // per tick, so snapping finishTime to the discrete tick
        // boundary (multiples of 1/60 s) loses precision a 0.01-s
        // ranking would care about.  Lerp the crossing moment
        // between lastTickLeadingX (start of tick) and the current
        // leading edge (end of tick) and weight the tick's SIM_DT
        // by that fraction.
        const leadingX = leadingEdgeX(car);
        if (car.finishTime === null && leadingX >= opts.track.finishLineX) {
          const prevLeading = car.lastTickLeadingX;
          const dLead = leadingX - prevLeading;
          const fraction =
            prevLeading < opts.track.finishLineX && dLead > 0
              ? (opts.track.finishLineX - prevLeading) / dLead
              : 1;
          car.finishTime = car.ageSec - SIM_DT + fraction * SIM_DT;
        }
        car.lastTickX = x;
        car.lastTickLeadingX = leadingX;
        clampInsaneVelocity(car, opts.track, time);
        const wasFinished = car.finished;
        updateLifecycle(car);
        // Record a periodic sample for this car.  If updateLifecycle
        // just promoted us to "finished", always record a finish
        // event so the timeline ends with a clear "this is when it
        // stopped" marker (even when periodic sampling is off).
        if (!wasFinished && car.finished) {
          recordTimeline(car, opts.track, time, 3);
        } else if (wantTimeline) {
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
    allAliveAreElites(eliteCount: number): boolean {
      let alive = 0;
      for (const car of cars) {
        if (car.finished) continue;
        alive++;
        if (car.index >= eliteCount) return false;
      }
      return alive > 0;
    },
    aliveCount(): number {
      let c = 0;
      for (const car of cars) if (!car.finished) c++;
      return c;
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
      for (const w of worlds) w.free();
    },
  };
}

/* ─── Track colliders ──────────────────────────────────────────────────── */

function buildTrackColliders(world: RAPIER.World, track: Track): void {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // Pre-collect slick regions so we can split the surface polyline
  // along friction boundaries.
  const slickRegions: { x1: number; x2: number }[] = [];
  for (const ob of track.physicalObstacles) {
    if (ob.kind === 'slick') slickRegions.push({ x1: ob.x1, x2: ob.x2 });
  }
  const isSlickAt = (x: number): boolean => {
    for (const r of slickRegions) if (x >= r.x1 && x <= r.x2) return true;
    return false;
  };

  // Track surface is one polyline collider per friction "run" (a
  // contiguous span of segments that share friction).  In v1.18 we
  // had ~833 trapezoid colliders (one per segment); replacing those
  // with O(1)-O(5) polylines cuts broadphase pair tests by two
  // orders of magnitude — the dominant per-step cost at high speed
  // multipliers.
  //
  // The v0.9.x version of this code went the trapezoid route to
  // dodge "thin polyline + heavy chassis tunnels through and the
  // solver ejects it 30 m up".  Modern safeguards (CCD on every
  // body, clampImpulseSpike per substep, clampInsaneVelocity, 8
  // solver iterations) keep that failure mode rare.  The catcher
  // floor below catches the rare tunneller and stall logic finishes
  // it off — far better trade than 100× more colliders all the
  // time.
  const segCount = track.points.length - 1;
  if (segCount > 0) {
    const segCenter = (i: number): number =>
      (track.points[i]!.x + track.points[i + 1]!.x) / 2;
    let runStart = 0;
    let runSlick = isSlickAt(segCenter(0));
    const flush = (endIdx: number, slick: boolean): void => {
      // Build a polyline from track.points[runStart..endIdx] (inclusive).
      const count = endIdx - runStart + 1;
      if (count < 2) return;
      const verts = new Float32Array(count * 2);
      for (let j = 0; j < count; j++) {
        const p = track.points[runStart + j]!;
        verts[j * 2] = p.x;
        verts[j * 2 + 1] = p.y;
      }
      const desc = RAPIER.ColliderDesc.polyline(verts);
      desc
        .setFriction(slick ? 0.05 : 1.0)
        .setRestitution(0.05)
        .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CHASSIS | GROUP.WHEEL));
      world.createCollider(desc, ground);
    };
    for (let i = 1; i < segCount; i++) {
      const segSlick = isSlickAt(segCenter(i));
      if (segSlick !== runSlick) {
        flush(i, runSlick);
        runStart = i;
        runSlick = segSlick;
      }
    }
    flush(segCount, runSlick);
  }

  // Catcher floor — large flat cuboid far below the surface that
  // catches any chassis that tunnels through the polyline (rare but
  // possible at extreme velocities or low-substep modes).  The car
  // stalls down here and the lifecycle finishes it normally.
  const trackLen = track.options.length;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(trackLen / 2 + 100, 1)
      .setTranslation(trackLen / 2, -100)
      .setFriction(0.5)
      .setRestitution(0)
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

  // Physical obstacles — walls and ceilings.  Each is a small fixed
  // cuboid hung off the same ground rigid body as the surface
  // colliders, sharing the same collision groups so cars treat them
  // identically to the rest of the track.
  for (const ob of track.physicalObstacles) {
    if (ob.kind === 'wall') {
      // Half-thickness 0.05 m (= 10 cm wide post), sitting on the
      // surface y so the bottom is flush with the track.  Friction
      // matches the ground; cars with strong wheels can climb over.
      const surfaceY = sampleTrackY(track, ob.x);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.05, ob.height / 2)
          .setTranslation(ob.x, surfaceY + ob.height / 2)
          .setFriction(1.0)
          .setRestitution(0.0)
          .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CHASSIS | GROUP.WHEEL)),
        ground,
      );
    } else if (ob.kind === 'ceiling') {
      // Ceiling: thin horizontal cuboid centred at (xCenter, y).
      // Half-thickness 0.08 m makes a clearly visible beam.
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(ob.halfWidth, 0.08)
          .setTranslation(ob.xCenter, ob.y)
          .setFriction(0.6)
          .setRestitution(0.0)
          .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CHASSIS | GROUP.WHEEL)),
        ground,
      );
    } else if (ob.kind === 'finish') {
      // End-of-track wall: a thin vertical cuboid sitting on the
      // ambient run-out surface.  Half-thickness 0.05 m (= 10 cm
      // wide) so it reads as a continuation of the track's grey
      // line bending 90° upward, not a chunky rectangular slab.
      // Friction and restitution match the ground so a chassis
      // crashing into it stops cleanly.
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.05, ob.height / 2)
          .setTranslation(ob.x, ob.yBase + ob.height / 2)
          .setFriction(1.0)
          .setRestitution(0.0)
          .setCollisionGroups(packGroups(GROUP.TRACK, GROUP.CHASSIS | GROUP.WHEEL)),
        ground,
      );
      // Slick patches don't get their own collider — they modify
      // the friction of the surface trapezoids in the segment
      // loop above.  The renderer draws an overlay so the player
      // sees where they are.
    }
  }
}

/* ─── Car builder ──────────────────────────────────────────────────────── */

function buildCar(
  world: RAPIER.World,
  genome: Genome,
  index: number,
  spawnX: number,
  spawnY: number,
  isElite: boolean,
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
    // Rolling-resistance proxy.  Real-world rolling resistance scales
    // ≈ 1/r — bigger wheels lose less energy per revolution because
    // each revolution covers more ground.  Rapier doesn't model this
    // out of the box, so we approximate it via per-body angular
    // damping inversely proportional to wheel radius.  A 0.18 m wheel
    // (the smallest possible) ends up at ≈ 5× the baseline damping,
    // a 1.0 m wheel sits at the baseline, a 1.2 m wheel slightly
    // below.  Without this nudge evolution always converges on the
    // smallest wheels because they're light and accelerate fast;
    // with it, big wheels gain a continuous energy edge that
    // compounds over the track and rewards size organically.
    const wheelAngularDamping = TUNING.wheel.angularDamping / Math.max(0.2, wg.radius);
    const wb = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawnX + anchor.x, spawnY + anchor.y)
        .setLinearDamping(TUNING.wheel.linearDamping)
        .setAngularDamping(wheelAngularDamping)
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
    isElite,
    maxX: spawnX,
    ageSec: 0,
    lastProgressTime: 0,
    lastProgressX: spawnX,
    finishTime: null,
    lastTickX: spawnX,
    // Init the leading-edge tracker to spawnX (a generous lower
    // bound — the real value is `spawnX + maxLocalRadius` ≈
    // spawnX + 3.5 m at most, still ≪ finishLineX for any
    // playable track length).  The very first physics tick
    // overwrites this with the correct leadingEdgeX(car) value
    // before the finish-line check can fire.
    lastTickLeadingX: spawnX,
    cachedSnap: null,
    finished: false,
    frozen: false,
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

/**
 * Maximum +x extent of any visible part of the car right now —
 * the chassis polygon (transformed from local to world by the
 * current pose) and every wheel rim (`wheelPos.x + wheel.radius`).
 * Used by the finish-line crossing check so the timer fires the
 * moment the car's *visible front edge* touches the marker, not
 * when the chassis centre does.
 */
function leadingEdgeX(car: CarRuntime): number {
  const pos = car.chassis.translation();
  const angle = car.chassis.rotation();
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let maxX = pos.x;
  for (const v of car.vertices) {
    const wx = pos.x + v.x * cos - v.y * sin;
    if (wx > maxX) maxX = wx;
  }
  for (const w of car.wheels) {
    const wPos = w.body.translation();
    const wMaxX = wPos.x + w.radius;
    if (wMaxX > maxX) maxX = wMaxX;
  }
  return maxX;
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
 * Convert a finished car's bodies to Fixed so Rapier excludes
 * them from the dynamic solver entirely.  One-shot — guards on
 * `frozen` so repeated calls (the per-substep loop checks every
 * finished car) cost only a flag read.  v1.6 perf fix: previously
 * we zeroed linvel/angvel on every substep × every wheel × every
 * finished car, which was hundreds of API calls per game tick;
 * Fixed bodies need none of that.
 *
 * Cars don't collide with each other anyway (group filter limits
 * chassis/wheel contacts to TRACK only), so leaving them dynamic
 * vs fixed has no gameplay effect on still-running neighbours.
 */
function freezeCar(car: CarRuntime): void {
  if (car.frozen) return;
  car.frozen = true;
  car.chassis.setBodyType(RAPIER.RigidBodyType.Fixed, true);
  for (const w of car.wheels) {
    w.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
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
  // Frozen cars are pinned in place by Rapier — chassis + wheel
  // positions / angles / on-ground flags can't change any more.
  // Once we've built a snap for this car post-freeze, reuse it on
  // every subsequent call instead of paying for ~10 Rapier reads
  // and a fresh allocation per car per UI tick.  Late-gen ticks
  // (when most cars are dead but the leader is still going) are
  // dominated by snapshot work — this is the cheapest big win for
  // headless throughput.
  if (car.cachedSnap !== null) return car.cachedSnap;
  const pos = car.chassis.translation();
  const vel = car.chassis.linvel();
  const snap: CarSnapshot = {
    index: car.index,
    position: { x: pos.x, y: pos.y },
    velocity: { x: vel.x, y: vel.y },
    angle: car.chassis.rotation(),
    speed: Math.hypot(vel.x, vel.y),
    travel: Math.max(0, car.maxX - car.spawnX),
    finished: car.finished,
    finishTime: car.finishTime,
    isElite: car.isElite,
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
  if (car.frozen) car.cachedSnap = snap;
  return snap;
}
