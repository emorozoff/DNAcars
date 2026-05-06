/**
 * Wire protocol between the main thread and the simulation Web Worker.
 * Discriminated unions on `type` so message handling is exhaustively
 * type-checked.
 */

import type { Genome } from '@dnacars/shared';
import type { TrackOptions } from '../sim/track';
import type { WorldSnapshot } from '../sim/world';

/* ─── Main → Worker ─────────────────────────────────────────────────────── */

export type MainToWorker =
  | {
      type: 'start';
      payload: {
        seed: string;
        genomes: Genome[];
        gravity?: number;
        track?: Partial<TrackOptions>;
      };
    }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'set-rate'; payload: { stepsPerFrame: number } };

/* ─── Worker → Main ─────────────────────────────────────────────────────── */

export type WorkerToMain =
  | { type: 'ready' }
  | {
      type: 'started';
      payload: {
        seed: string;
        trackPoints: { x: number; y: number }[];
        finishX: number;
      };
    }
  | { type: 'snapshot'; payload: WorldSnapshot }
  | {
      type: 'done';
      payload: {
        scores: { index: number; score: number }[];
      };
    }
  | { type: 'error'; payload: { message: string } };

export type WorkerEvents = {
  ready(): void;
  started(payload: Extract<WorkerToMain, { type: 'started' }>['payload']): void;
  snapshot(payload: WorldSnapshot): void;
  done(payload: Extract<WorkerToMain, { type: 'done' }>['payload']): void;
  error(message: string): void;
};
