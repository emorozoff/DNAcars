# DNAcars — handoff for the next session

Snapshot of project state + open ideas, captured at v1.49.0 on branch
`claude/fix-car-physics-OoJYe`.

## Quick orientation

- **Monorepo** with npm workspaces: `apps/web`, `apps/server`,
  `packages/shared`. The game is `apps/web`; server is a thin
  Cloudflare Worker (not actively developed).
- **Stack**: TypeScript strict, Vite, Pixi.js v8 (rendering),
  Rapier 2D WASM (physics), nanostores (i18n state).
- **Run**: `npm run dev` from repo root → starts Vite on the web
  workspace. `npm run typecheck` and `npm run build` are
  workspace-wide (run on server + web + shared).
- **Branch policy** for this repo: develop on
  `claude/fix-car-physics-OoJYe`. Don't push elsewhere.

## Where things live

| Concern | File |
|---|---|
| Main entry, GA loop, session lifecycle, controls wiring | `apps/web/src/main.ts` |
| Physics + track gen + car runtime | `apps/web/src/sim/world.ts` |
| Pixi rendering + camera | `apps/web/src/render/scene.ts` |
| Minimap | `apps/web/src/render/minimap.ts` |
| GA pipeline (selection, crossover, mutation, population) | `apps/web/src/ga/*.ts` |
| Stats charts (hero / speed / stall heatmap / genome / insights / finish-dist) | `apps/web/src/stats/charts.ts` |
| Per-gen aggregate stats | `apps/web/src/stats/collector.ts` |
| Tutorial (stage 1 = walkthrough modal, stage 2 = self-contained mini-GA) | `apps/web/src/tutorial/` |
| i18n dictionaries | `apps/web/src/i18n/{en,ru}.ts` |
| Global CSS | `apps/web/src/styles/global.css` (long; split if it grows much more) |
| HTML shell | `apps/web/index.html` |

## Recent work — last ~20 commits, themed

**Mobile + touch UX (v1.34–v1.36)**
- v1.34.0: pinch-to-zoom on canvas, `overscroll-behavior: none`,
  ≤640 px portrait media query.
- v1.35.0: scrap "canvas fills stage with absolute chrome" on
  phone; switch to `body { overflow: auto }` + `#app { display:
  flex; flex-direction: column }` so the page scrolls (canvas →
  minimap → ribbon-stats → dock → charts).
- v1.35.1 + v1.36.1: keep + reposition the "follow leader"
  floating button inside the canvas section.
- v1.36.0: throttle HUD text writes to 4 Hz separately from scene
  render, deadband-skip DOM writes when string didn't change, cap
  Pixi ticker at 60 fps for ProMotion iPhones. Killed flicker on
  the "темп" / leader / alive readouts.

**Camera framing (v1.38, v1.43)**
- v1.38.0: vertical anchor adapts to canvas aspect (0.72 wide,
  0.55 portrait); camera follows the chassis polygon's *visual
  centroid* (`visualCenter` in scene.ts) instead of the body's
  physics-anchor position so asymmetric shapes don't render
  off-centre.
- v1.43.0: cap leader-follow camera at `finishLineX`. Finished
  cars freeze visually at the line but their physical body keeps
  rolling — the camera no longer follows the live chassis past
  the marker.

**Finish-line behaviour (v1.40, v1.42, v1.49 chain)**

Finishing went through several iterations the player asked us to
break into stages:

1. v1.40.0 / v1.40.1 — drop the celebration animation. Finishers
   fade to alpha 0.4 + neutral white tint and freeze (`finalDrawn`
   latches the moment a car gets `finishTime !== null`, *not*
   when `car.finished` becomes true on stall). Physics keeps
   rolling the chassis but the renderer stops following it.
2. v1.41.0 — drop the `hideFinished` and `renderTopOnly` toggles.
   v1.40.1 made the first redundant; the second was a perf
   optimisation that didn't pull its weight.
