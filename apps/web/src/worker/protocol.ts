/**
 * Wire protocol between the main thread and the simulation Web Worker.
 * Discriminated unions on `type` so message handling is exhaustively
 * type-checked.
 */

import type { Genome } from '@dnacars/shared';
import type { TrackOptions } from '../sim/track';
import type { WorldSnapshot } from '../sim/world';

/* ─── Main → Worker ─────────────────────────────────────────────────────── */

export type EvoConfig = {
  populationSize: number;
  eliteCount: number;
  tournamentSize: number;
  mutationRate: number;
  mutationSigma: number;
  structuralRate: number;
};

export type MainToWorker =
  | {
      type: 'start';
      payload: {
        seed: string;
        gravity?: number;
        track?: Partial<TrackOptions>;
        evo?: Partial<EvoConfig>;
      };
    }
  | {
      type: 'start-arena';
      payload: {
        seed: string;
        gravity?: number;
        track?: Partial<TrackOptions>;
      };
    }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'set-rate'; payload: { stepsPerFrame: number } };

/* ─── Worker → Main ─────────────────────────────────────────────────────── */

export type GenerationStats = {
  generation: number;
  best: number;
  mean: number;
  median: number;
  worst: number;
};

export type WorkerToMain =
  | { type: 'ready' }
  | {
      type: 'started';
      payload: {
        seed: string;
        trackPoints: { x: number; y: number }[];
        finishX: number;
        evo: EvoConfig;
      };
    }
  | { type: 'snapshot'; payload: WorldSnapshot }
  | {
      type: 'generation';
      payload: {
        stats: GenerationStats;
        topGenome: Genome;
      };
    }
  | { type: 'error'; payload: { message: string } };

export type WorkerEvents = {
  ready(): void;
  started(payload: Extract<WorkerToMain, { type: 'started' }>['payload']): void;
  snapshot(payload: WorldSnapshot): void;
  generation(payload: Extract<WorkerToMain, { type: 'generation' }>['payload']): void;
  error(message: string): void;
};

export const DEFAULT_EVO: EvoConfig = {
  populationSize: 30,
  eliteCount: 2,
  tournamentSize: 4,
  mutationRate: 0.08,
  mutationSigma: 0.18,
  structuralRate: 0.04,
};
