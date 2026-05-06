/**
 * Physics demo bootstrap.
 *
 * Spawns N random-shape cars on a long, hilly track.  All cars push
 * full throttle forever — bad shapes simply fail to make progress.
 * No deaths, no scoring, no genetics.  Press Space (or the button) to
 * reseed the track and respawn a fresh batch of shapes.
 */

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
} from './physics';
import { mountScene, type SceneHandle } from './render';

const CAR_COUNT = 24;

type Hud = {
  total: HTMLElement;
  lead: HTMLElement;
  seed: HTMLElement;
  version: HTMLElement;
};

async function bootstrap(): Promise<void> {
  await ensureRapier();

  const host = document.getElementById('canvas-host');
  if (!(host instanceof HTMLElement)) {
    throw new Error('canvas-host element missing');
  }
  const scene = await mountScene(host);

  const hud: Hud = {
    total: requireEl('hud-total'),
    lead: requireEl('hud-lead'),
    seed: requireEl('hud-seed'),
    version: requireEl('hud-version'),
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