3. v1.42.0 — leading-edge finish detection. New `leadingEdgeX(car)`
   helper iterates transformed chassis verts + wheel rim extents;
   finish triggers when the *visible front* touches the line, not
   when the chassis centre crosses. Also new
   `CarRuntime.lastTickLeadingX` for sub-tick precision.
4. v1.43.0 — drop "Pure mutation" GA toggle (it never produced
   better cars than the default crossover + roulette pipeline)
   and cap the leader-follow camera at `finishLineX` (see above).

**Track + obstacles (v1.45–v1.49)**

- v1.45.0: bump cliff width 0.5..4 → 0.5..8 m and wall height
  0.3..2 → 0.3..5 m at full intensity. The new ranges meet the
  v1.28 chassis/wheel size envelope so the obstacles actually
  discriminate between car sizes.
- v1.46.0: stairs obstacle. Folded into polyline as a symmetric
  pyramid (climb up + step down), `stepH` 0.4..2.5 m.
  `PlacedObstacle` is now a `cliff | stairs` union.
- v1.47.0: tunnel obstacle. Reuses `kind: 'ceiling'` collider +
  renderer; placer uses long-low parameter ranges (5..15 m
  halfwidth, 0.6..2 m clearance) so it reads as a tight passage.
- v1.48.0: mud surface. Same shape as `slick` but friction is
  bumped *up* (2.5) instead of down. Surface classifier in
  `buildTrackColliders` is now a 3-state enum
  (`'ambient' | 'slick' | 'mud'`) with a `frictionFor` map.
  Renderer paints brown overlay (`COLORS.mud = 0x8a5a3c`).
- v1.49.0: zigzag obstacle. Sequence of 4..8 alternating walls
  + ceilings every 2.2..4 m (much closer than regular
  placement). Pushed *after* the wall-under-ceiling buffer
  cleanup pass so the tight pattern survives — zigzag is
  hand-tuned to stay passable at that spacing.

**Stats panel layout (v1.39)**
- ribbon-stats moved from top-left to bottom-left so only the
  minimap stays at the top of the stage. Mobile flex column
  unaffected (already overrides position to static).
- Difficulty slider now starts at 0 (was 1) → 0 % yields a
  perfectly flat track.
- Finish-line marker grew 4 m → 100 m so it reads as effectively
  infinite at any zoom.

## Useful TUNING constants (apps/web/src/sim/world.ts)

These are the gene-cap and physics knobs you'll most often want
to know about / tweak:

```ts
chassis.minRadius / maxRadius:       0.35  / 3.5
chassis.minDensity / maxDensity:     250   / 300
chassis.linearDamping:               0.65  // base air drag
chassis.airborneLinearDamping:       1.5
chassis.airborneAngularDamping:      2.0

wheel.minRadius / maxRadius:         0.18  / 2.5
wheel.minCount / maxCount:           1     / 4
wheel.minMotorFrac / maxMotorFrac:   0.2   / 1.0  (mapped from `power` gene)

motor.minSpeed / maxSpeed:           8     / 18  rad/s  (target ω)
motor.torqueHeadroom:                1.8

lifecycle.maxGenerationSec:          ~600  (per-gen wall budget)
lifecycle.progressEpsilon:           0.10  (stall detector floor)

PHYSICS_SUBSTEPS:                    2
SIM_DT:                              1/60
SPAWN_X (in main.ts):                6
WALL_RUNOUT_M (in world.ts):         25
WALL_HEIGHT_M:                       18
```

Per-tier render/physics knobs in `main.ts SPEED_STATES`:

```
×1   substeps 2 / iter 8 / uiThrottle 0   ms / not headless
×8   substeps 2 / iter 8 / uiThrottle 33  ms / not headless / lite tier
×32  substeps 2 / iter 8 / uiThrottle 100 ms / headless
×64  substeps 1 / iter 4 / uiThrottle 150 ms / headless
×128 substeps 1 / iter 4 / uiThrottle 200 ms / headless
```

## Things in flight / open ideas — captured for later

