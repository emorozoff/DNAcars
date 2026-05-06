/**
 * Physics demo bootstrap.
 *
 * Spawns N random-shape cars on a long, hilly track and lets you watch them
 * try to drive forward.  No genetics — every "Restart" button click reseeds
 * everything so you can sample a fresh batch of shapes.
 *
 * Loop:
 *   - Physics ticks at SIM_DT (1/60 s) inside a fixed-timestep accumulator
 *     driven by requestAnimationFrame.  This keeps the simulation
 *     deterministic regardless of frame jitter.
 *   - Snapshots are pushed to the renderer once per frame.
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
  alive: HTMLElement;
  total: HTMLElement;
  lead: HTMLElement;
  rolled: HTMLElement;
  bodied: HTMLElement;
  stalled: HTMLElement;
  seed: HTMLElement;
};

async function bootstrap(): Promise<void> {
  await ensureRapier();

  const host = document.getElementById('canvas-host');
  if (!(host instanceof HTMLElement)) {
    throw new Error('canvas-host element missing');
  }
  const scene = await mountScene(host);

  const hud: Hud = {
    alive: requireEl('hud-alive'),
    total: requireEl('hud-total'),
    lead: requireEl('hud-lead'),
    rolled: requireEl('hud-rolled'),
    bodied: requireEl('hud-bodied'),
    stalled: requireEl('hud-stalled'),
    seed: requireEl('hud-seed'),
  };

  const restartBtn = document.getElementById('btn-restart');
  if (restartBtn instanceof HTMLButtonElement) {
    restartBtn.addEventListener('click', () => {
      void restart();
    });
  }
  // Spacebar = restart for fast iteration.
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
    const dt = Math.min((now - lastTime) / 1000, 0.25); // clamp on tab-switch
    lastTime = now;
    acc += dt;
    // Fixed-timestep physics — no matter the frame rate, the world advances
    // by integer multiples of SIM_DT.
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
  let alive = 0;
  let lead = 0;
  let rolled = 0;
  let bodied = 0;
  let stalled = 0;
  for (const c of snap.cars) {
    if (!c.crashed) alive++;
    else if (c.crashReason === 'rollover') rolled++;
    else if (c.crashReason === 'body-down') bodied++;
    else if (c.crashReason === 'stalled') stalled++;
    if (c.travel > lead) lead = c.travel;
  }
  hud.alive.textContent = String(alive);
  hud.lead.textContent = `${lead.toFixed(1)} m`;
  hud.rolled.textContent = String(rolled);
  hud.bodied.textContent = String(bodied);
  hud.stalled.textContent = String(stalled);
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
