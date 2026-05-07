/**
 * App bootstrap.
 *
 * Glues four pieces together:
 *
 *   1. Physics — apps/web/src/sim/world.ts.  Spawns N cars on a hilly
 *      track, ticks physics, fires "finished" when each car stalls.
 *   2. Renderer — apps/web/src/render/scene.ts.  Pixi.js, draws
 *      track + cars, camera follows the lead runner, exposes a
 *      click-on-car hook for debug-bundle copy.
 *   3. GA — apps/web/src/ga/.  Selection / crossover / mutation that
 *      turns the *previous* generation's fitness vector into the
 *      *next* generation's genomes.
 *   4. UI — index.html.  HUD overlays: stats card, controls card with
 *      sliders, restart + speedup buttons.
 *
 * Generation lifecycle:
 *
 *   gen 0 ─→ random genomes
 *   gen N ─→ nextGeneration(prev fitnesses) via GA
 *   ▼
 *   simulate until everyone has stalled (or 60 s cap)
 *   ▼
 *   record (genome, fitness) for each car
 *   ▼
 *   short visual pause, then restart with next gen
 *
 * Click on any car at any time → its full debug bundle (track seed,
 * generation, genome, current snapshot) is copied to the clipboard
 * as JSON, suitable for pasting into a bug report.
 */

import './styles/global.css';
import { $locale, applyTranslations, bindLanguageToggle, t } from './i18n';
import {
  createWorld,
  ensureRapier,
  generateTrack,
  makeRng,
  randomGenome,
  sampleTrackY,
  SIM_DT,
  TUNING,
  type Genome,
  type ObstacleConfig,
  type TrackOptions,
  type WorldHandle,
  type WorldSnapshot,
} from './sim/world';
import { mountScene, type SceneHandle } from './render/scene';
import { nextGeneration, type GAParams, type Scored } from './ga/population';
import { collectStats, type GenerationStats } from './stats/collector';
import { mountCharts, type ChartsHandle } from './stats/charts';

/** Short visual pause between generations so the eye registers the new batch. */
const GENERATION_PAUSE_MS = 600;

/**
 * World-x where every car spawns (in metres).  Travel distance is
 * computed as `maxX - SPAWN_X`, so the world-x of a car that earned
 * `travel` metres is `SPAWN_X + travel`.  Used by the record marker.
 */
const SPAWN_X = 6;

/**
 * Live evolution parameters.  Mutated in place by the sidebar
 * sliders; the next generation reads whatever is current here.  The
 * defaults match Genetic Cars 2's typical knobs.
 */
const gaParams: GAParams = {
  populationSize: 24,
  eliteCount: 2,
  mutationRate: 0.15,
};

/**
 * Live track-tuning parameters.  Mutated in place by the "Track"
 * sidebar sliders; the next generation's track is built using
 * whatever is current here.  Defaults to no obstacles so the
 * baseline track matches v0.9.26 until the user touches a slider.
 */
const trackTuning: { obstacles: ObstacleConfig } = {
  obstacles: { pit: 0, bump: 0, wall: 0, ceiling: 0, cliff: 0, killzone: 0 },
};

/**
 * Speed-up cycle: clicking the button rotates through these in order.
 *   ×1   — realtime, full render
 *   ×8   — physics 8× faster, render still on (cars zoom)
 *   ×32  — physics 32× faster, *render off* (only stats and counters
 *          update — much higher CPU budget for physics)
 *
 * Headless = true means we hide the canvas and skip setSnapshot
 * calls; the user watches the stats panel grow instead.
 */
/**
 * Pause flag: when true the tick loop skips world.step() entirely.
 * The renderer still draws the last frame so cars stay visible.
 * Toggled by the P hotkey.
 */
let paused = false;

/**
 * Track presets — clicking the "🗺" button cycles through them.
 *
 *   random   (default)  — fresh random track every generation
 *                         (favours universal cars across terrains)
 *   fixed              — pick a seed once at the start of the run
 *                         and reuse it every generation (evolution
 *                         converges on this specific track)
 *   smooth             — random per gen, gentle hills (amplitude 2.0)
 *   extreme            — random per gen, dramatic hills (amplitude 8.0)
 *
 * `fixedTrackSeed` only matters in 'fixed' mode; we capture it at
 * the moment the user switches into the mode (or at the start of a
 * fresh run while in fixed mode).
 */