### Track-physics tunability (the conversation we paused on)

Player asked about the optimal *flat-track speed* car. Worked out
the physics:

```
v_steady = motorSpeed × wheelRadius                    (ω cap)
v_drag   = (powerPerWheel × wheelCount × g × 1.8)
           / linearDamping                             (drag balance)
```

At max gene values: `v_ω = 18 × 2.5 = 45 m/s ≈ 162 km/h`. With 2
wheels this exceeds the drag-balanced speed, so the actual cap is
**45 m/s, ω-limited**.

Player proposed "smaller wheels + more power = faster". Reality:
smaller wheels lower the ω cap, so they're slower. Long wheelbase
(anti-wheelie) is genuinely useful for stability though. Power is
already at max in their car (visible by stroke thickness).

**If they want >45 m/s top speed, raise the caps**:
- `motor.maxSpeed` 18 → 30+ rad/s
- `wheel.maxRadius` 2.5 → 4+ m

**Risk**: the physics solver might start mis-resolving collisions
at extreme velocities (wheels punching through the polyline, the
impulse-spike clamp triggering). Recommended approach: bump
incrementally, watch for spike-clamp activations in the timeline,
back off if the car ever ejects on contact.

This is the conversation we paused mid-discussion — they said
"пока просто обсуждаем" (just discussing for now). Pick up there.

### Other obstacles we discussed but didn't build

These came up when we were brainstorming new obstacle types but
the player only picked stairs / tunnel / mud / zigzag from that
list. The rest are still open if interest returns:

- **Seesaw / tilting platform**: a track segment with a pivot in
  the middle. Light cars don't tip it; heavy cars send it
  collapsing. Would need a Rapier `RevoluteJoint` between a
  fixed pivot and a kinematic platform body.
- **Suspension / hanging bridge**: a track segment built from
  N small segmented platforms linked by joints, sagging under
  weight. Heavy cars sink and fall through the gap, light cars
  ride across.
- **Conveyor belt**: a surface span that injects horizontal
  velocity at contact. Pushed-forward = motor test, pushed-back
  = grip + power test.
- **Loop-de-loop**: a vertical loop in the polyline. Cars below
  loop-speed fall off. Tests sustained motor + power.
- **Bouncy pad**: high-restitution patch (existing `slick` /
  `mud` branch already handles per-segment restitution, so this
  is a small extension).

### Track presets

Player liked the idea of preset packages on top of the slider
mix. Each is a one-click bundle:

- **«Гонка»** — long flat track (length 1500 m, difficulty 0,
  minimal obstacles).
- **«Полоса препятствий»** — short (200 m), all four new
  obstacles at moderate intensity.
- **«Гора»** — sustained 5–10° upslope. Currently no
  primitive for this; would need a flag in `TrackOptions` that
  adds a linear y-gradient to the polyline.
- **«Долина»** — descent then ascent. Same primitive as «Гора»
  but mirrored.

Pretty cheap to wire — just a "preset" selector that writes to
the existing `trackTuning` knobs.

### Solo replay mode (variant B of show-only-leader)

We implemented variant A (visual hide of non-leader cars) in
v1.44.0. Variant B is the more involved version:

- Toggle *pauses* the GA + spawns a single-car physical session
  with the latest elite genome. The lonely car runs solo on the
  track until the player toggles back.
- Frees CPU since only one Rapier world is simulated.
- Avoids the "phantom leader change" edge case where a hidden
  car overtakes and the camera jumps to a new invisible target.

Would require: a separate session-lifecycle path that bypasses
`nextGeneration`, plus a way to resume the original session
state when the toggle goes off.

### Things to clean up

Not bugs, just hygiene if a quiet day happens:

- `scene.ts` is ~1000 lines and growing. Splitting into
  `camera.ts`, `carView.ts`, `obstaclesView.ts`, `parallax.ts`
  would help.
- `world.ts` is even bigger (~2k). Track-gen, car-build, motor,
  physics-step are reasonable extraction candidates.
