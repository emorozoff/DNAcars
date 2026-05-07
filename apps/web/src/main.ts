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
import { applyTranslations, bindLanguageToggle, t } from './i18n';
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
  type WorldHandle,
  type WorldSnapshot,
} from './sim/world';
import { mountScene, type SceneHandle } from './render/scene';
import { nextGeneration, type GAParams, type Scored } from './ga/population';

/** Short visual pause between generations so the eye registers the new batch. */
const GENERATION_PAUSE_MS = 600;

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
 * Real-time speed multiplier.  1 = realtime; 8 = "speed up", physics
 * advances 8× faster but rendering still runs every frame so the
 * generations whip through visibly.  Toggled by the speed-up button.
 */
let speedMultiplier = 1;

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

  // Cross-session evolution state.
  let generation = 0;
  let lastResults: Scored[] | null = null;
  let bestEver = 0;

  const restartBtn = document.getElementById('btn-restart');
  if (restartBtn instanceof HTMLButtonElement) {
    restartBtn.addEventListener('click', () => {
      generation = 0;
      lastResults = null;
      bestEver = 0;
      hud.best.textContent = '—';
      void restart();
    });
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') {
      ev.preventDefault();
      generation = 0;
      lastResults = null;
      bestEver = 0;
      hud.best.textContent = '—';
      void restart();
    }
  });

  const speedBtn = document.getElementById('btn-speedup');
  if (speedBtn instanceof HTMLButtonElement) {
    speedBtn.addEventListener('click', () => {
      speedMultiplier = speedMultiplier === 1 ? 8 : 1;
      speedBtn.textContent = speedMultiplier === 1 ? t('panel.speedup') : t('panel.speedupOn');
    });
  }

  let session: Session | null = null;

  async function restart(): Promise<void> {
    if (session) {
      session.stop();
      session.world.destroy();
    }
    const trackSeed = (Math.random() * 0xffffffff) >>> 0;

    // Build the genomes for this generation.  Gen 0 (or "Space"
    // restart) seeds with random genomes; later generations are
    // produced by the GA from the previous gen's fitness vector.
    let genomes: Genome[];
    if (lastResults && generation > 0) {
      const gaRng = makeRng(trackSeed ^ 0xfeedface);
      genomes = nextGeneration(lastResults, gaParams, gaRng);
    } else {
      const rng = makeRng(trackSeed ^ 0xdeadbeef);
      genomes = [];
      for (let i = 0; i < gaParams.populationSize; i++) genomes.push(randomGenome(rng));
    }

    session = await startSession({
      trackSeed,
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
        generation += 1;
        setTimeout(() => void restart(), GENERATION_PAUSE_MS / speedMultiplier);
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
  generation: number;
  genomes: Genome[];
  scene: SceneHandle;
  hud: Hud;
  onGenerationEnd: (results: Scored[]) => void;
};

async function startSession(opts: StartOptions): Promise<Session> {
  const { trackSeed, generation, genomes, scene, hud, onGenerationEnd } = opts;

  const track = generateTrack(trackSeed);
  scene.setTrack(track.points);

  const world = await createWorld({ track, genomes, spawnX: 6 });

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
    // Multiply real elapsed time by speed multiplier, then feed into
    // the fixed-timestep accumulator.  At ×1 the world ticks at real
    // time; at ×8 the same wall second produces 8 s of simulated time
    // (the inner while loop just runs more world.step()s).
    const dt = Math.min((now - lastTime) / 1000, 0.25) * speedMultiplier;
    lastTime = now;
    acc += dt;
    while (acc >= SIM_DT) {
      world.step();
      acc -= SIM_DT;
      elapsed += SIM_DT;
    }
    if (elapsed >= TUNING.lifecycle.maxGenerationSec) {
      world.forceFinishAll();
    }
    const snap = world.snapshot();
    scene.setSnapshot(snap);
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