type TrackMode = 'random' | 'fixed' | 'smooth' | 'extreme';
const TRACK_MODES: TrackMode[] = ['random', 'fixed', 'smooth', 'extreme'];
let trackModeIdx = 0;
let fixedTrackSeed: number | null = null;

type SpeedState = { multiplier: number; headless: boolean };
const SPEED_STATES: SpeedState[] = [
  { multiplier: 1, headless: false },
  { multiplier: 8, headless: false },
  { multiplier: 32, headless: true },
];
let speedIdx = 0;

/**
 * "Skip N generations" mode.  When non-null, the loop runs at very
 * high speed with rendering off until `generation` reaches this
 * target, then resets to whatever the speed cycle was on before.
 */
let skipUntilGen: number | null = null;
const SKIP_SPEED = 64;
const SKIP_AMOUNT = 10;

/**
 * Wall-time budget per RAF frame for physics steps, in ms.  At ×1 we
 * never come close.  At ×8/×32 the inner while-loop hits this cap and
 * the next RAF picks up where it left off — so the UI never blocks
 * for more than a single frame regardless of speed multiplier.
 */
const STEP_DEADLINE_MS = 25;
/**
 * Hard cap on how much sim-time can pile up in the accumulator.  If
 * the user hides the tab and the RAF stops firing, we don't want to
 * resume by trying to simulate a minute of skipped time in one go.
 */
const MAX_ACC_SEC = 1.0;

/**
 * Resolve the multiplier and headless flag the tick loop should use
 * *right now*, taking the skip-N-gens override into account.
 */
function effectiveSpeed(): SpeedState {
  if (skipUntilGen !== null) return { multiplier: SKIP_SPEED, headless: true };
  return SPEED_STATES[speedIdx] ?? SPEED_STATES[0]!;
}

/**
 * Pick the track seed and per-generation overrides for the upcoming
 * run based on the current track mode.  Returned `opts` are merged
 * over DEFAULT_TRACK in generateTrack — at minimum we pass
 * obstacles (from the user's sliders); presets also override
 * amplitude.  In 'fixed' mode the seed is captured once and reused
 * across generations of the same run; freshRun() resets it.
 */
function nextTrackParams(): { seed: number; opts: Partial<TrackOptions> } {
  const mode: TrackMode = TRACK_MODES[trackModeIdx] ?? 'random';
  // The slider-driven obstacles apply on every preset — the user's
  // intent ("I want pits") shouldn't depend on whether the track is
  // smooth or extreme.
  const baseOpts: Partial<TrackOptions> = { obstacles: { ...trackTuning.obstacles } };
  if (mode === 'fixed') {
    if (fixedTrackSeed === null) fixedTrackSeed = (Math.random() * 0xffffffff) >>> 0;
    return { seed: fixedTrackSeed, opts: baseOpts };
  }
  const seed = (Math.random() * 0xffffffff) >>> 0;
  if (mode === 'smooth') return { seed, opts: { ...baseOpts, amplitude: 2.0 } };
  if (mode === 'extreme') return { seed, opts: { ...baseOpts, amplitude: 8.0 } };
  return { seed, opts: baseOpts }; // 'random' uses default amplitude
}

type Hud = {
  total: HTMLElement;
  lead: HTMLElement;
  best: HTMLElement;
  seed: HTMLElement;
  generation: HTMLElement;
  version: HTMLElement;
};

