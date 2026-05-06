/**
 * Main-thread client for the simulation Worker.  Wraps `postMessage` plumbing
 * behind a tiny event emitter.
 */

import type { TrackOptions } from '../sim/track';
import type { WorldSnapshot } from '../sim/world';
import type { EvoConfig, MainToWorker, WorkerEvents, WorkerToMain } from './protocol';

export type SimClient = {
  start(opts: {
    seed: string;
    gravity?: number;
    track?: Partial<TrackOptions>;
    evo?: Partial<EvoConfig>;
  }): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(stepsPerFrame: number): void;
  on<K extends keyof WorkerEvents>(event: K, handler: WorkerEvents[K]): () => void;
  destroy(): void;
};

export function createSimClient(): SimClient {
  const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });

  const handlers: { [K in keyof WorkerEvents]: Set<WorkerEvents[K]> } = {
    ready: new Set(),
    started: new Set(),
    snapshot: new Set(),
    generation: new Set(),
    error: new Set(),
  };

  worker.addEventListener('message', (ev: MessageEvent<WorkerToMain>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'ready':
        handlers.ready.forEach((h) => h());
        break;
      case 'started':
        handlers.started.forEach((h) => h(msg.payload));
        break;
      case 'snapshot':
        handlers.snapshot.forEach((h) => h(msg.payload as WorldSnapshot));
        break;
      case 'generation':
        handlers.generation.forEach((h) => h(msg.payload));
        break;
      case 'error':
        handlers.error.forEach((h) => h(msg.payload.message));
        break;
    }
  });

  function send(msg: MainToWorker): void {
    worker.postMessage(msg);
  }

  return {
    start(opts) {
      send({ type: 'start', payload: opts });
    },
    pause() {
      send({ type: 'pause' });
    },
    resume() {
      send({ type: 'resume' });
    },
    stop() {
      send({ type: 'stop' });
    },
    setRate(stepsPerFrame) {
      send({ type: 'set-rate', payload: { stepsPerFrame } });
    },
    on(event, handler) {
      const set = handlers[event] as Set<typeof handler>;
      set.add(handler);
      return () => set.delete(handler);
    },
    destroy() {
      worker.terminate();
    },
  };
}
