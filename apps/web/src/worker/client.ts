/**
 * Main-thread client for the simulation Worker.  Wraps `postMessage` plumbing
 * behind a tiny event emitter.
 */

import type { Genome } from '@dnacars/shared';
import type { TrackOptions } from '../sim/track';
import type { WorldSnapshot } from '../sim/world';
import type { MainToWorker, WorkerEvents, WorkerToMain } from './protocol';

export type SimClient = {
  start(opts: {
    seed: string;
    genomes: Genome[];
    gravity?: number;
    track?: Partial<TrackOptions>;
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
    done: new Set(),
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
      case 'done':
        handlers.done.forEach((h) => h(msg.payload));
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