async function bootstrap(): Promise<void> {
  applyTranslations();
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn instanceof HTMLButtonElement) bindLanguageToggle(langBtn);

  await ensureRapier();

  const host = document.getElementById('pixi-root');
  if (!(host instanceof HTMLElement)) {
    throw new Error('pixi-root element missing');
  }
  const scene = await mountScene(host);

  const hud: Hud = {
    total: requireEl('stat-total'),
    lead: requireEl('stat-lead'),
    best: requireEl('stat-best'),
    seed: requireEl('stat-seed'),
    generation: requireEl('stat-generation'),
    version: requireEl('app-version'),
  };
  hud.version.textContent = `v${__APP_VERSION__}`;

  bindControls();

  // Stats dashboard: a grid of sparklines that grows one column per
  // generation.  Hidden by default — toggle via the "📊 stats" button.
  const chartsHost = document.getElementById('charts-panel');
  let charts: ChartsHandle | null = null;
  if (chartsHost instanceof HTMLElement) {
    charts = mountCharts(chartsHost);
    const chartsBtn = document.getElementById('btn-charts');
    if (chartsBtn instanceof HTMLButtonElement) {
      chartsBtn.addEventListener('click', () => {
        if (!charts) return;
        charts.setVisible(!charts.isVisible());
      });
    }
  }
  const history: GenerationStats[] = [];

  // Cross-session evolution state.
  let generation = 0;
  let lastResults: Scored[] | null = null;
  let bestEver = 0;
  /**
   * World-x of the all-time best run on the *current* track.  Only
   * meaningful in 'fixed' track mode (where the same track is reused
   * across generations); in any other mode we keep this null and the
   * minimap hides the markers.
   */
  let trackRecordX: number | null = null;
  /**
   * Last few record-setting world-x values on the current fixed
   * track, oldest → newest.  Capped at TRACK_RECORD_HISTORY_MAX so
   * the minimap's record-history rendering stays bounded; the
   * newest entry is always equal to `trackRecordX`.
   */
  const trackRecordHistory: number[] = [];
  const TRACK_RECORD_HISTORY_MAX = 5;

  function freshRun(): void {
    generation = 0;
    lastResults = null;
    bestEver = 0;
    history.length = 0;
    // Drop the cached fixed seed too so a new run picks a fresh track
    // even if the user is still on the 'fixed' preset.
    fixedTrackSeed = null;
    trackRecordX = null;
    trackRecordHistory.length = 0;
    scene.setRecordHistory([]);
    hud.best.textContent = '—';
    if (charts) charts.update(history);
  }

  const trackBtn = document.getElementById('btn-track');
  function updateTrackButtonText(): void {
    if (!(trackBtn instanceof HTMLButtonElement)) return;
    const mode = TRACK_MODES[trackModeIdx] ?? 'random';
    const key =
      mode === 'random'
        ? 'panel.trackRandom'
        : mode === 'fixed'
          ? 'panel.trackFixed'
          : mode === 'smooth'
            ? 'panel.trackSmooth'
            : 'panel.trackExtreme';
    trackBtn.textContent = t(key);
  }
  if (trackBtn instanceof HTMLButtonElement) {
    trackBtn.addEventListener('click', () => {
      trackModeIdx = (trackModeIdx + 1) % TRACK_MODES.length;
      // Switching modes invalidates any cached fixed seed so the next
      // generation picks up the new mode's seed strategy cleanly.
      // The "record on this track" marker only makes sense in fixed
      // mode, so clear it on mode change.
      fixedTrackSeed = null;
      trackRecordX = null;
      trackRecordHistory.length = 0;
      scene.setRecordHistory([]);
      updateTrackButtonText();
    });
    updateTrackButtonText();
  }

  const pauseBtn = document.getElementById('btn-pause');
  function updatePauseButtonText(): void {
    if (!(pauseBtn instanceof HTMLButtonElement)) return;
    pauseBtn.textContent = t(paused ? 'panel.resume' : 'panel.pause');
  }
  function togglePause(): void {
    paused = !paused;
    updatePauseButtonText();
  }
  if (pauseBtn instanceof HTMLButtonElement) {
    pauseBtn.addEventListener('click', () => {
      togglePause();
      pauseBtn.blur();
    });
    updatePauseButtonText();
    // The pause button's text depends on *both* the paused flag and
    // the current locale, so re-apply on every locale flip.  The
    // data-i18n flow can't handle this since the key changes with
    // state.
    $locale.subscribe(() => updatePauseButtonText());
  }

  // Floating "back to leader" button — shown only when the camera
  // has been taken away from leader-follow (via minimap drag or
  // car-dot click).  Clicking it (or pressing L) snaps the camera
  // back and hides the button.
  const cameraLeaderBtn = document.getElementById('btn-camera-leader');
  let cameraManual = false;
  function updateCameraButton(): void {
    if (!(cameraLeaderBtn instanceof HTMLButtonElement)) return;
    if (!cameraManual) {
      cameraLeaderBtn.hidden = true;
      return;
    }
    cameraLeaderBtn.hidden = false;
    cameraLeaderBtn.textContent = t('panel.cameraLeader');
  }
  scene.onCameraChange((info) => {
    cameraManual = info.manual;
    updateCameraButton();
  });
  if (cameraLeaderBtn instanceof HTMLButtonElement) {
    cameraLeaderBtn.addEventListener('click', () => {
      scene.followLeader();
      cameraLeaderBtn.blur();
    });
  }
  $locale.subscribe(() => updateCameraButton());

  const restartBtn = document.getElementById('btn-restart');
  function confirmAndRestart(): void {
    // Native confirm is plenty here — short, blocking, and works
    // identically across browsers.  We only ask once, on the
    // user-initiated path; programmatic restarts (the inter-gen
    // tick loop) bypass this entirely.
    if (!window.confirm(t('panel.restartConfirm'))) return;
    freshRun();
    void restart();
  }
  if (restartBtn instanceof HTMLButtonElement) {
    restartBtn.addEventListener('click', () => {
      confirmAndRestart();
      restartBtn.blur();
    });
  }
  window.addEventListener('keydown', (ev) => {
    // Don't interfere when typing into a slider / button.
    const target = ev.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
    switch (ev.code) {
      case 'Space':
        // Spacebar = pause/resume.  (Used to fire a new-population
        // restart, which is too destructive for an unconfirmed
        // single-key shortcut.  The button still does that, with a
        // confirmation prompt.)
        ev.preventDefault();
        togglePause();
        return;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3': {
        // Jump directly to a speed cycle slot.
        const slot = Number(ev.code.slice(-1)) - 1;
        if (slot < 0 || slot >= SPEED_STATES.length) return;
        if (skipUntilGen !== null) skipUntilGen = null;
        speedIdx = slot;
        updateSpeedButtonText();
        applyHeadless();
        return;
      }
      case 'KeyS':
        ev.preventDefault();
        skipUntilGen = generation + SKIP_AMOUNT;
        updateSpeedButtonText();
        applyHeadless();
        return;
      case 'KeyC':
        ev.preventDefault();
        if (charts) charts.setVisible(!charts.isVisible());
        return;
      case 'KeyP':
        // P kept as an alternative pause hotkey for muscle-memory.
        ev.preventDefault();
        togglePause();
        return;
      case 'KeyL':
        // L = "look at the leader" — snap the camera back to the
        // running leader after a manual minimap drag or car-dot pick.
        ev.preventDefault();
        scene.followLeader();
        return;
      case 'Escape':
        // Cancel skip and drop to realtime — universal "calm down" hotkey.
        if (skipUntilGen !== null) skipUntilGen = null;
        speedIdx = 0;
        updateSpeedButtonText();
        applyHeadless();
        return;
    }
  });

  const speedBtn = document.getElementById('btn-speedup');
  const skipBtn = document.getElementById('btn-skip');

  function updateSpeedButtonText(): void {
    if (!(speedBtn instanceof HTMLButtonElement)) return;
    if (skipUntilGen !== null) {
      speedBtn.textContent = t('panel.skipping');
      return;
    }
    const idx = speedIdx;
    const key: 'panel.speedup' | 'panel.speedup8' | 'panel.speedup32' =
      idx === 0 ? 'panel.speedup' : idx === 1 ? 'panel.speedup8' : 'panel.speedup32';
    speedBtn.textContent = t(key);
  }

  function applyHeadless(): void {
    const headless = skipUntilGen !== null || (SPEED_STATES[speedIdx]?.headless ?? false);
    // Re-narrow inside the closure — TS loses the earlier instanceof
    // narrowing once `host` is captured by another function.
    if (host instanceof HTMLElement) {
      host.style.visibility = headless ? 'hidden' : '';
    }
  }

  if (speedBtn instanceof HTMLButtonElement) {
    speedBtn.addEventListener('click', () => {
      // Clicking the speed button while in skip mode cancels the skip.
      if (skipUntilGen !== null) skipUntilGen = null;
      speedIdx = (speedIdx + 1) % SPEED_STATES.length;
      updateSpeedButtonText();
      applyHeadless();
    });
    updateSpeedButtonText();
  }

  if (skipBtn instanceof HTMLButtonElement) {
    skipBtn.addEventListener('click', () => {
      // Set a target generation; the tick loop takes care of forcing
      // top speed + headless mode until we get there.
      skipUntilGen = generation + SKIP_AMOUNT;
      updateSpeedButtonText();
      applyHeadless();
    });
  }

  let session: Session | null = null;

  async function restart(): Promise<void> {
    if (session) {
      session.stop();
      session.world.destroy();
    }
    const trackParams = nextTrackParams();
    const trackSeed = trackParams.seed;

    // Build the genomes for this generation.  Gen 0 (or "Space"
    // restart) seeds with random genomes; later generations are
    // produced by the GA from the previous gen's fitness vector.
    // GA RNG uses a separate seed so it doesn't lock-step with the
    // (possibly fixed) track seed across generations.
    let genomes: Genome[];
    const gaSeed = (Math.random() * 0xffffffff) >>> 0;
    if (lastResults && generation > 0) {
      const gaRng = makeRng(gaSeed);
      genomes = nextGeneration(lastResults, gaParams, gaRng);
    } else {
      const rng = makeRng(gaSeed);
      genomes = [];
      for (let i = 0; i < gaParams.populationSize; i++) genomes.push(randomGenome(rng));
    }

    const sessionStartedAt = performance.now();
    session = await startSession({
      trackSeed,
      trackOpts: trackParams.opts,
      generation,
      genomes,
      scene,
      hud,
      onGenerationEnd: (results) => {
        lastResults = results;
        const genBest = results.reduce((m, r) => (r.fitness > m ? r.fitness : m), 0);
        if (genBest > bestEver) {
          bestEver = genBest;
          hud.best.textContent = `${bestEver.toFixed(1)} m`;
        }
        // In 'fixed' track mode, "best on this track" is meaningful;
        // every generation runs on the same seed, so we accumulate
        // the all-time max across them and push a vertical record
        // line on the minimap.  Older record lines fade with age
        // (rendered by the minimap) so the player can see the
        // progression: gen-2's record at x=120, gen-7's at x=180,
        // gen-15's at x=400, etc.  Other modes pick a fresh track
        // per gen so a "record" on the previous track is meaningless.
        if (TRACK_MODES[trackModeIdx] === 'fixed') {
          const candidate = SPAWN_X + genBest;
          const beatRecord = trackRecordX === null || candidate > trackRecordX;
          if (beatRecord) {
            trackRecordX = candidate;
            trackRecordHistory.push(candidate);
            if (trackRecordHistory.length > TRACK_RECORD_HISTORY_MAX) {
              trackRecordHistory.shift();
            }
          }
          scene.setRecordHistory(trackRecordHistory);
        } else {
          trackRecordX = null;
          trackRecordHistory.length = 0;
          scene.setRecordHistory([]);
        }
        // Record summary stats and refresh sparklines.
        const durationSec = (performance.now() - sessionStartedAt) / 1000;
        history.push(collectStats(generation, durationSec, results));
        if (charts) charts.update(history);
        generation += 1;
        // If we were skipping ahead and just hit the target generation,
        // exit skip mode and restore the visible speed cycle state.
        if (skipUntilGen !== null && generation >= skipUntilGen) {
          skipUntilGen = null;
          updateSpeedButtonText();
          applyHeadless();
        }
        const effective = effectiveSpeed();
        setTimeout(() => void restart(), GENERATION_PAUSE_MS / effective.multiplier);
      },
    });
  }

  await restart();
}

