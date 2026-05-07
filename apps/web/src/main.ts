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
  type Track,
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
 * whatever is current here.
 *
 *   difficulty (1..100) — drives the procedural noise amplitude.
 *                         1 % ≈ flat road, 100 % ≈ dramatic hills.
 *                         Replaces the v1.3 pits + bumps sliders
 *                         (the procedural surface IS the hazard
 *                         budget; scattered Gaussian dips were
 *                         redundant with hill amplitude).
 *   obstacles  — discrete-hazard intensities, all 0..1, default 0.
 */
const trackTuning: {
  /** Track length in metres.  Slider range 200..3000, default 500. */
  length: number;
  difficulty: number;
  obstacles: ObstacleConfig;
} = {
  length: 500,
  difficulty: 40,
  obstacles: {
    wall: 0,
    ceiling: 0,
    cliff: 0,
    slick: 0,
  },
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
 * Track presets after the v1.4 simplification:
 *
 *   random   (default)  — fresh random track every generation
 *                         (favours universal cars across terrains)
 *   fixed              — pick a seed once at the start of the run
 *                         and reuse it every generation (evolution
 *                         converges on this specific track)
 *
 * The old "smooth" and "extreme" presets are gone — players now
 * dial difficulty directly via the Difficulty slider, which also
 * makes the segmented selector simpler (two pills instead of
 * four).
 *
 * `fixedTrackSeed` only matters in 'fixed' mode; captured the
 * moment the user enters that mode (or at the start of a fresh
 * run while already in it).
 */
type TrackMode = 'random' | 'fixed';
const TRACK_MODES: TrackMode[] = ['random', 'fixed'];
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
 * Derive a stable 32-bit GA seed from the track seed + generation
 * number.  Standard 32-bit avalanche mix (Murmur3 finalizer style):
 * any pair of inputs produces a well-distributed output, and the
 * function is pure so the same (trackSeed, generation) always
 * yields the same gaSeed.
 *
 * Used to replace the previous `Math.random()`-based seed.  The
 * goal is *reproducibility* — fixed-track + the same starting
 * conditions should always evolve identically, so a player can
 * share a track seed and have somebody else recreate the run.
 */
function deriveGaSeed(trackSeed: number, generation: number): number {
  let h = (trackSeed >>> 0) ^ ((generation * 0x9e3779b9) >>> 0);
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hard cap on side-world simulation steps so a buggy / never-
 * stalling elite can't lock up the verification pass.  At 60 sim
 * Hz this is 600 s = 10 min, matching TUNING.lifecycle.maxGenerationSec.
 */
const VERIFY_MAX_STEPS = 60 * 600;

/**
 * Run a single genome alone in its own freshly-built Rapier world
 * on the same track, simulating until it finishes (stalls, rolls
 * back past threshold, hits a kill-zone, or maxes out the step
 * cap).  Returns the travel distance.
 *
 * "Solo verification" — a diagnostic for the multi-body world's
 * subtle non-determinism.  When the main world reports the elite
 * doing 300 m, we re-run that same genome alone here; if the solo
 * result differs, we know the elite's 300 m run was sensitive to
 * the *other* cars sharing its Rapier world (FP noise from
 * broadphase / solver iteration order).  Identical results mean
 * the multi-body world is well-behaved on this genome.
 */
async function verifyEliteAlone(genome: Genome, track: Track): Promise<number> {
  const sideWorld = await createWorld({ track, genomes: [genome], spawnX: SPAWN_X });
  let steps = 0;
  while (!sideWorld.allFinished() && steps < VERIFY_MAX_STEPS) {
    sideWorld.step();
    steps++;
  }
  const snap = sideWorld.snapshot();
  const travel = snap.cars[0]?.travel ?? 0;
  sideWorld.destroy();
  return travel;
}

/**
 * Resolve the multiplier and headless flag the tick loop should use
 * *right now*.
 */
function effectiveSpeed(): SpeedState {
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
  // Difficulty slider 1..100 maps to amplitude 0.5..12 m via
  // linear lerp.  At 1 % the track is essentially flat (gentle
  // 50-cm rolling); at 100 % the hills hit ±12 m which exceeds
  // the wall of the finish basin and is a real challenge for
  // anything but well-evolved climbers.  Default UI value 40 %
  // ≈ amplitude 5 m, matching the historical default.
  const difficulty = trackTuning.difficulty / 100;
  const amplitude = 0.5 + difficulty * (12 - 0.5);
  const baseOpts: Partial<TrackOptions> = {
    length: trackTuning.length,
    amplitude,
    obstacles: { ...trackTuning.obstacles },
  };
  if (mode === 'fixed') {
    if (fixedTrackSeed === null) fixedTrackSeed = (Math.random() * 0xffffffff) >>> 0;
    return { seed: fixedTrackSeed, opts: baseOpts };
  }
  const seed = (Math.random() * 0xffffffff) >>> 0;
  return { seed, opts: baseOpts };
}

type Hud = {
  total: HTMLElement;
  lead: HTMLElement;
  best: HTMLElement;
  seed: HTMLElement;
  generation: HTMLElement;
  version: HTMLElement;
  /** Solo-verified elite distance (top-1 re-run alone). */
  eliteSolo: HTMLElement;
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
    eliteSolo: requireEl('stat-elite-solo'),
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
    hud.eliteSolo.textContent = '—';
    if (charts) charts.update(history);
  }

  // Track-preset segmented control: direct selection by clicking
  // any of the four segments.  No more cycle-on-click — every
  // option is visible at once, the active one is highlighted.
  const trackSegItems = document.querySelectorAll<HTMLButtonElement>(
    '#seg-track [data-track-mode]',
  );
  function updateTrackSegmented(): void {
    const current = TRACK_MODES[trackModeIdx] ?? 'random';
    trackSegItems.forEach((el) => {
      const mode = el.dataset['trackMode'] as TrackMode | undefined;
      el.classList.toggle('segmented__item--active', mode === current);
    });
  }
  trackSegItems.forEach((el) => {
    el.addEventListener('click', () => {
      const mode = el.dataset['trackMode'] as TrackMode | undefined;
      if (!mode) return;
      const idx = TRACK_MODES.indexOf(mode);
      if (idx < 0) return;
      trackModeIdx = idx;
      // Switching modes invalidates any cached fixed seed so the
      // next generation picks up the new mode's seed strategy
      // cleanly.  The "record on this track" marker only makes
      // sense in fixed mode, so clear it on mode change.
      fixedTrackSeed = null;
      trackRecordX = null;
      trackRecordHistory.length = 0;
      scene.setRecordHistory([]);
      updateTrackSegmented();
      el.blur();
    });
  });
  updateTrackSegmented();

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
  const restartConfirm = document.getElementById('restart-confirm');
  const restartConfirmYes = document.getElementById('restart-confirm-yes');
  const restartConfirmNo = document.getElementById('restart-confirm-no');
  function isConfirmOpen(): boolean {
    return restartConfirm instanceof HTMLElement && !restartConfirm.hasAttribute('hidden');
  }
  function setConfirmOpen(open: boolean): void {
    if (!(restartConfirm instanceof HTMLElement)) return;
    if (open) restartConfirm.removeAttribute('hidden');
    else restartConfirm.setAttribute('hidden', '');
  }
  if (restartBtn instanceof HTMLButtonElement) {
    // Click on the trigger toggles the inline popover instead of
    // showing a modal — the popover's "Confirm" button is what
    // actually wipes the run.  Toggle (not always-open) so a second
    // click on the trigger dismisses without firing.
    restartBtn.addEventListener('click', () => {
      setConfirmOpen(!isConfirmOpen());
      restartBtn.blur();
    });
  }
  if (restartConfirmYes instanceof HTMLButtonElement) {
    restartConfirmYes.addEventListener('click', () => {
      setConfirmOpen(false);
      freshRun();
      void restart();
    });
  }
  if (restartConfirmNo instanceof HTMLButtonElement) {
    restartConfirmNo.addEventListener('click', () => {
      setConfirmOpen(false);
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
        // Jump directly to a speed slot via number keys (still
        // supported as a shortcut for the segmented control).
        const slot = Number(ev.code.slice(-1)) - 1;
        if (slot < 0 || slot >= SPEED_STATES.length) return;
        speedIdx = slot;
        updateSpeedSegmented();
        applyHeadless();
        return;
      }
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
        // If the inline confirm popover is open, Esc dismisses it.
        // Otherwise it's the "calm down" hotkey — drop speed back
        // to realtime.
        if (isConfirmOpen()) {
          setConfirmOpen(false);
          return;
        }
        speedIdx = 0;
        updateSpeedSegmented();
        applyHeadless();
        return;
    }
  });

  // Speed segmented control: three direct-select segments
  // (×1 / ×8 / ×32).  Clicking a segment sets the speed slot
  // directly.  The active slot is highlighted.
  const speedSegItems = document.querySelectorAll<HTMLButtonElement>('#seg-speed [data-speed-idx]');

  function updateSpeedSegmented(): void {
    speedSegItems.forEach((el) => {
      const idx = Number(el.dataset['speedIdx']);
      el.classList.toggle('segmented__item--active', idx === speedIdx);
    });
  }

  function applyHeadless(): void {
    const headless = SPEED_STATES[speedIdx]?.headless ?? false;
    // Re-narrow inside the closure — TS loses the earlier instanceof
    // narrowing once `host` is captured by another function.
    if (host instanceof HTMLElement) {
      host.style.visibility = headless ? 'hidden' : '';
    }
    // body.mode-headless drives the ×32 layout: minimap fills the
    // canvas area, charts pin to the lower right, and a "render off"
    // banner appears so the player understands why the world view
    // is blank.
    document.body.classList.toggle('mode-headless', headless);
    // Auto-open the charts panel when entering headless — there's
    // nothing else interesting to look at, and live stats are the
    // whole point of skipping the render.
    if (headless && charts && !charts.isVisible()) {
      charts.setVisible(true);
    }
  }

  speedSegItems.forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset['speedIdx']);
      if (Number.isNaN(idx)) return;
      speedIdx = idx;
      updateSpeedSegmented();
      applyHeadless();
      el.blur();
    });
  });
  updateSpeedSegmented();

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
    //
    // GA seed is *derived deterministically* from the (trackSeed,
    // generation) pair.  In fixed-track mode this means rerunning
    // the same fixed seed always produces the same evolution path
    // — necessary if the player wants to share a track and have
    // others reproduce their results, or to compare two tweaks
    // of the GA params on identical conditions.  In random/smooth/
    // extreme modes the trackSeed itself is fresh per gen, so the
    // GA still appears random — but the relationship is now
    // pure-functional, no Math.random() in the seed pipeline.
    let genomes: Genome[];
    const gaSeed = deriveGaSeed(trackSeed, generation);
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
  // Track-tuning sliders.  Difficulty drives the procedural
  // amplitude in nextTrackParams; the rest are 0..1 obstacle
  // intensities.  Length is in metres directly.  All take
  // effect on the *next* generation — the in-flight run keeps
  // whatever the values were at the moment it started.
  bindSlider('ctrl-length', 'ctrl-length-val', (v) => {
    trackTuning.length = v;
    return `${v}m`;
  });
  bindSlider('ctrl-difficulty', 'ctrl-difficulty-val', (v) => {
    trackTuning.difficulty = v;
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
  bindSlider('ctrl-slick', 'ctrl-slick-val', (v) => {
    trackTuning.obstacles.slick = v / 100;
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
      // Solo-verify the top-1 elite in a side-world.  Runs in the
      // background; the next generation starts immediately, the
      // verified-elite HUD just updates whenever this resolves.
      const top = results.reduce((a, b) => (b.fitness > a.fitness ? b : a));
      void verifyEliteAlone(top.genome, track).then((solo) => {
        hud.eliteSolo.textContent = `${solo.toFixed(1)} m`;
      });
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