- The genome's `chassisVertices(g)` helper is duplicated in
  spirit by the renderer (which holds local vertex coords too)
  + `carBottomExtent` + `leadingEdgeX`. A single
  "transformed-vertices iterator" might consolidate them.
- `i18n` files are flat key/value; consider grouping by section
  (`panel.*`, `chart.*`, `tutorial.*`) into separate dicts.

### Recently rejected / removed (don't re-add without thinking)

- **Pure-mutation GA mode** — clones-of-the-elite + skip
  crossover. Removed in v1.43.0. In practice the population
  collapsed to clones within a few gens and never produced
  better cars than the default pipeline.
- **`hideFinished` toggle** — removed in v1.41.0. v1.40.1's
  freeze-on-cross made it redundant; the `finalDrawn` fast path
  already skips per-frame work.
- **`renderTopOnly` toggle** (top-K culling) — removed in
  v1.41.0. The CPU savings didn't materialise because physics
  dominates per-frame cost, not Pixi attribute writes.
- **Click-to-debug-bundle on cars** — removed back in v1.23.0.
  Don't bring back; the `panel.cameraLeader` + minimap-click
  picking already cover the "look at this car" use case.
- **Cliff + basin + striped-flag finish** — removed in v1.37.0
  for the simpler "track-line-bends-90°-up" wall + dashed white
  finish marker.

## Common gotchas

- **Strict-determinism elite cache**: the cache (`eliteCache` in
  main.ts) stores `{ fitness, finishTime, travel }` per top-N
  elite, keyed by track-config hash. Toggling speed-mode flips
  the hash; track-tuning changes flip it; `freshRun()` clears it.
  If you ever extend the GA scoring / fitness, also extend the
  cache so the fast-forward shortcut keeps producing correct
  numbers.
- **`travel` vs `fitness`**: `travel = chassis.maxX - spawnX`,
  always in metres. `fitness` is the GA selection score —
  default = travel, in speed mode = `trackLength + 1 + (1000 -
  finishTime)` for finishers. The dashboard charts use `travel`
  to keep axes in metres regardless of mode; fitness is internal
  to selection.
- **Per-car spawn-Y**: `sy = trackY + carBottomExtent(g) + 0.5`
  (per-genome). If you ever add a new wheel / chassis attachment
  rule, update `carBottomExtent` to include its bottom extent
  too — otherwise huge cars spawn inside the track.
- **`travel` is *not* updated by the fast-forward shortcut**:
  the live travel field reflects however far the chassis got
  before the shortcut force-finished it. Cache the true travel
  alongside fitness/finishTime if you ever need monotonic
  best-distance.

## Versioning

- Whenever shipping a player-visible change, bump every
  package.json (`package.json`, `apps/web/package.json`,
  `apps/server/package.json`, `packages/shared/package.json`)
  to the same version, then commit + push.
- Breaking-style changes (track regeneration that invalidates
  cache, GA changes, big physics tunables) → minor bump.
  Cosmetic / bugfix → patch bump. We've used minor liberally
  during this session — that's fine for an iterative game.

## Reference: most-recent commit chain

```
v1.49.0  zigzag obstacle
v1.48.0  mud surface
v1.47.0  narrow tunnel
v1.46.0  stairs
v1.45.0  wider cliffs + taller walls
v1.44.0  show-only-leader toggle
v1.43.0  drop pure-mutation + cap leader-follow at finishLineX
v1.42.0  leading-edge finish detection
v1.41.0  drop hideFinished + renderTopOnly toggles
v1.40.1  finishers freeze visually at the line (latch on cross, not stall)
v1.40.0  finishers fade + freeze (no celebration)
v1.39.1  per-car spawn-Y so big wheels don't clip the track
v1.39.0  stats panel to bottom + tall finish + flat-track 0%
v1.38.0  aspect-aware vertical anchor + visual-centroid camera
v1.37.0  simpler finish geometry — wall as track-line, dashed marker
```