/**
 * Wire the three GA sliders + their value labels.  The sliders mutate
 * `gaParams` in place; the change takes effect at the *next* generation
 * (the current run uses whatever was set when it started).
 */
function bindControls(): void {
  bindSlider('ctrl-population', 'ctrl-population-val', (v) => {
    gaParams.populationSize = v;
    return String(v);
  });
  bindSlider('ctrl-mutation', 'ctrl-mutation-val', (v) => {
    gaParams.mutationRate = v / 100;
    return `${v}%`;
  });
  bindSlider('ctrl-elite', 'ctrl-elite-val', (v) => {
    gaParams.eliteCount = v;
    return String(v);
  });
  // Track-tuning sliders — values 0..100 in the DOM, mapped to
  // 0..1 intensities for the obstacle generator.  Take effect on
  // the next generation (current run keeps whatever was set when
  // it started).
  bindSlider('ctrl-pits', 'ctrl-pits-val', (v) => {
    trackTuning.obstacles.pit = v / 100;
    return `${v}%`;
  });
  bindSlider('ctrl-bumps', 'ctrl-bumps-val', (v) => {
    trackTuning.obstacles.bump = v / 100;
    return `${v}%`;
  });
  bindSlider('ctrl-walls', 'ctrl-walls-val', (v) => {
    trackTuning.obstacles.wall = v / 100;
    return `${v}%`;
  });
  bindSlider('ctrl-ceilings', 'ctrl-ceilings-val', (v) => {
    trackTuning.obstacles.ceiling = v / 100;
    return `${v}%`;
  });
  bindSlider('ctrl-cliffs', 'ctrl-cliffs-val', (v) => {
    trackTuning.obstacles.cliff = v / 100;
    return `${v}%`;
  });
  bindSlider('ctrl-killzones', 'ctrl-killzones-val', (v) => {
    trackTuning.obstacles.killzone = v / 100;
    return `${v}%`;
  });
}

