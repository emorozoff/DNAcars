/**
 * App bootstrap.
 *
 * Spawns N random-shape cars on a procedural hilly track and runs
 * the simulation in a fixed-timestep accumulator.  Each car drives
 * forward at full throttle until it stalls (no progress for several
 * seconds) — at which point it freezes in place with its travel
 * distance frozen as its fitness.  When every car has stalled (or a
 * hard cap on generation length is hit), the next generation kicks
 * off automatically with a fresh random track and a fresh batch of
 * random shapes.
 *
 * Real evolution (selection, crossover, mutation) lands in 0.9.3 —
 * for now the next generation is just another random batch, so we
 * can verify the per-generation lifecycle works end-to-end.
 */

import './styles/global.css';
import { applyTranslations, bindLanguageToggle } from './i18n';
import {
  createWorld,
  ensureRapier,
  generateTrack,
  makeRng,
  randomGenome,
  SIM_DT,
  TUNING,
  type Genome,
  type Track,
  type WorldHandle,
  type WorldSnapshot,
} from './sim/world';
import { mountScene, type SceneHandle } from './render/scene';

const CAR_COUNT = 24;
/** Short visual pause between generations so the eye registers the new batch. */
const GENERATION_PAUSE_MS = 600;

type Hud = {
  total: HTMLElement;
  lead: HTMLElement;
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
    seed: requireEl('stat-seed'),
    generation: requireEl('stat-generation'),
    version: requireEl('app-version'),
  };
  hud.version.textContent = `v${__APP_VERSION__}`;

  // Generation index survives across restarts so the user sees the
  // counter advance.  A manual restart (Space / button) resets it
  // to zero, since "new shapes from scratch" is a new run.
  let generation = 0;

  const restartBtn = document.getElementById('btn-restart');
  if (restartBtn instanceof HTMLButtonElement) {
    restartBtn.addEventListener('click', () => {
      generation = 0;
      void restart();
    });
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') {
      ev.preventDefault();
      generation = 0;
      void restart();
    }
  });

  let session: Session | null = null;

  async function restart(): Promise<void> {
    if (session) {
      session.stop();
      session.world.destroy();
    }
    const seed = (Math.random() * 0xffffffff) >>> 0;
    session = await startSession({
      seed,
      generation,
      scene,
      hud,
      onGenerationEnd: () => {
        generation += 1;
        // Brief pause so the player sees the final state before we wipe.
        setTimeout(() => void restart(), GENERATION_PAUSE_MS);
      },
    });
  }

  await restart();
}

type Session = {
  world: WorldHandle;
  track: Track;
  genomes: Genome[];
  stop(): void;
};

type StartOptions = {
  seed: number;
  generation: number;
  scene: SceneHandle;
  hud: Hud;
  onGenerationEnd: () => void;
};

async function startSession(opts: StartOptions): Promise<Session> {
  const { seed, generation, scene, hud, onGenerationEnd } = opts;

  const track = generateTrack(seed);
  scene.setTrack(track.points);

  const rng = makeRng(seed ^ 0xdeadbeef);
  const genomes: Genome[] = [];
  for (let i = 0; i < CAR_COUNT; i++) genomes.push(randomGenome(rng));

  const world = await createWorld({ track, genomes, spawnX: 6 });

  hud.total.textContent = String(CAR_COUNT);
  hud.seed.textContent = seed.toString(16).padStart(8, '0');
  hud.generation.textContent = String(generation);

  let running = true;
  let endNotified = false;
  let lastTime = performance.now();
  let acc = 0;
  let elapsed = 0;

  function tick(): void {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    acc += dt;
    while (acc >= SIM_DT) {
      world.step();
      acc -= SIM_DT;
      elapsed += SIM_DT;
    }
    // Hard cap so a degenerate seed where everyone keeps drifting can't
    // pin evolution forever.  After the cap, force-finish remaining
    // cars and let the all-finished branch trigger the next generation.
    if (elapsed >= TUNING.lifecycle.maxGenerationSec) {
      world.forceFinishAll();
    }
    const snap = world.snapshot();
    scene.setSnapshot(snap);
    updateHud(hud, snap);

    if (!endNotified && world.allFinished()) {
      endNotified = true;
      running = false;
      onGenerationEnd();
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return {
    world,
    track,
    genomes,
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
