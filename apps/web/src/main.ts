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
  generateTrack,
  makeRng,
  randomGenome,
  SIM_DT,
  TUNING,
  type Genome,
  type ObstacleConfig,
  type Track,
  type TrackOptions,
  type WorldSnapshot,
} from './sim/world';
import { getWorldProxy, type WorldProxy } from './worker/worldProxy';
import { mountScene, type SceneHandle } from './render/scene';
import { nextGeneration, type GAParams, type Scored } from './ga/population';
import { collectStats, type GenerationStats } from './stats/collector';
import { mountCharts, type ChartsHandle } from './stats/charts';
import { mountTutorial } from './tutorial';

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
  selectionPressure: 1,
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
  /** Track length in metres.  Slider range 200..2000, default 200. */
  length: number;
  difficulty: number;
  obstacles: ObstacleConfig;
  /** World gravity in G (1 G = 9.81 m/s²).  Slider range 0.1..3.0,
   *  default 1.0.  Threaded into createWorld; does not affect track
   *  shape, so it lives outside TrackOptions. */
  gravity: number;
} = {
  length: 200,
  difficulty: 40,
  obstacles: {
    wall: 0,
    ceiling: 0,
    cliff: 0,
    slick: 0,
    stairs: 0,
  },
  gravity: 1,
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

/* ─── Seed share/save (v1.7) ──────────────────────────────────────────── */

/**
 * localStorage key for the rolling history of recent fixed-mode
 * seeds.  Capped at SEED_HISTORY_MAX so the chip list stays
 * compact and the storage footprint stays trivial.
 */
const SEED_HISTORY_KEY = 'dnacars.seedHistory';
const SEED_HISTORY_MAX = 8;

/**
 * Strict-determinism mode — when on, every car gets its own
 * isolated Rapier world for true repeatability across runs at the
 * cost of ~2× CPU.  Persisted to localStorage so the player's
 * choice survives a reload.  Takes effect on the *next* generation
 * (the in-flight world is created with whatever the value was at
 * its start).  See CreateWorldOptions.isolated for the rationale.
 */
const STRICT_DETERMINISM_KEY = 'dnacars.strictDeterminism';
function loadStrictDeterminism(): boolean {
  try {
    return localStorage.getItem(STRICT_DETERMINISM_KEY) === '1';
  } catch {
    return false;
  }
}
function saveStrictDeterminism(on: boolean): void {
  try {
    localStorage.setItem(STRICT_DETERMINISM_KEY, on ? '1' : '0');
  } catch {
    /* localStorage might be disabled (private mode etc.); ignore */
  }
}
let strictDeterminism = loadStrictDeterminism();

/**
 * Speed-mode toggle.  When true, the GA fitness for cars that
 * crossed the finish line is replaced with an inverse-time bonus —
 * `trackLength + 1 + (1000 - finishTime)` — so the fastest finisher
 * wins the elite slot regardless of how far it travelled (it
 * travelled the full track, anyway).  Cars that didn't finish are
 * still scored on travel distance, and any finisher always ranks
 * above any non-finisher.  Persisted to localStorage so the choice
 * survives reloads.
 */
const SPEED_MODE_KEY = 'dnacars.speedMode';
function loadSpeedMode(): boolean {
  try {
    return localStorage.getItem(SPEED_MODE_KEY) === '1';
  } catch {
    return false;
  }
}
function saveSpeedMode(on: boolean): void {
  try {
    localStorage.setItem(SPEED_MODE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
let speedMode = loadSpeedMode();

/**
 * Fast-forward toggle — when on (default), the strict-det elite
 * shortcut fires once every alive car is an elite whose outcome is
 * already cached.  The remainder of the gen is force-finished and
 * the dashboard "best" reading falls back to the cached `travel`.
 * When off, the shortcut is suppressed and elites run their full
 * deterministic course every gen — slower wall-clock, but the
 * canvas keeps showing live simulation right up to natural end.
 * Persisted to localStorage.
 */
const FAST_FORWARD_KEY = 'dnacars.fastForward';
function loadFastForward(): boolean {
  try {
    const raw = localStorage.getItem(FAST_FORWARD_KEY);
    // Default ON: every previous version had the shortcut always
    // active.  Players upgrading from <1.26 see no behaviour change.
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}
function saveFastForward(on: boolean): void {
  try {
    localStorage.setItem(FAST_FORWARD_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
let fastForwardEnabled = loadFastForward();

/**
 * Show-only-leader toggle — when on, the renderer hides every car
 * except the current running leader.  Physics still simulates the
 * full population in the background; this is purely a viewing
 * mode for "the GA has converged, let me admire the champion
 * driving the track on its own".  Persisted to localStorage.
 */
const SHOW_ONLY_LEADER_KEY = 'dnacars.showOnlyLeader';
function loadShowOnlyLeader(): boolean {
  try {
    return localStorage.getItem(SHOW_ONLY_LEADER_KEY) === '1';
  } catch {
    return false;
  }
}
function saveShowOnlyLeader(on: boolean): void {
  try {
    localStorage.setItem(SHOW_ONLY_LEADER_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
let showOnlyLeader = loadShowOnlyLeader();

function loadSeedHistory(): number[] {
  try {
    const raw = localStorage.getItem(SEED_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
      .slice(0, SEED_HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveSeedHistory(history: number[]): void {
  try {
    localStorage.setItem(SEED_HISTORY_KEY, JSON.stringify(history.slice(0, SEED_HISTORY_MAX)));
  } catch {
    /* localStorage might be disabled (private mode etc.); ignore */
  }
}

/**
 * Push a fixed-mode seed to the front of the history.  Same
 * seed reappearing moves to the front instead of duplicating, so
 * the list stays clean.
 */
function pushSeedToHistory(seed: number): void {
  const cleaned = loadSeedHistory().filter((s) => s !== seed);
  cleaned.unshift(seed);
  saveSeedHistory(cleaned);
}

/** Render the seed as an 8-character hex string. */
function formatSeed(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, '0');
}

/** Parse an 8-char-or-shorter hex string (with or without 0x) into a uint32, or null. */
function parseSeedHex(input: string): number | null {
  const cleaned = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,8}$/.test(cleaned)) return null;
  return parseInt(cleaned, 16) >>> 0;
}

/**
 * Read `?seed=xxxxxxxx` from the URL on bootstrap so a shared
 * link drops the player straight into the same fixed track.
 */
function readSeedFromUrl(): number | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('seed');
  return v ? parseSeedHex(v) : null;
}

/**
 * Mirror the active fixed seed (if any) into the URL so the
 * player can copy the address bar to share.  In random mode the
 * URL has no `seed` param.  Uses replaceState to avoid spamming
 * the browser history on every generation.
 */
function updateUrlSeed(seed: number | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (seed === null) url.searchParams.delete('seed');
  else url.searchParams.set('seed', formatSeed(seed));
  window.history.replaceState({}, '', url.toString());
}

/**
 * Each row is one speed-segmented button.  Beyond the multiplier
 * itself, each tier has its own physics knobs:
 *
 *   substeps         — solver substeps per game tick.  Lowering trades
 *                      stability for throughput (2 is the v0.9.6
 *                      default for collision robustness; 1 is "fast
 *                      and slightly glitchy").
 *   solverIterations — Rapier's per-step constraint iterations.
 *                      Lowering speeds up world.step() linearly at
 *                      the cost of contact precision.
 *   uiThrottleMs     — minimum real-time gap between HUD/minimap
 *                      updates.  At ×1 / ×8 the player is watching;
 *                      throttle 0 = update every frame.  At ×32+
 *                      the canvas is hidden, so we skip most UI
 *                      writes to free CPU for physics.
 */
type SpeedState = {
  multiplier: number;
  headless: boolean;
  substeps: number;
  solverIterations: number;
  uiThrottleMs: number;
};
const SPEED_STATES: SpeedState[] = [
  { multiplier: 1, headless: false, substeps: 2, solverIterations: 8, uiThrottleMs: 0 },
  { multiplier: 8, headless: false, substeps: 2, solverIterations: 8, uiThrottleMs: 33 },
  { multiplier: 32, headless: true, substeps: 2, solverIterations: 8, uiThrottleMs: 100 },
  { multiplier: 64, headless: true, substeps: 1, solverIterations: 4, uiThrottleMs: 150 },
];
let speedIdx = 0;

/**
 * Throughput tracking — module-level so the in-session tick loop
 * (which lives inside startSession) and the bootstrap-level UI
 * updater (updateThroughputDisplay) share the same state without
 * threading callbacks through every option bag.
 *
 *   simSecAccum     — total simulated seconds since page load (across
 *                     gens).  Increments by SIM_DT each physics step.
 *   lastPerfSampleMs / lastPerfSimSec — paired markers for the
 *                     "real seconds since last UI tick" delta.
 *                     realSpeed = (simSec - lastSim) / ((nowMs - lastMs) / 1000).
 *   smoothedRealSpeed — EMA-smoothed real/requested speed ratio for
 *                     a stable ribbon readout.
 *   smoothedFrameMs   — EMA-smoothed per-tick wall-clock work time.
 *                     Drives the predictive "would tier X work?"
 *                     colour coding on the speed buttons.
 */
let simSecAccum = 0;
let lastPerfSampleMs = performance.now();
let lastPerfSimSec = 0;
let smoothedRealSpeed = 1;
let smoothedFrameMs = 16.7;
const PERF_SMOOTHING = 0.18;

/**
 * Refresh the throughput readout (ribbon "ТЕМП" stat) and the
 * predictive colour-coding on the speed segmented buttons.
 *
 *   ribbon shows "× actual" with a colour state depending on
 *   how close `actual` is to the requested multiplier:
 *     - ≥ 95 % of requested:  ok (default)
 *     - 70–95 %:               tight (yellow tint)
 *     - < 70 %:                saturated — show "× actual / × M" red
 *
 *   speed buttons get a `--load-ok / --load-tight / --load-saturated`
 *   modifier based on the predicted utilisation at that tier:
 *     predictedFrameMs(T) = currentFrameMs * (T / currentMultiplier)
 *   compared against the 16.7 ms 60-fps frame budget.  The currently
 *   active tier skips the modifier — its existing "active" pill
 *   styling already says "you're here".
 */
function updateThroughputDisplay(): void {
  const eff = SPEED_STATES[speedIdx] ?? SPEED_STATES[0]!;
  const requested = eff.multiplier;
  const actual = smoothedRealSpeed;
  const ratio = requested > 0 ? actual / requested : 0;
  const throughputEl = document.getElementById('stat-throughput');
  if (throughputEl instanceof HTMLElement) {
    // Round the actual speed to integer when the number isn't tiny
    // — the EMA still ticks fractionally on a 60 Hz tick clock and
    // showing "×1.0 → ×1.1 → ×0.9" reads as flicker.  Sub-1 keeps
    // one decimal so the player can tell the GA is choking (×0.7
    // means 70 % real-time, important info), and sub-2 keeps half-
    // decimal precision (×1.5).  Above 2× the integer is enough.
    const prettyActual =
      actual < 1 ? actual.toFixed(1) : actual < 2 ? actual.toFixed(1) : actual.toFixed(0);
    const prettyReq = requested.toString();
    let label: string;
    let cls: 'ok' | 'tight' | 'saturated';
    if (ratio >= 0.95) {
      label = `×${prettyActual}`;
      cls = 'ok';
    } else if (ratio >= 0.7) {
      label = `×${prettyActual} / ×${prettyReq}`;
      cls = 'tight';
    } else {
      label = `×${prettyActual} / ×${prettyReq}`;
      cls = 'saturated';
    }
    setText(throughputEl, label);
    throughputEl.classList.toggle('ribbon-stat__value--ok', cls === 'ok');
    throughputEl.classList.toggle('ribbon-stat__value--tight', cls === 'tight');
    throughputEl.classList.toggle('ribbon-stat__value--saturated', cls === 'saturated');
  }

  const FRAME_BUDGET_MS = 16.7;
  const speedButtons = document.querySelectorAll<HTMLButtonElement>('#seg-speed [data-speed-idx]');
  speedButtons.forEach((btn) => {
    const idx = Number(btn.dataset['speedIdx']);
    const tier = SPEED_STATES[idx];
    btn.classList.remove(
      'segmented__item--load-ok',
      'segmented__item--load-tight',
      'segmented__item--load-saturated',
    );
    if (!tier) return;
    if (idx === speedIdx) return; // current tier — skip extra hint
    const predictedMs = smoothedFrameMs * (tier.multiplier / requested);
    const u = predictedMs / FRAME_BUDGET_MS;
    let pred: 'load-ok' | 'load-tight' | 'load-saturated';
    if (u < 0.7) pred = 'load-ok';
    else if (u < 1.0) pred = 'load-tight';
    else pred = 'load-saturated';
    btn.classList.add(`segmented__item--${pred}`);
  });
}

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
  // Difficulty slider 0..100 maps to amplitude 0..12 m linearly.
  // At 0 % the track is *perfectly* flat (amplitude is exactly 0,
  // so all sine octaves cancel out — the polyline is a single
  // horizontal line).  At 100 % the hills hit ±12 m which is a
  // real climb-the-cliff challenge.  Default UI value 40 % ≈
  // amplitude 4.8 m, close to the historical 5 m default.
  const difficulty = trackTuning.difficulty / 100;
  const amplitude = 12 * difficulty;
  const baseOpts: Partial<TrackOptions> = {
    length: trackTuning.length,
    amplitude,
    obstacles: { ...trackTuning.obstacles },
  };
  if (mode === 'fixed') {
    if (fixedTrackSeed === null) {
      fixedTrackSeed = (Math.random() * 0xffffffff) >>> 0;
      pushSeedToHistory(fixedTrackSeed);
      updateUrlSeed(fixedTrackSeed);
    }
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
  /** "Alive" count: cars in the current run that haven't finished yet. */
  alive: HTMLElement;
  /** Track length, e.g. "500m", shown next to the leader value. */
  trackLength: HTMLElement;
};

async function bootstrap(): Promise<void> {
  applyTranslations();
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn instanceof HTMLButtonElement) bindLanguageToggle(langBtn);

  // Rapier WASM is compiled inside the simulation worker on its first
  // `init` — the main thread never loads it, so bootstrap no longer
  // blocks on a WASM compile.

  const host = document.getElementById('pixi-root');
  if (!(host instanceof HTMLElement)) {
    throw new Error('pixi-root element missing');
  }
  const scene = await mountScene(host);

  const hud: Hud = {
    total: requireEl('stat-total'),
    lead: requireEl('stat-lead'),
    best: requireEl('stat-best'),
    // stat-seed used to live in the ribbon; v1.21.2 dropped it in
    // favour of the track-mode toggle.  Keep a detached element so
    // existing seed-text writes don't have to null-check.
    seed: document.getElementById('stat-seed') ?? document.createElement('span'),
    generation: requireEl('stat-generation'),
    version: requireEl('app-version'),
    alive: requireEl('stat-alive'),
    trackLength: requireEl('stat-track-length'),
  };
  hud.version.textContent = `v${__APP_VERSION__}`;

  // Seed-on-URL handoff: a `?seed=xxxxxxxx` param drops the
  // player straight into fixed-track mode using that seed.
  // Useful for sharing a specific track with friends — copy
  // the URL after the seed shows up in the address bar (or
  // click the seed value to copy just the hex).
  const initialUrlSeed = readSeedFromUrl();
  if (initialUrlSeed !== null) {
    fixedTrackSeed = initialUrlSeed;
    trackModeIdx = TRACK_MODES.indexOf('fixed');
    pushSeedToHistory(initialUrlSeed);
  }

  bindControls();
  bindDockDrawers();
  bindLeaderCard();

  // Stats dashboard: a grid of sparklines that grows one column per
  // generation.  Hidden by default — toggle via the "📊 stats" button.
  const chartsHost = document.getElementById('charts-panel');
  let charts: ChartsHandle | null = null;
  // True when the headless-mode auto-open last set the panel
  // visible.  Cleared when the user clicks Stats themselves —
  // protects manual intent across speed-tier changes.
  let chartsAutoOpened = false;
  if (chartsHost instanceof HTMLElement) {
    charts = mountCharts(chartsHost);
    const chartsBtn = document.getElementById('btn-charts');
    if (chartsBtn instanceof HTMLButtonElement) {
      chartsBtn.addEventListener('click', () => {
        if (!charts) return;
        // User-driven open/close — clear the auto-open flag so we
        // don't close their manually-chosen state when they later
        // exit headless mode.
        charts.setVisible(!charts.isVisible());
        chartsAutoOpened = false;
      });
    }
  }

  // Tutorial overlay (modal that explains how the GA works).  The
  // panel itself is dormant until the user clicks the topbar
  // "Tutorial" button.
  const tutorialHost = document.getElementById('tutorial');
  if (tutorialHost instanceof HTMLElement) {
    const tutorial = mountTutorial(tutorialHost);
    const tutBtn = document.getElementById('btn-tutorial');
    if (tutBtn instanceof HTMLButtonElement) {
      tutBtn.addEventListener('click', () => {
        tutorial.open();
        tutBtn.blur();
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

  /**
   * Strict-determinism elite-distance cache.  After each gen-end
   * (when strict-det is on) we save the top-N fitnesses keyed by a
   * hash of the track config that produced them.  At the next
   * gen-start, if the upcoming track config hashes the same, the
   * cache predicts each elite's final distance — letting the tick
   * loop force-finish as soon as only those elites are still alive.
   *
   * Invalidated implicitly by a track-config change (hash mismatch),
   * and explicitly cleared in freshRun() and on strict-det toggle.
   */
  type EliteCacheEntry = {
    fitness: number;
    finishTime: number | null;
    /**
     * The elite's travel-distance the prev gen, in metres.  Cached
     * alongside fitness because the fast-forward shortcut cuts elite
     * cars short — without overriding `travel` too, the dashboard's
     * "best" reading (which reads `travel`, not `fitness`, to stay
     * unit-consistent across speed-mode toggles) would visibly dip
     * every gen the shortcut fires.  See the substitute in startSession.
     */
    travel: number;
  };
  let eliteCache: { trackHash: string; entries: EliteCacheEntry[] } | null = null;

  function trackConfigHash(trackSeed: number, trackOpts: Partial<TrackOptions>): string {
    // speedMode included so toggling it flips the hash and invalidates
    // the elite-cache (cached fitness values were computed under the
    // previous mode's scoring and would lie under the new one).
    return JSON.stringify({ trackSeed, ...trackOpts, speedMode, gravity: trackTuning.gravity });
  }

  /**
   * Show the FAST-FORWARD banner briefly when the strict-det
   * shortcut fires so the player notices the gen ended early.
   * Idempotent — calling while already shown re-arms the timer.
   */
  let shortcutBannerTimer: ReturnType<typeof setTimeout> | null = null;
  function flashShortcutBanner(): void {
    const banner = document.getElementById('shortcut-banner');
    if (!(banner instanceof HTMLElement)) return;
    banner.hidden = false;
    if (shortcutBannerTimer !== null) clearTimeout(shortcutBannerTimer);
    shortcutBannerTimer = setTimeout(() => {
      banner.hidden = true;
      shortcutBannerTimer = null;
    }, 700);
  }

  function freshRun(keepSeed: number | null = null): void {
    generation = 0;
    lastResults = null;
    eliteCache = null;
    bestEver = 0;
    history.length = 0;
    clearLeaderCard();
    // Drop the cached fixed seed unless the caller is preserving
    // it (the seed-paste flow asks to keep its just-applied seed
    // through the reset; the default "↻ New population" button
    // path passes null and gets a fresh random seed next gen).
    fixedTrackSeed = keepSeed;
    updateUrlSeed(keepSeed);
    trackRecordX = null;
    trackRecordHistory.length = 0;
    scene.setRecordHistory([]);
    hud.best.textContent = '—';
    if (charts) charts.update(history);
  }

  // Track toggle — a single on/off switch (v1.63, was a Random /
  // Fixed segmented control).  ON = a fresh random track every
  // generation; OFF = one fixed seed reused every generation.
  // TRACK_MODES[0] is 'random', TRACK_MODES[1] is 'fixed', so
  // trackModeIdx mirrors the inverse of `checked`.
  const randomTrackToggle = document.getElementById('toggle-random-track');
  function syncTrackToggle(): void {
    if (!(randomTrackToggle instanceof HTMLInputElement)) return;
    randomTrackToggle.checked = (TRACK_MODES[trackModeIdx] ?? 'random') === 'random';
  }
  if (randomTrackToggle instanceof HTMLInputElement) {
    randomTrackToggle.addEventListener('change', () => {
      trackModeIdx = randomTrackToggle.checked
        ? TRACK_MODES.indexOf('random')
        : TRACK_MODES.indexOf('fixed');
      // Switching modes invalidates any cached fixed seed so the
      // next generation picks up the new mode's seed strategy
      // cleanly.  The "record on this track" marker only makes
      // sense in fixed mode, so clear it on mode change.
      fixedTrackSeed = null;
      updateUrlSeed(null);
      trackRecordX = null;
      trackRecordHistory.length = 0;
      scene.setRecordHistory([]);
      renderSeedHistoryUI();
    });
  }
  syncTrackToggle();

  /* ─── Seed card: copy current, paste/apply, recent-history chips ─── */

  const seedDisplayBtn = document.getElementById('stat-seed');
  const seedInput = document.getElementById('seed-input');
  const seedApplyBtn = document.getElementById('seed-apply');
  const seedHistoryHost = document.getElementById('seed-history');

  function renderSeedHistoryUI(): void {
    if (!(seedHistoryHost instanceof HTMLElement)) return;
    seedHistoryHost.innerHTML = '';
    const history = loadSeedHistory();
    if (history.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'seed-history__empty';
      empty.textContent = t('panel.seedHistoryEmpty');
      seedHistoryHost.appendChild(empty);
      return;
    }
    for (const seed of history) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'seed-chip';
      if (fixedTrackSeed === seed && TRACK_MODES[trackModeIdx] === 'fixed') {
        chip.classList.add('seed-chip--current');
      }
      chip.textContent = formatSeed(seed);
      chip.title = t('panel.seedCopyHint');
      chip.addEventListener('click', () => {
        applySeedHex(seed);
        chip.blur();
      });
      seedHistoryHost.appendChild(chip);
    }
  }

  /**
   * Apply a seed: switch to fixed mode, set fixedTrackSeed,
   * push to history, update URL, refresh segmented + chip
   * highlights, kick off a fresh restart so the new gen runs
   * on the new seed.
   */
  function applySeedHex(seed: number): void {
    trackModeIdx = TRACK_MODES.indexOf('fixed');
    pushSeedToHistory(seed);
    // freshRun(seed) wipes population/record state but keeps
    // the just-applied fixed seed wired up so the next
    // generation runs on the requested track.
    freshRun(seed);
    syncTrackToggle();
    renderSeedHistoryUI();
    void restart();
  }

  if (seedDisplayBtn instanceof HTMLButtonElement) {
    seedDisplayBtn.addEventListener('click', () => {
      const text = seedDisplayBtn.textContent?.trim() ?? '';
      if (!text || text === '—') return;
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          seedDisplayBtn.classList.add('ribbon-stat__value--copied');
          const previousTitle = seedDisplayBtn.title;
          seedDisplayBtn.title = t('panel.seedCopied');
          setTimeout(() => {
            seedDisplayBtn.classList.remove('ribbon-stat__value--copied');
            seedDisplayBtn.title = previousTitle;
          }, 1200);
        })
        .catch((err) => console.warn('seed copy failed', err));
    });
  }

  function applyFromInput(): void {
    if (!(seedInput instanceof HTMLInputElement)) return;
    const seed = parseSeedHex(seedInput.value);
    if (seed === null) {
      seedInput.classList.add('seed-input--error');
      setTimeout(() => seedInput.classList.remove('seed-input--error'), 600);
      return;
    }
    seedInput.value = '';
    applySeedHex(seed);
  }
  if (seedApplyBtn instanceof HTMLButtonElement) {
    seedApplyBtn.addEventListener('click', () => {
      applyFromInput();
      seedApplyBtn.blur();
    });
  }
  if (seedInput instanceof HTMLInputElement) {
    seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyFromInput();
      }
    });
  }
  renderSeedHistoryUI();
  // History chips show empty-state text + active-chip styling
  // that depend on locale and current fixedTrackSeed; re-render
  // on locale change to keep both in sync.
  $locale.subscribe(() => renderSeedHistoryUI());

  // v1.63 — the visible Pause button was removed; pause stays
  // available via the Space / P keyboard shortcuts (see the keydown
  // handler below).
  function togglePause(): void {
    paused = !paused;
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

  // "New population" — an inline two-step confirm, no popup:
  //   click 1  → the button arms: turns red, relabels to a warning,
  //              and locks for ARM_LOCK_MS (a thin bar animates the
  //              lockout) so an accidental double-click can't confirm.
  //   click 2  → once the lockout has passed, wipes the run.
  //   no click → the armed state auto-reverts after ARM_TIMEOUT_MS.
  const restartBtn = document.getElementById('btn-restart');
  let restartArmed = false;
  let restartLocked = false;
  let restartLockTimer: ReturnType<typeof setTimeout> | null = null;
  let restartRevertTimer: ReturnType<typeof setTimeout> | null = null;
  // Anti-double-click lockout — kept in sync with the CSS fill
  // animation in `.btn--armed-locked` (see global.css).
  const ARM_LOCK_MS = 1500;
  // Auto-revert if the player arms the button then walks away.
  const ARM_TIMEOUT_MS = 5000;

  function disarmRestart(): void {
    if (!restartArmed) return;
    restartArmed = false;
    restartLocked = false;
    if (restartLockTimer !== null) {
      clearTimeout(restartLockTimer);
      restartLockTimer = null;
    }
    if (restartRevertTimer !== null) {
      clearTimeout(restartRevertTimer);
      restartRevertTimer = null;
    }
    if (restartBtn instanceof HTMLButtonElement) {
      restartBtn.classList.remove('btn--armed', 'btn--armed-locked');
      restartBtn.setAttribute('data-i18n', 'panel.restart');
      restartBtn.textContent = t('panel.restart');
    }
  }

  if (restartBtn instanceof HTMLButtonElement) {
    restartBtn.addEventListener('click', () => {
      restartBtn.blur();
      if (!restartArmed) {
        // First click — arm: red, warning label, locked for a beat.
        restartArmed = true;
        restartLocked = true;
        restartBtn.classList.add('btn--armed', 'btn--armed-locked');
        restartBtn.setAttribute('data-i18n', 'panel.restartArmed');
        restartBtn.textContent = t('panel.restartArmed');
        restartLockTimer = setTimeout(() => {
          restartLocked = false;
          restartBtn.classList.remove('btn--armed-locked');
          restartLockTimer = null;
        }, ARM_LOCK_MS);
        restartRevertTimer = setTimeout(disarmRestart, ARM_TIMEOUT_MS);
        return;
      }
      // Armed but still inside the lockout — an accidental second
      // click; ignore it.
      if (restartLocked) return;
      // Confirmed.
      disarmRestart();
      freshRun();
      void restart();
    });
  }

  // Strict-determinism toggle.  Switching the physics regime mid-run
  // makes the existing record/best-ever stale (a genome that hit the
  // wall in shared-world physics may not in isolated mode, and vice
  // versa), and the chart's rolling history mixes the two regimes
  // unhelpfully.  So a confirmed toggle in either direction wipes the
  // run state — same as clicking "New population".  Keeps the fixed
  // seed so the player can immediately compare same-track results
  // before vs after the toggle.
  const strictInput = document.getElementById('ctrl-strict-determinism');
  const strictPopover = document.getElementById('strict-determinism-confirm');
  const strictYes = document.getElementById('strict-determinism-confirm-yes');
  const strictNo = document.getElementById('strict-determinism-confirm-no');
  if (
    strictInput instanceof HTMLInputElement &&
    strictPopover instanceof HTMLElement &&
    strictYes instanceof HTMLButtonElement &&
    strictNo instanceof HTMLButtonElement
  ) {
    strictInput.checked = strictDeterminism;
    strictPopover.hidden = true;
    const applyStrictDeterminism = (next: boolean): void => {
      strictDeterminism = next;
      saveStrictDeterminism(next);
      strictInput.checked = next;
      // Reset run state so the new mode's runs aren't visually
      // contaminated by the previous mode's record/sparkline.  Keep
      // the fixed seed if we're in fixed mode for easy A/B.
      const keepSeed = TRACK_MODES[trackModeIdx] === 'fixed' ? fixedTrackSeed : null;
      freshRun(keepSeed);
      void restart();
    };
    strictInput.addEventListener('change', () => {
      if (strictInput.checked && !strictDeterminism) {
        // Don't commit yet — visually un-tick and show the warning
        // popover.  Confirm/Cancel buttons drive the actual change.
        strictInput.checked = false;
        strictPopover.hidden = false;
      } else if (!strictInput.checked && strictDeterminism) {
        // Turning OFF — silent (no confirmation), but still resets
        // the run since the regime is changing.
        applyStrictDeterminism(false);
      }
    });
    strictYes.addEventListener('click', () => {
      strictPopover.hidden = true;
      applyStrictDeterminism(true);
    });
    strictNo.addEventListener('click', () => {
      strictPopover.hidden = true;
      strictInput.checked = false;
    });
    // Click on the modal backdrop (anywhere outside the inner panel)
    // is treated as cancel — same as the No button.  Escape too.
    strictPopover.addEventListener('click', (ev) => {
      if (ev.target === strictPopover) {
        strictPopover.hidden = true;
        strictInput.checked = false;
      }
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !strictPopover.hidden) {
        ev.preventDefault();
        strictPopover.hidden = true;
        strictInput.checked = false;
      }
    });
  }

  // Speed-mode toggle.  Unlike strict-det this doesn't reset the
  // run — fitness function changes on the next gen-end while the
  // current gen continues with whatever scoring was set when it
  // started (the speedMode value is captured into sessionSpeedMode
  // at startSession time).  Cache hash includes speedMode, so
  // toggling it implicitly invalidates the elite-cache for one
  // generation — same lazy-rebuild behaviour as a track-config
  // change.  Persisted to localStorage so the choice survives
  // reloads, but doesn't carry across populations.
  const speedModeInput = document.getElementById('ctrl-speed-mode');
  if (speedModeInput instanceof HTMLInputElement) {
    speedModeInput.checked = speedMode;
    speedModeInput.addEventListener('change', () => {
      speedMode = speedModeInput.checked;
      saveSpeedMode(speedMode);
      if (charts) charts.update(history);
    });
  }

  // Fast-forward toggle.  Takes effect on the *next* generation
  // (the in-flight gen already captured shortcutCtx, so its
  // shortcut behaviour is locked in).
  const fastForwardInput = document.getElementById('ctrl-fast-forward');
  if (fastForwardInput instanceof HTMLInputElement) {
    fastForwardInput.checked = fastForwardEnabled;
    fastForwardInput.addEventListener('change', () => {
      fastForwardEnabled = fastForwardInput.checked;
      saveFastForward(fastForwardEnabled);
    });
  }

  // Show-only-leader toggle.  Per-frame effect — flipping mid-run
  // immediately starts hiding / re-showing non-leader cars on the
  // next setSnapshot.
  const showOnlyLeaderInput = document.getElementById('ctrl-show-only-leader');
  if (showOnlyLeaderInput instanceof HTMLInputElement) {
    showOnlyLeaderInput.checked = showOnlyLeader;
    showOnlyLeaderInput.addEventListener('change', () => {
      showOnlyLeader = showOnlyLeaderInput.checked;
      saveShowOnlyLeader(showOnlyLeader);
    });
  }

  // Advanced-settings modal: button in the dock opens it; close on
  // X-button click, click on the backdrop, or Escape.  The toggles
  // inside (fast-forward / speed-mode / pure-mutation / strict-det)
  // are wired by their own handlers above — the modal is just a
  // host element, so opening/closing it doesn't touch their state.
  const settingsModal = document.getElementById('settings-modal');
  const settingsBtn = document.getElementById('btn-advanced');
  const settingsClose = document.getElementById('settings-modal-close');
  if (
    settingsModal instanceof HTMLElement &&
    settingsBtn instanceof HTMLButtonElement &&
    settingsClose instanceof HTMLButtonElement
  ) {
    const openSettings = (): void => {
      settingsModal.hidden = false;
    };
    const closeSettings = (): void => {
      settingsModal.hidden = true;
    };
    settingsBtn.addEventListener('click', () => {
      openSettings();
      settingsBtn.blur();
    });
    settingsClose.addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', (ev) => {
      // Backdrop click only — clicks on the inner panel bubble up but
      // their target is the panel, not the modal root.
      if (ev.target === settingsModal) closeSettings();
    });
    // Per-item info chevrons: each toggle's description is collapsed
    // by default; clicking the chevron flips a class on the row that
    // animates max-height + opacity, and toggles aria-expanded for
    // a11y (the chevron pseudo-element rotates via the same attr).
    // Single delegated listener on the list keeps the wiring trivial
    // even as more rows get added later.
    const settingsList = settingsModal.querySelector('.modal-settings__list');
    settingsList?.addEventListener('click', (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest<HTMLButtonElement>('.modal-settings__item-info');
      if (!btn) return;
      const item = btn.closest<HTMLElement>('.modal-settings__item');
      if (!item) return;
      const expanded = item.classList.toggle('modal-settings__item--expanded');
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      btn.blur();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !settingsModal.hidden) {
        // Don't preventDefault — the strict-det warning may be open
        // on top of this and wants Escape too.  Each modal closes
        // its own state independently.
        closeSettings();
      }
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
        // If the "New population" button is armed, Esc disarms it.
        // Otherwise it's the "calm down" hotkey — drop speed back
        // to realtime.
        if (restartArmed) {
          disarmRestart();
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
    // nothing else interesting to look at — and auto-close it when
    // leaving, but only if WE opened it (don't trample on a user
    // who manually opened the panel at ×1 then bumped speed up).
    if (charts) {
      if (headless && !charts.isVisible()) {
        charts.setVisible(true);
        chartsAutoOpened = true;
      } else if (!headless && chartsAutoOpened) {
        charts.setVisible(false);
        chartsAutoOpened = false;
      }
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
  // Pending auto-restart timer scheduled at gen-end.  Tracked so a
  // manual restart (New population / Space) can cancel it — otherwise
  // the stale timer fires a second restart() that double-increments
  // the generation and stomps the fresh run.
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  async function restart(): Promise<void> {
    // Cancel any pending gen-end auto-restart so this restart is the
    // only one in flight.
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (session) {
      session.stop();
      // Fire-and-forget: the worker processes this destroy before the
      // next session's `init` (FIFO message queue), so the order is
      // guaranteed without blocking restart() on a round-trip.
      void session.world.destroy();
      // Null it immediately: if a click re-enters restart() during the
      // `await startSession` below, the guard above skips a second
      // stop()/destroy() on the already-freed Rapier world.
      session = null;
    }
    const trackParams = nextTrackParams();
    const trackSeed = trackParams.seed;
    // Refresh the seed-history chips: nextTrackParams may have
    // just lazy-generated a new fixed seed (and pushed it to
    // history), so the active-chip highlight needs to follow.
    renderSeedHistoryUI();

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
    // Decide if the strict-det fast-forward shortcut is available
    // for this gen.  Only when:
    //   - strict determinism is on (cache is only meaningful then),
    //   - we have at least one prior gen's elite distances cached,
    //   - the upcoming track config matches the one that produced
    //     those distances (any slider tweak between gens flips the
    //     hash and disables the shortcut for one gen, after which a
    //     fresh cache rebuilds),
    //   - we have at least one elite slot to short-circuit.
    const currentTrackHash = trackConfigHash(trackSeed, trackParams.opts);
    const cacheValid =
      strictDeterminism &&
      fastForwardEnabled &&
      eliteCache !== null &&
      eliteCache.trackHash === currentTrackHash &&
      gaParams.eliteCount > 0 &&
      eliteCache.entries.length > 0;
    const shortcutCtx = cacheValid
      ? {
          eliteCount: gaParams.eliteCount,
          cachedEntries: eliteCache!.entries,
          onTrigger: flashShortcutBanner,
        }
      : null;
    // Elite carryover only makes sense from gen 1 onward — gen 0
    // has no parents to inherit from; everyone is random.
    const sessionEliteCount = generation > 0 && lastResults ? gaParams.eliteCount : 0;
    session = await startSession({
      trackSeed,
      trackOpts: trackParams.opts,
      gravity: trackTuning.gravity,
      generation,
      genomes,
      eliteCount: sessionEliteCount,
      scene,
      hud,
      shortcutCtx,
      speedMode,
      onGenerationEnd: (results) => {
        lastResults = results;
        // Best-on-this-track display always reads travel distance
        // (mode-independent); fitness might be a speed-mode bonus,
        // not metres, so we use the canonical `travel` field.
        const genBest = results.reduce((m, r) => (r.travel > m ? r.travel : m), 0);
        if (genBest > bestEver) {
          bestEver = genBest;
          hud.best.textContent = `${bestEver.toFixed(1)} m`;
        }
        // Save / clear the strict-det elite cache.  In strict-det,
        // the top N fitnesses (sorted desc) become the predicted
        // distances for the next gen's elites at indices 0..N-1.
        // Outside strict-det the cache would lie (multi-body world
        // is FP-noisy), so we explicitly null it.
        if (strictDeterminism && gaParams.eliteCount > 0) {
          // Save fitness + finishTime sorted desc by fitness so the
          // next gen's elite cache lookup at index i matches what
          // population.ts produces (it copies the i-th-highest-
          // fitness genome into next[i]).  finishTime kept too so
          // the speed-mode chart reads the right time when the
          // shortcut cuts an elite short of crossing the finish.
          const sorted = [...results]
            .sort((a, b) => b.fitness - a.fitness)
            .slice(0, gaParams.eliteCount)
            .map((r) => ({
              fitness: r.fitness,
              finishTime: r.finishTime,
              travel: r.travel,
            }));
          eliteCache = { trackHash: currentTrackHash, entries: sorted };
        } else {
          eliteCache = null;
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
        // Refresh the champion card with this generation's winner —
        // fastest finisher if speed-mode + any finishers, otherwise
        // the furthest-traveled car.
        updateLeaderCardFromGenEnd(results, generation);
        // Record summary stats and refresh sparklines.
        const durationSec = (performance.now() - sessionStartedAt) / 1000;
        history.push(collectStats(generation, durationSec, results, session?.trackLength ?? 0));
        if (charts) charts.update(history);
        generation += 1;
        const effective = effectiveSpeed();
        restartTimer = setTimeout(() => {
          restartTimer = null;
          void restart();
        }, GENERATION_PAUSE_MS / effective.multiplier);
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
  bindSlider('ctrl-pressure', 'ctrl-pressure-val', (v) => {
    gaParams.selectionPressure = v;
    return v.toFixed(1);
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
  bindSlider('ctrl-stairs', 'ctrl-stairs-val', (v) => {
    trackTuning.obstacles.stairs = v / 100;
    return `${v}%`;
  });
  // Gravity slider is in deci-G (raw 1..30 → 0.1..3.0 G) so the
  // step buttons nudge by 0.1 G.  trackTuning.gravity stores G.
  bindSlider('ctrl-gravity', 'ctrl-gravity-val', (v) => {
    trackTuning.gravity = v / 10;
    return `${(v / 10).toFixed(1)} G`;
  });
  bindStepButtons();
}

/**
 * Wire `−` / `+` buttons next to track-drawer sliders.  Each click
 * nudges the linked input by one `step` (1% for percentage sliders,
 * 50 m for the length slider), clamps to [min, max], and dispatches
 * an `input` event so the existing bindSlider listener picks up the
 * change and re-applies it to trackTuning + paints the fill.  Clicks
 * inside an open drawer are already protected from the close-on-
 * outside listener by the drawer's pointerdown stopPropagation.
 */
function bindStepButtons(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.ctrl__step');
  for (const btn of buttons) {
    const targetId = btn.dataset.step;
    const dir = Number(btn.dataset.dir);
    if (!targetId || !Number.isFinite(dir)) continue;
    const input = document.getElementById(targetId);
    if (!(input instanceof HTMLInputElement)) continue;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const step = Number(input.step) || 1;
      const min = Number(input.min);
      const max = Number(input.max);
      const current = Number(input.value);
      const next = Math.min(max, Math.max(min, current + dir * step));
      if (next === current) return;
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

/* ─── Leader card (champion of previous race) ───────────────────────────── */

const LEADER_CARD_COLLAPSED_KEY = 'dnacars.leaderCardCollapsed';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Wire the collapsible header on the leader-card aside.  Persists
 * the collapsed state across reloads in localStorage.
 */
function bindLeaderCard(): void {
  const card = document.getElementById('leader-card');
  const toggle = document.getElementById('leader-card-toggle');
  if (!(card instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) return;
  const initial = localStorage.getItem(LEADER_CARD_COLLAPSED_KEY) === 'true';
  setLeaderCardCollapsed(card, toggle, initial);
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const next = card.getAttribute('data-collapsed') !== 'true';
    setLeaderCardCollapsed(card, toggle, next);
    localStorage.setItem(LEADER_CARD_COLLAPSED_KEY, String(next));
  });
}

function setLeaderCardCollapsed(
  card: HTMLElement,
  toggle: HTMLButtonElement,
  collapsed: boolean,
): void {
  card.setAttribute('data-collapsed', String(collapsed));
  toggle.setAttribute('aria-expanded', String(!collapsed));
}

/**
 * Pick the champion from the previous generation's Scored results.
 *  - Speed-mode on AND at least one car finished: the finisher with
 *    the smallest finishTime.
 *  - Otherwise (speed-mode off OR no finishers): the car that
 *    traveled the furthest distance.
 */
function selectChampion(results: Scored[]): Scored | null {
  if (results.length === 0) return null;
  if (speedMode) {
    let bestFin: Scored | null = null;
    for (const r of results) {
      if (r.finishTime === null) continue;
      if (bestFin === null || r.finishTime < (bestFin.finishTime ?? Infinity)) bestFin = r;
    }
    if (bestFin) return bestFin;
  }
  let best: Scored | null = null;
  for (const r of results) {
    if (best === null || r.travel > best.travel) best = r;
  }
  return best;
}

/**
 * Called from onGenerationEnd with the just-finished generation's
 * results.  Picks the champion, redraws the SVG model from the
 * winning genome (chassis vertex formula + wheel hub formula match
 * world.ts so the model looks like the canvas representation), and
 * fills the spec list with genome + run-result values.
 */
function updateLeaderCardFromGenEnd(results: Scored[], generation: number): void {
  const top = selectChampion(results);
  if (!top) return;
  setLeaderText('leader-index', `gen #${generation}`);
  setLeaderText('leader-spec-distance', `${top.travel.toFixed(1)} m`);
  setLeaderText(
    'leader-spec-time',
    top.finishTime !== null ? `${top.finishTime.toFixed(2)} s` : '—',
  );

  const g = top.genome;
  setLeaderText('leader-spec-wheels', String(g.wheels.length));
  setLeaderText('leader-spec-motor', g.motorSpeed.toFixed(1));
  const meanPower =
    g.wheels.length > 0 ? g.wheels.reduce((s, w) => s + w.power, 0) / g.wheels.length : 0;
  setLeaderText('leader-spec-power', `${(meanPower * 100).toFixed(0)}%`);
  setLeaderText('leader-spec-drive', driveBiasLabel(g.driveBias));
  const meanGrip =
    g.wheels.length > 0 ? g.wheels.reduce((s, w) => s + w.grip, 0) / g.wheels.length : 0;
  setLeaderText('leader-spec-grip', `${(meanGrip * 100).toFixed(0)}%`);
  setLeaderText('leader-spec-aero', g.aero.toFixed(2));
  setLeaderText('leader-spec-stabilizer', g.stabilizer.toFixed(2));

  renderLeaderModelFromGenome(g);
}

function driveBiasLabel(b: number): string {
  if (b < 0.33) return t('leader.driveRear');
  if (b > 0.66) return t('leader.driveFront');
  return t('leader.driveFull');
}

/**
 * Reset the leader card to its empty state.  Called from freshRun
 * when the player clicks New Population — the previous champion is
 * no longer relevant for a freshly seeded run.
 */
function clearLeaderCard(): void {
  setLeaderText('leader-index', '—');
  for (const id of [
    'leader-spec-distance',
    'leader-spec-time',
    'leader-spec-wheels',
    'leader-spec-motor',
    'leader-spec-power',
    'leader-spec-drive',
    'leader-spec-grip',
    'leader-spec-aero',
    'leader-spec-stabilizer',
  ]) {
    setLeaderText(id, '—');
  }
  const chassis = document.getElementById('leader-chassis');
  const wheels = document.getElementById('leader-wheels');
  if (chassis) chassis.setAttribute('points', '');
  if (wheels) {
    while (wheels.firstChild) wheels.removeChild(wheels.firstChild);
  }
}

function setLeaderText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== value) el.textContent = value;
}

/**
 * Build the chassis-local polygon vertices from the genome — same
 * formula as world.ts:chassisVertices.  Each vertex sits at its
 * uniform angular slot, nudged by the per-vertex offset gene within
 * the jitter band that keeps the polygon convex.
 */
function computeChassisVertices(g: Genome): { x: number; y: number }[] {
  const verts: { x: number; y: number }[] = [];
  const n = g.chassisVertexCount;
  const gap = (Math.PI * 2) / n;
  const maxJitter = gap * 0.5 * TUNING.chassis.angleJitterFraction;
  for (let i = 0; i < n; i++) {
    const baseAngle = ((i + 0.5) / n) * Math.PI * 2;
    const offset01 = Math.max(0, Math.min(1, g.chassisAngleOffsets?.[i] ?? 0.5));
    const angle = baseAngle + (offset01 - 0.5) * 2 * maxJitter;
    const r = g.chassisRadii[i] ?? 0.5;
    verts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  return verts;
}

/**
 * Redraw the SVG car model from the genome alone — no live
 * snapshot needed.  Mirrors the canvas style from scene.ts:969+:
 * outlined chassis polygon (no fill), wheels with rim + optional
 * inner ring (bounce viz) + radial spoke, stroke width scaled by
 * the wheel's `power` gene.  Y-axis flipped vs Rapier (sim y-up,
 * SVG y-down) so the model reads with wheels below the body.
 */
function renderLeaderModelFromGenome(g: Genome): void {
  const svg = document.getElementById('leader-model');
  const chassis = document.getElementById('leader-chassis');
  const wheelsEl = document.getElementById('leader-wheels');
  if (!(svg instanceof SVGSVGElement) || !chassis || !wheelsEl) return;

  const verts = computeChassisVertices(g);
  const pts = verts.map((v) => `${v.x.toFixed(3)},${(-v.y).toFixed(3)}`).join(' ');
  chassis.setAttribute('points', pts);

  while (wheelsEl.firstChild) wheelsEl.removeChild(wheelsEl.firstChild);
  const maxOff = TUNING.wheel.maxOffset;
  type Hub = { x: number; y: number; r: number };
  const hubs: Hub[] = [];
  for (const wg of g.wheels) {
    const anchor = verts[wg.attachVertex] ?? { x: 0, y: 0 };
    const hub: Hub = {
      x: anchor.x + ((wg.offsetX ?? 0.5) - 0.5) * 2 * maxOff,
      y: anchor.y + ((wg.offsetY ?? 0.5) - 0.5) * 2 * maxOff,
      r: wg.radius,
    };
    hubs.push(hub);
    const power = Math.max(0, Math.min(1, wg.power));
    const stroke =
      TUNING.wheel.minStroke + (TUNING.wheel.maxStroke - TUNING.wheel.minStroke) * power;

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('transform', `translate(${hub.x.toFixed(3)} ${(-hub.y).toFixed(3)})`);

    const rim = document.createElementNS(SVG_NS, 'circle');
    rim.setAttribute('cx', '0');
    rim.setAttribute('cy', '0');
    rim.setAttribute('r', wg.radius.toFixed(3));
    rim.setAttribute('class', 'leader-card__rim');
    rim.setAttribute('stroke-width', stroke.toFixed(3));
    group.appendChild(rim);

    if (wg.bounce > 0.05) {
      const bounce = Math.max(0, Math.min(1, wg.bounce));
      const innerR = wg.radius * (0.92 + (0.45 - 0.92) * bounce);
      const inner = document.createElementNS(SVG_NS, 'circle');
      inner.setAttribute('cx', '0');
      inner.setAttribute('cy', '0');
      inner.setAttribute('r', innerR.toFixed(3));
      inner.setAttribute('class', 'leader-card__inner');
      inner.setAttribute('stroke-width', (stroke * 0.6).toFixed(3));
      group.appendChild(inner);
    }

    const spoke = document.createElementNS(SVG_NS, 'line');
    spoke.setAttribute('x1', '0');
    spoke.setAttribute('y1', '0');
    spoke.setAttribute('x2', wg.radius.toFixed(3));
    spoke.setAttribute('y2', '0');
    spoke.setAttribute('class', 'leader-card__spoke');
    spoke.setAttribute('stroke-width', (stroke * 0.7).toFixed(3));
    group.appendChild(spoke);

    wheelsEl.appendChild(group);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    const yf = -v.y;
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (yf < minY) minY = yf;
    if (yf > maxY) maxY = yf;
  }
  for (const h of hubs) {
    const yf = -h.y;
    if (h.x - h.r < minX) minX = h.x - h.r;
    if (h.x + h.r > maxX) maxX = h.x + h.r;
    if (yf - h.r < minY) minY = yf - h.r;
    if (yf + h.r > maxY) maxY = yf + h.r;
  }
  if (!Number.isFinite(minX)) {
    svg.setAttribute('viewBox', '-2 -1.5 4 3');
    return;
  }
  const pad = 0.2;
  const width = maxX - minX + 2 * pad;
  const height = maxY - minY + 2 * pad;
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${width} ${height}`);
}

/**
 * Wire the dock toggles (Seed / Evolution / Track) so each opens
 * its sibling drawer popover above the dock and only one drawer is
 * open at a time.  Click-outside or Escape closes the open drawer;
 * the strict-determinism warning popover (which lives inside the
 * Evolution drawer) is treated as part of that drawer for the
 * "outside" test, so opening it doesn't immediately collapse the
 * drawer underneath.
 */
function bindDockDrawers(): void {
  const toggles: { btn: HTMLButtonElement; drawer: HTMLElement }[] = [];
  const ids = ['seed', 'track'];
  for (const id of ids) {
    const btn = document.getElementById(`dock-toggle-${id}`);
    const drawer = document.getElementById(`dock-drawer-${id}`);
    if (btn instanceof HTMLButtonElement && drawer instanceof HTMLElement) {
      toggles.push({ btn, drawer });
    }
  }
  if (toggles.length === 0) return;

  const setOpen = (idx: number, open: boolean): void => {
    const entry = toggles[idx];
    if (!entry) return;
    entry.btn.setAttribute('aria-expanded', String(open));
    entry.drawer.hidden = !open;
  };

  const closeAll = (): void => {
    for (let i = 0; i < toggles.length; i++) setOpen(i, false);
  };

  toggles.forEach((entry, idx) => {
    entry.btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasOpen = entry.btn.getAttribute('aria-expanded') === 'true';
      closeAll();
      if (!wasOpen) setOpen(idx, true);
    });
    // Clicks inside the drawer shouldn't close it (hand-off to the
    // global pointerdown listener below).
    entry.drawer.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  });

  // Click anywhere outside an open drawer collapses it.  Pointerdown
  // (rather than click) catches drag-start gestures on the canvas so
  // the player can pan immediately without having to release the
  // mouse first.
  document.addEventListener('pointerdown', () => {
    closeAll();
  });

  // Escape closes whatever is open.
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const anyOpen = toggles.some((t) => t.btn.getAttribute('aria-expanded') === 'true');
    if (anyOpen) {
      ev.preventDefault();
      closeAll();
    }
  });
}

function bindSlider(inputId: string, valueId: string, apply: (v: number) => string): void {
  const input = document.getElementById(inputId);
  const valueEl = document.getElementById(valueId);
  if (!(input instanceof HTMLInputElement) || !(valueEl instanceof HTMLElement)) return;
  const sync = (): void => {
    const v = Number(input.value);
    valueEl.textContent = apply(v);
    updateSliderFill(input);
  };
  input.addEventListener('input', sync);
  sync(); // pull initial state from HTML attrs
}

/**
 * Paint the filled portion of a range input by injecting a two-tone
 * linear-gradient on its background.  Native cross-browser styling
 * for the *track-up-to-thumb* segment isn't possible without
 * pseudo-elements that don't accept gradient values consistently —
 * setting the input's own background works in every modern browser
 * and keeps the SCSS-free CSS file simple.  The colour stops are
 * CSS variables so the dark/light themes track automatically.
 */
function updateSliderFill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max);
  const value = Number(input.value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.background = `linear-gradient(to right, var(--color-panel-accent) 0%, var(--color-panel-accent) ${pct}%, var(--color-surface-2) ${pct}%, var(--color-surface-2) 100%)`;
}

type Session = {
  world: WorldProxy;
  stop(): void;
  /** Length of the track this session is running on, in metres.  The
   *  host reads it at gen-end to feed collectStats so the stall-
   *  heatmap chart has a stable x-axis. */
  trackLength: number;
  /** Seed of the track this session is running on — surfaced for
   *  debug-bundle export when the user clicks a car. */
  trackSeed: number;
  /** Generation index for the current session.  Surfaced alongside
   *  trackSeed for debug bundles so the bundle is fully
   *  self-contained. */
  generation: number;
};

type StartOptions = {
  trackSeed: number;
  /**
   * Per-generation overrides merged into DEFAULT_TRACK.  Carries
   * preset-driven amplitude (smooth/extreme) plus the user's
   * obstacle-slider settings.  Empty object = pure defaults.
   */
  trackOpts?: Partial<TrackOptions>;
  /** World gravity in G (1 G = 9.81 m/s²).  Threaded to createWorld;
   *  not part of TrackOptions since it doesn't affect track shape. */
  gravity?: number;
  generation: number;
  genomes: Genome[];
  /** How many of the leading genomes are deep-cloned elite carryover
   *  from the prev gen.  Threaded into createWorld → CarSnapshot so
   *  the renderer can tint elite chassis distinctly.  Pass 0 for
   *  gen 0 (no elites yet) or when eliteCount is configured to 0. */
  eliteCount: number;
  scene: SceneHandle;
  hud: Hud;
  onGenerationEnd: (results: Scored[]) => void;
  /**
   * Strict-determinism fast-forward context.  When non-null, the
   * tick loop watches for "every alive car is an elite whose
   * outcome we already know from a previous gen" — at that moment
   * it force-finishes the world and the gen-end results override
   * those elite cars' fitness + finishTime with the cached values.
   *
   *   eliteCount     — current `gaParams.eliteCount`
   *   cachedEntries  — top-N {fitness, finishTime} from prev gen,
   *                    sorted desc by fitness.  cachedEntries[i] is
   *                    the predicted outcome of the next-gen elite
   *                    at index i (since elites are inserted at
   *                    next[0..eliteCount-1] in fitness-descending
   *                    order; see population.ts).
   *   onTrigger      — called once when the shortcut fires (host
   *                    uses this to flash the FAST-FORWARD banner).
   */
  shortcutCtx?: {
    eliteCount: number;
    cachedEntries: { fitness: number; finishTime: number | null; travel: number }[];
    onTrigger: () => void;
  } | null;
  /**
   * When true, fitness for cars that finish is replaced with an
   * inverse-time bonus so the GA selects for fastest finish rather
   * than furthest distance.  See the SPEED_BASE constant in session
   * for the formula.  Non-finishers' fitness stays as travel
   * distance (clamped < trackLength), so any finisher always ranks
   * above any non-finisher.
   */
  speedMode: boolean;
};

async function startSession(opts: StartOptions): Promise<Session> {
  const { trackSeed, trackOpts, generation, genomes, scene, hud, onGenerationEnd } = opts;
  const shortcutCtx = opts.shortcutCtx ?? null;
  const sessionSpeedMode = opts.speedMode;

  const track = generateTrack(trackSeed, trackOpts ?? {});
  scene.setTrack(track.points, track.physicalObstacles, track.finishLineX);

  // The Rapier world lives in the simulation worker; `world` is the
  // main-thread async proxy to it.  Reused across generations — each
  // session just re-`init`s a fresh world inside the same worker.
  const world = getWorldProxy();
  await world.init({
    track,
    genomes,
    spawnX: SPAWN_X,
    isolated: strictDeterminism,
    eliteCount: opts.eliteCount,
    gravity: opts.gravity,
  });

  hud.total.textContent = String(genomes.length);
  hud.alive.textContent = String(genomes.length);
  hud.trackLength.textContent = `${track.options.length}m`;
  hud.seed.textContent = trackSeed.toString(16).padStart(8, '0');
  hud.generation.textContent = String(generation);

  let running = true;
  let endNotified = false;
  let lastTime = performance.now();
  let acc = 0;
  let elapsed = 0;
  let frameCount = 0;
  let shortcutApplied = false;
  let lastUiUpdateMs = 0;
  /**
   * Separate clock for HUD text writes (leader / alive / темп) so
   * they update at most ~4 Hz regardless of the render tier.  The
   * scene + minimap stay on their per-tier throttle so motion
   * looks smooth, but the ribbon-stat strings only re-rendering 4
   * times a second kills the visible flicker on bouncy values
   * (especially "темп" — its EMA wobbles within a multiplier and
   * the integer/decimal alternation flickered at 60 Hz).
   */
  let lastHudTextMs = 0;
  const HUD_TEXT_INTERVAL_MS = 250;

  // Schedule the next async tick.  A worker crash rejects the
  // `advance` promise; catch it so the failure is logged rather than
  // surfacing as a silent unhandled rejection.
  function scheduleTick(): void {
    requestAnimationFrame(() => {
      void tick().catch((err: unknown) => console.error('[sim] tick aborted', err));
    });
  }

  async function tick(): Promise<void> {
    if (!running) return;
    const tickStart = performance.now();
    const now = tickStart;
    const eff = effectiveSpeed();
    // While paused, the accumulator stays empty (no physics steps)
    // and lastTime is still updated so resuming doesn't dump a huge
    // backlog of simulated time into the world.
    if (paused) {
      lastTime = now;
      scheduleTick();
      return;
    }
    // Multiply real elapsed time by speed multiplier, then feed into
    // the fixed-timestep accumulator.  Cap the accumulator so a long
    // pause (tab hidden) doesn't try to simulate minutes of skipped
    // time on resume.
    const dt = Math.min((now - lastTime) / 1000, 0.25) * eff.multiplier;
    lastTime = now;
    acc = Math.min(acc + dt, MAX_ACC_SEC);
    const stepOpts = {
      substeps: eff.substeps,
      solverIterations: eff.solverIterations,
    };

    // Adaptive UI throttle: scale the configured baseline by the
    // current per-frame load so that on a roomy CPU we update the
    // HUD/minimap more often (smoother) and on a saturated CPU we
    // throttle harder (preserve physics throughput).  Computed before
    // `advance` so the worker knows whether to build a snapshot.
    //
    //   utilisation = smoothedFrameMs / 16.7 ms (60-fps budget)
    //   factor      = clamp(utilisation, 0.25, 2.0)
    //   adaptive    = base * factor
    const utilisation = smoothedFrameMs / 16.7;
    const adaptiveFactor = Math.max(0.25, Math.min(2, utilisation));
    // Clamp the per-frame throttle to 16 ms (= 60 Hz) so the canvas
    // never tries to redraw faster than that, even on a 120 Hz
    // display where RAF would otherwise fire at 8 ms.
    const adaptiveThrottle = Math.max(16, eff.uiThrottleMs * adaptiveFactor);
    const uiDue = now - lastUiUpdateMs >= adaptiveThrottle;

    // Strict-determinism fast-forward: tell the worker how many
    // leading cars are known elites so it can watch for "every alive
    // car is an elite" and cut the run short.  0 once it has fired.
    let shortcutEliteN = 0;
    if (!shortcutApplied && shortcutCtx && shortcutCtx.eliteCount > 0) {
      shortcutEliteN = Math.min(shortcutCtx.eliteCount, shortcutCtx.cachedEntries.length);
    }

    // Hand one frame's worth of stepping to the worker: the fixed-
    // timestep batch, the generation hard time-limit and the
    // strict-det shortcut all run off-thread.  The main thread is
    // free for input + rendering while `advance` is in flight — that
    // is the whole point of the worker.  `budgetMs` caps how long the
    // worker spends so a snapshot always comes back promptly.
    const result = await world.advance({
      maxSteps: Math.floor(acc / SIM_DT),
      budgetMs: STEP_DEADLINE_MS,
      stepOpts,
      elapsedBeforeSec: elapsed,
      shortcutEliteN,
      wantSnapshot: uiDue,
    });
    // restart() may have stopped this session while `advance` was in
    // flight — bail before touching any stale session state.
    if (!running) return;

    acc -= result.stepsRun * SIM_DT;
    elapsed += result.stepsRun * SIM_DT;
    simSecAccum += result.stepsRun * SIM_DT;

    if (result.shortcutTriggered && !shortcutApplied) {
      shortcutApplied = true;
      shortcutCtx?.onTrigger();
    }

    if (uiDue && result.snapshot) {
      // Throughput sample: realSpeed = (sim seconds advanced since
      // last sample) / (real seconds since last sample).  Smoothed
      // with an EMA so the readout doesn't flicker.
      const dtRealMs = now - lastPerfSampleMs;
      if (dtRealMs > 0) {
        const dtSim = simSecAccum - lastPerfSimSec;
        const realSpeed = dtSim / (dtRealMs / 1000);
        smoothedRealSpeed = smoothedRealSpeed * (1 - PERF_SMOOTHING) + realSpeed * PERF_SMOOTHING;
      }
      lastPerfSampleMs = now;
      lastPerfSimSec = simSecAccum;

      lastUiUpdateMs = now;
      const snap = result.snapshot;
      let tier: 'full' | 'lite' | 'none' = 'full';
      if (eff.headless) tier = 'none';
      else if (speedIdx === 1) tier = 'lite';
      frameCount++;
      const skipPixiThisFrame = tier === 'lite' && (frameCount & 1) === 1;
      scene.setSnapshot(snap, {
        tier: skipPixiThisFrame ? 'none' : tier,
        headless: eff.headless,
        showOnlyLeader,
      });
      // HUD text writes on their own slower cadence — see
      // HUD_TEXT_INTERVAL_MS.  Scene + minimap stay smooth via the
      // per-tier throttle above; only the ribbon strings get
      // throttled to 4 Hz so the eye doesn't catch the flicker on
      // the leader-distance / темп values.
      if (now - lastHudTextMs >= HUD_TEXT_INTERVAL_MS) {
        lastHudTextMs = now;
        updateHud(hud, snap);
        updateThroughputDisplay();
      }
    }

    if (!endNotified && result.allFinished) {
      endNotified = true;
      running = false;
      // `advance` always includes the snapshot when the generation
      // ended, so this is the final physics state.
      const snap = result.snapshot;
      const trackLength = track.options.length;
      const results: Scored[] = genomes.map((genome, i) => {
        const car = snap?.cars[i];
        const travel = car?.travel ?? 0;
        const finishTime = car?.finishTime ?? null;
        // Selection score (`fitness`).  Default = travel distance.
        // In speed mode any finisher's fitness is replaced with an
        // inverse-time bonus anchored at trackLength + 1 so the
        // slowest finisher still ranks above the best non-finisher.
        // Each second saved is worth one fitness unit; the constant
        // 1000 is just a headroom anchor (finishTime tops out around
        // TUNING.lifecycle.maxGenerationSec = 600 s).
        let fitness = travel;
        if (sessionSpeedMode && finishTime !== null) {
          fitness = trackLength + 1 + Math.max(0, 1000 - finishTime);
        }
        // Fast-forward override: when the strict-det shortcut fired
        // we cut the elite cars short of their full deterministic
        // run.  The cached fitness/finishTime from the previous gen
        // is what they *would* have scored — substitute both so the
        // GA scoring, record markers, and the speed-mode chart
        // don't see a bogus "elite regressed / didn't finish"
        // reading.
        let resolvedFinishTime = finishTime;
        let resolvedTravel = travel;
        if (shortcutApplied && shortcutCtx && i < shortcutCtx.cachedEntries.length) {
          const cached = shortcutCtx.cachedEntries[i]!;
          fitness = Math.max(fitness, cached.fitness);
          // travel stays mode-independent — it's the actual maxX and
          // feeds dashboard "best" / record-marker / stall heatmap.
          // The shortcut cut the live run short, so the cached value
          // is the truthful one.  Take the longer just in case the
          // live run somehow exceeded the cache (paranoia; should be
          // identical in strict-det).
          resolvedTravel = Math.max(travel, cached.travel);
          if (resolvedFinishTime === null && cached.finishTime !== null) {
            resolvedFinishTime = cached.finishTime;
          }
        }
        return {
          genome,
          fitness,
          travel: resolvedTravel,
          finishTime: resolvedFinishTime,
        };
      });
      onGenerationEnd(results);
      return;
    }
    // Frame-time EMA for the speed-button colour predictor.  Captures
    // *this* tick's wall-clock work — physics + UI — so a saturated
    // run shows up immediately as red on heavier tiers.
    const tickEnd = performance.now();
    const work = tickEnd - tickStart;
    smoothedFrameMs = smoothedFrameMs * (1 - PERF_SMOOTHING) + work * PERF_SMOOTHING;
    scheduleTick();
  }
  scheduleTick();

  return {
    world,
    trackLength: track.options.length,
    trackSeed,
    generation,
    stop(): void {
      running = false;
    },
  };
}

/**
 * Cached last-rendered text per element to skip redundant DOM
 * writes.  At 60 Hz a value like the leader's distance flickers
 * visibly because `0.1` increments produce string changes every
 * tick — even when the change is below the threshold of "useful
 * info".  The 250 ms HUD-text throttle below limits write
 * frequency, but the deadband cache cuts the rest: same string
 * means no DOM touch and therefore no layout / paint at all.
 */
const hudTextCache = new WeakMap<HTMLElement, string>();
function setText(el: HTMLElement, text: string): void {
  if (hudTextCache.get(el) === text) return;
  hudTextCache.set(el, text);
  el.textContent = text;
}

function updateHud(hud: Hud, snap: WorldSnapshot): void {
  let lead = 0;
  let alive = 0;
  for (const c of snap.cars) {
    if (c.travel > lead) lead = c.travel;
    if (!c.finished) alive++;
  }
  setText(hud.lead, `${lead.toFixed(1)} m`);
  setText(hud.alive, String(alive));
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
