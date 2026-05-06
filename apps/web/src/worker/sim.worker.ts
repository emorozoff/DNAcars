/// <reference lib="webworker" />
/**
 * Simulation Web Worker — runs the headless physics loop and posts snapshots.
 */

import { generateTrack } from '../sim/track';
import { createWorld, SIM_DT, type WorldHandle } from '../sim/world';
import type { MainToWorker, WorkerToMain } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let world: WorldHandle | null = null;
let running = false;
let stepsPerFrame = 1;
let lastSnapshotTime = 0;

const SNAPSHOT_HZ = 60;
const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_HZ;
let simTime = 0;

post({ type: 'ready' });

self.addEventListener('message', (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'start':
      void handleStart(msg.payload);
      break;
    case 'pause':
      running = false;
      break;
    case 'resume':
      if (world) {
        running = true;
        scheduleTick();
      }
      break;
    case 'stop':
      handleStop();
      break;
    case 'set-rate':
      stepsPerFrame = Math.max(1, Math.floor(msg.payload.stepsPerFrame));
      break;
  }
});

async function handleStart(p: Extract<MainToWorker, { type: 'start' }>['payload']): Promise<void> {
  try {
    handleStop();
    const track = generateTrack(p.seed, p.track);
    world = await createWorld({
      track,
      genomes: p.genomes,
      gravity: p.gravity ?? 9.81,
      spawnX: 0,
      spawnY: 0,
    });
    simTime = 0;
    lastSnapshotTime = 0;
    post({
      type: 'started',
      payload: {
        seed: p.seed,
        trackPoints: track.points,
        finishX: track.finishX,
      },
    });
    running = true;
    scheduleTick();
  } catch (err) {
    post({ type: 'error', payload: { message: errorMessage(err) } });
  }
}

function handleStop(): void {
  running = false;
  if (world) {
    try {
      world.destroy();
    } catch {
      /* ignore */
    }
    world = null;
  }
}

function scheduleTick(): void {
  if (!running || !world) return;
  // Browsers throttle setTimeout less than rAF when the tab is hidden,
  // which we want — keep the simulation running off-screen.
  setTimeout(tick, 1000 / 60);
}

function tick(): void {
  if (!running || !world) return;
  for (let i = 0; i < stepsPerFrame; i++) {
    world.step();
    simTime += SIM_DT;
  }
  if (simTime - lastSnapshotTime >= SNAPSHOT_INTERVAL) {
    lastSnapshotTime = simTime;
    post({ type: 'snapshot', payload: world.snapshot() });
  }
  // End-of-round detection: all cars dead → emit `done`.
  const snapshot = world.snapshot();
  if (snapshot.cars.length > 0 && snapshot.cars.every((c) => !c.alive)) {
    post({
      type: 'done',
      payload: {
        scores: snapshot.cars.map((c) => ({ index: c.index, score: c.score })),
      },
    });
    running = false;
    return;
  }
  scheduleTick();
}

function post(msg: WorkerToMain): void {
  self.postMessage(msg);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
