/**
 * App bootstrap.
 *
 * For now this is the same physics-demo loop we built in Phase 0:
 * spawns N random-shape cars on a procedural hilly track, every car
 * holds full throttle, the visible signal is which shapes can actually
 * drive forward.  The genetic algorithm and per-generation lifecycle
 * are added in following commits — this one only relocates the demo
 * files to the proper main-app paths.
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
  type Genome,
  type Track,
  type WorldHandle,
  type WorldSnapshot,
} from './sim/world';
import { mountScene, type SceneHandle } from './render/scene';

const CAR_COUNT = 24;

type Hud = {
  total: HTMLElement;
  lead: HTMLElement;
  seed: HTMLElement;
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
    version: requireEl('app-version'),
  };
  hud.version.textContent = `v${__APP_VERSION__}`;

  const restartBtn = document.getElementById('btn-restart');
  if (restartBtn instanceof HTMLButtonElement) {
    restartBtn.addEventListener('click', () => {
      void restart();
    });
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') {
      ev.preventDefault();
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
    session = await startSession(seed, scene, hud);
  }

  await restart();
}

type Session = {
  world: WorldHandle;
  track: Track;
  genomes: Genome[];
  stop(): void;
};

async function startSession(seed: number, scene: SceneHandle, hud: Hud): Promise<Session> {
  const track = generateTrack(seed);
  scene.setTrack(track.points);

  const rng = makeRng(seed ^ 0xdeadbeef);
  const genomes: Genome[] = [];
  for (let i = 0; i < CAR_COUNT; i++) genomes.push(randomGenome(rng));

  const world = await createWorld({ track, genomes, spawnX: 6 });

  hud.total.textContent = String(CAR_COUNT);
  hud.seed.textContent = seed.toString(16).padStart(8, '0');

  let running = true;
  let lastTime = performance.now();
  let acc = 0;

  function tick(): void {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    acc += dt;
    while (acc >= SIM_DT) {
      world.step();
      acc -= SIM_DT;
    }
    const snap = world.snapshot();
    scene.setSnapshot(snap);
    updateHud(hud, snap);
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
