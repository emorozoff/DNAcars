/**
 * WorldProxy — main-thread async handle to the simulation worker.
 *
 * The Rapier physics world lives inside `sim.worker.ts`; this proxy is
 * the only thing the main thread talks to.  Each method posts a
 * message and resolves when the worker replies (matched by an
 * incrementing request id).
 *
 * The hot path is `advance()`: instead of one round-trip per physics
 * step, the main thread asks for a whole frame's worth of steps in a
 * single call.  The worker runs the fixed-timestep batch (bounded by a
 * wall-clock budget) and returns a snapshot + status.  The game-loop
 * orchestration — accumulator, generation lifecycle, GA, the
 * strict-determinism elite cache — all stays on the main thread.
 */

import type { CreateWorldOptions, StepOptions, WorldSnapshot } from '../sim/world';

/** One frame's worth of stepping work, sent to the worker. */
export type AdvanceRequest = {
  /** Fixed-timestep steps the accumulator currently owes. */
  maxSteps: number;
  /** Wall-clock budget (ms) — the worker stops early once exceeded so
   *  a snapshot always comes back promptly even at ×64. */
  budgetMs: number;
  stepOpts: StepOptions;
  /** Sim seconds already elapsed this generation, for the worker's
   *  hard time-limit check (TUNING.lifecycle.maxGenerationSec). */
  elapsedBeforeSec: number;
  /** Strict-determinism fast-forward: number of leading cars that are
   *  known elites.  0 disables the check. */
  shortcutEliteN: number;
  /** Whether the caller needs the snapshot this frame (UI is due). */
  wantSnapshot: boolean;
};

export type AdvanceResult = {
  /** Steps actually run (may be < maxSteps if the budget was hit). */
  stepsRun: number;
  /** True if the strict-det shortcut fired this frame. */
  shortcutTriggered: boolean;
  allFinished: boolean;
  /** Present when `wantSnapshot` was set or the generation ended. */
  snapshot: WorldSnapshot | null;
};

type WorkerResponse = { id: number; ok: boolean; result?: unknown; error?: string };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class WorldProxy {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>): void => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error ?? 'worker error'));
    };
    this.worker.onerror = (e: ErrorEvent): void => {
      // A hard worker failure rejects every outstanding call so the
      // app surfaces the error instead of hanging forever.
      const err = new Error(e.message || 'simulation worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private send<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  /** Build a fresh world inside the worker (replaces any existing one). */
  init(opts: CreateWorldOptions): Promise<void> {
    return this.send<void>('init', { opts });
  }

  /** Run one frame's batch of physics steps. */
  advance(req: AdvanceRequest): Promise<AdvanceResult> {
    return this.send<AdvanceResult>('advance', { ...req });
  }

  /** Free the worker's Rapier world. */
  destroy(): Promise<void> {
    return this.send<void>('destroy', {});
  }
}

let proxy: WorldProxy | null = null;

/** Lazily create the single app-wide simulation worker proxy. */
export function getWorldProxy(): WorldProxy {
  if (!proxy) proxy = new WorldProxy();
  return proxy;
}