function bindSlider(inputId: string, valueId: string, apply: (v: number) => string): void {
  const input = document.getElementById(inputId);
  const valueEl = document.getElementById(valueId);
  if (!(input instanceof HTMLInputElement) || !(valueEl instanceof HTMLElement)) return;
  const sync = (): void => {
    const v = Number(input.value);
    valueEl.textContent = apply(v);
  };
  input.addEventListener('input', sync);
  sync(); // pull initial state from HTML attrs
}

type Session = {
  world: WorldHandle;
  stop(): void;
};

type StartOptions = {
  trackSeed: number;
  /**
   * Per-generation overrides merged into DEFAULT_TRACK.  Carries
   * preset-driven amplitude (smooth/extreme) plus the user's
   * obstacle-slider settings.  Empty object = pure defaults.
   */
  trackOpts?: Partial<TrackOptions>;
  generation: number;
  genomes: Genome[];
  scene: SceneHandle;
  hud: Hud;
  onGenerationEnd: (results: Scored[]) => void;
};

async function startSession(opts: StartOptions): Promise<Session> {
  const { trackSeed, trackOpts, generation, genomes, scene, hud, onGenerationEnd } = opts;

  const track = generateTrack(trackSeed, trackOpts ?? {});
  scene.setTrack(track.points, track.physicalObstacles);

  const world = await createWorld({ track, genomes, spawnX: SPAWN_X });

  hud.total.textContent = String(genomes.length);
  hud.seed.textContent = trackSeed.toString(16).padStart(8, '0');
  hud.generation.textContent = String(generation);

  // Click on a car → bundle (seed, gen, genome, current snapshot) goes
  // to the clipboard as JSON.  The bundle has everything needed for
  // somebody else (me) to recreate the exact situation locally.
  scene.onCarClick((carIndex) => {
    const genome = genomes[carIndex];
    const snap = world.snapshot();
    const carSnap = snap.cars.find((c) => c.index === carIndex);
    if (!genome || !carSnap) return;
    const trackY = sampleTrackY(track, carSnap.position.x);
    // Pull the per-car trajectory + safety-event counts.  The
    // timeline tuples are documented in apps/web/src/sim/world.ts:
    //   [t, x, y, vx, vy, ang, hAt, onBits, ev]
    // ev codes: 0 sample / 1 velClamp / 3 finish / 4 spike.
    const timeline = world.getCarTimeline(carIndex);
    const eventCounts = world.getCarEventCounts(carIndex);
    const bundle = {
      version: __APP_VERSION__,
      trackSeed: trackSeed.toString(16).padStart(8, '0'),
      generation,
      carIndex,
      genome,
      snapshot: {
        position: carSnap.position,
        velocity: carSnap.velocity,
        angle: carSnap.angle,
        speed: carSnap.speed,
        travel: carSnap.travel,
        finished: carSnap.finished,
        trackYHere: Number(trackY.toFixed(3)),
        heightAboveTrack: Number((carSnap.position.y - trackY).toFixed(3)),
      },
      eventCounts,
      timelineHelp:
        'tuple = [t, x, y, vx, vy, ang, heightAboveTrack, onGroundBitmask, eventCode]; eventCode 0=sample 1=velClamp 3=finish 4=spike',
      timeline,
    };
    const json = JSON.stringify(bundle, null, 2);
    void navigator.clipboard
      .writeText(json)
      .catch((err) => console.warn('clipboard write failed', err));
    console.info('[debug bundle]', bundle);
  });

  let running = true;
  let endNotified = false;
  let lastTime = performance.now();
  let acc = 0;
  let elapsed = 0;

  function tick(): void {
    if (!running) return;
    const now = performance.now();
    const eff = effectiveSpeed();
    // While paused, the accumulator stays empty (no physics steps)
    // and lastTime is still updated so resuming doesn't dump a huge
    // backlog of simulated time into the world.
    if (paused) {
      lastTime = now;
      requestAnimationFrame(tick);
      return;
    }
    // Multiply real elapsed time by speed multiplier, then feed into
    // the fixed-timestep accumulator.  Cap the accumulator so a long
    // pause (tab hidden) doesn't try to simulate minutes of skipped
    // time on resume.
    const dt = Math.min((now - lastTime) / 1000, 0.25) * eff.multiplier;
    lastTime = now;
    acc = Math.min(acc + dt, MAX_ACC_SEC);
    // Wall-time deadline: spend at most STEP_DEADLINE_MS in physics
    // each frame.  At high speed multipliers the inner loop hits the
    // budget and the next RAF picks up the leftover acc — UI never
    // blocks for more than ~25 ms regardless of the multiplier.
    const stepBudgetEnd = now + STEP_DEADLINE_MS;
    while (acc >= SIM_DT && performance.now() < stepBudgetEnd) {
      world.step();
      acc -= SIM_DT;
      elapsed += SIM_DT;
    }
    if (elapsed >= TUNING.lifecycle.maxGenerationSec) {
      world.forceFinishAll();
    }
    const snap = world.snapshot();
    // Always push the snapshot.  Scene's setSnapshot keeps the
    // minimap + camera target updated unconditionally (cheap SVG
    // writes); in headless mode (×32 or skip) we tell it to skip
    // the per-car Pixi work since the canvas is invisible anyway.
    scene.setSnapshot(snap, { renderCars: !eff.headless });
    updateHud(hud, snap);

    if (!endNotified && world.allFinished()) {
      endNotified = true;
      running = false;
      const results: Scored[] = genomes.map((genome, i) => ({
        genome,
        fitness: snap.cars[i]?.travel ?? 0,
      }));
      onGenerationEnd(results);
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    world,
    stop(): void {
      running = false;
    },
  };
}

function updateHud(hud: Hud, snap: WorldSnapshot): void {
  let lead = 0;
  for (const c of snap.cars) {
    if (c.travel > lead) lead = c.travel;
  }
  hud.lead.textContent = `${lead.toFixed(1)} m`;
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) throw new Error(`#${id} missing`);
  return el;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void bootstrap());
} else {
  void bootstrap();
}
