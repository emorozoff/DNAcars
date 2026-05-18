/**
 * Simulation worker — runs the Rapier physics off the main thread.
 *
 * Owns one WorldHandle.  The main thread drives it via the WorldProxy
 * RPC:
 *   - `init`    builds a world (and frees any previous one),
 *   - `advance` runs a budgeted batch of fixed-timestep steps and
 *               returns a snapshot + status,
 *   - `getCar`  serves the debug-bundle export,
 *   - `destroy` frees the Rapier world.
 *
 * Messages are processed strictly in order via a promise chain, so an
 * async `init` always completes before the next message is handled.
 *
 * Why a batched `advance` rather than one round-trip per step: at ×64
 * a frame owes hundreds of steps; one message per step would drown in
 * IPC.  The worker runs the whole batch (the fixed-timestep loop, the
 * generation time-limit, the strict-det shortcut) and replies once.
 */

import {
  createWorld,
  SIM_DT,
  TUNING,
  type CreateWorldOptions,
  type StepOptions,
  type WorldHandle,
} from '../sim/world';

type AdvanceMsg = {
  id: number;
  type: 'advance';
  maxSteps: number;
  budgetMs: number;
  stepOpts: StepOptions;
  elapsedBeforeSec: number;
  shortcutEliteN: number;
  wantSnapshot: boolean;
};

type Incoming =
  | { id: number; type: 'init'; opts: CreateWorldOptions }
  | AdvanceMsg
  | { id: number; type: 'getCar'; idx: number }
  | { id: number; type: 'destroy' };

// `self` is the DedicatedWorkerGlobalScope; cast to just the surface
// this file uses so the file type-checks under the web tsconfig's
// DOM lib without needing the `webworker` lib.
const ctx = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<Incoming>) => void) | null;
};

let world: WorldHandle | null = null;

function reply(id: number, result: unknown): void {
  ctx.postMessage({ id, ok: true, result });
}

function advance(msg: AdvanceMsg): {
  stepsRun: number;
  shortcutTriggered: boolean;
  allFinished: boolean;
  snapshot: unknown;
} {
  const w = world;
  if (!w) {
    return { stepsRun: 0, shortcutTriggered: false, allFinished: true, snapshot: null };
  }
  let stepsRun = 0;
  const deadline = performance.now() + msg.budgetMs;
  while (stepsRun < msg.maxSteps && performance.now() < deadline) {
    w.step(msg.stepOpts);
    stepsRun++;
  }
  // Generation hard time-limit — same check the old in-tick loop ran,
  // evaluated after the batch against the post-batch elapsed time.
  if (msg.elapsedBeforeSec + stepsRun * SIM_DT >= TUNING.lifecycle.maxGenerationSec) {
    w.forceFinishAll();
  }
  // Strict-determinism fast-forward: every still-alive car is a known
  // elite, so the rest of the run is already decided — cut it short.
  let shortcutTriggered = false;
  if (msg.shortcutEliteN > 0 && w.allAliveAreElites(msg.shortcutEliteN)) {
    w.forceFinishAll();
    shortcutTriggered = true;
  }
  const allFinished = w.allFinished();
  const snapshot = msg.wantSnapshot || allFinished ? w.snapshot() : null;
  return { stepsRun, shortcutTriggered, allFinished, snapshot };
}

async function handle(msg: Incoming): Promise<void> {
  switch (msg.type) {
    case 'init': {
      if (world) world.destroy();
      world = await createWorld(msg.opts);
      reply(msg.id, null);
      return;
    }
    case 'advance': {
      reply(msg.id, advance(msg));
      return;
    }
    case 'getCar': {
      if (!world) {
        reply(msg.id, null);
        return;
      }
      reply(msg.id, {
        snapshot: world.snapshot(),
        genome: world.getCarGenome(msg.idx),
        timeline: world.getCarTimeline(msg.idx),
        eventCounts: world.getCarEventCounts(msg.idx),
      });
      return;
    }
    case 'destroy': {
      if (world) world.destroy();
      world = null;
      reply(msg.id, null);
      return;
    }
  }
}

// Serialise message handling: each message fully completes (including
// the async `init`) before the next one starts.
let chain: Promise<void> = Promise.resolve();
ctx.onmessage = (e: MessageEvent<Incoming>): void => {
  const msg = e.data;
  chain = chain
    .then(() => handle(msg))
    .catch((err: unknown) => {
      ctx.postMessage({ id: msg.id, ok: false, error: String(err) });
    });
};
