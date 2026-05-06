/// <reference lib="webworker" />
/**
 * Simulation Web Worker — runs an endless GA loop:
 *   - generation 0: random genomes
 *   - simulate until every car is dead
 *   - score → tournament → crossover → mutation → next generation
 *   - same track, same gravity, repeat
 */

import type { Genome } from '@dnacars/shared';
import { DEFAULT_FITNESS, carFitness } from '../ga/fitness';
import { DEFAULT_MUTATION, crossoverGenomes, mutateGenome } from '../ga/genome-ops';
import { nextGeneration, summarizeGeneration } from '../ga/population';
import type { Scored } from '../ga/types';
import { randomGenome } from '../sim/genome';
import { makeRng, type Rng } from '../sim/prng';
import { generateTrack, type Track } from '../sim/track';
import { createWorld, SIM_DT, type WorldHandle } from '../sim/world';
import { DEFAULT_EVO, type EvoConfig, type MainToWorker, type WorkerToMain } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let world: WorldHandle | null = null;
let running = false;
let stepsPerFrame = 1;

let track: Track | null = null;
let gravity = 9.81;
let evo: EvoConfig = DEFAULT_EVO;
let evoRng: Rng = makeRng('init');
let generationIndex = 0;
let currentGenomes: Genome[] = [];

const SNAPSHOT_HZ = 60;
const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_HZ;
/**
 * Hard upper bound, kept very generous so it only fires if a car
 * genuinely gets into a permanent loop the lifecycle check missed.
 * Normal rounds end when every car dies on its own.
 */
const ROUND_HARD_CAP_SEC = 90;
let simTime = 0;
let lastSnapshotTime = 0;
let roundEnding = false;

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
    track = generateTrack(p.seed, p.track);
    gravity = p.gravity ?? 9.81;
    evo = { ...DEFAULT_EVO, ...(p.evo ?? {}) };
    // GA RNG is its own stream so it doesn't disturb terrain RNG.
    evoRng = makeRng(`${p.seed}/ga`);
    generationIndex = 0;
    currentGenomes = Array.from({ length: evo.populationSize }, () => randomGenome(evoRng));

    world = await createWorld({ track, genomes: currentGenomes, gravity });
    simTime = 0;
    lastSnapshotTime = 0;
    roundEnding = false;

    post({
      type: 'started',
      payload: {
        seed: p.seed,
        trackPoints: track.points,
        finishX: track.finishX,
        evo,
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
  setTimeout(tick, 1000 / 60);
}

function tick(): void {
  if (!running || !world || !track) return;
  for (let i = 0; i < stepsPerFrame; i++) {
    world.step();
    simTime += SIM_DT;
  }

  if (simTime - lastSnapshotTime >= SNAPSHOT_INTERVAL) {
    lastSnapshotTime = simTime;
    post({ type: 'snapshot', payload: world.snapshot() });
  }

  if (!roundEnding) {
    const snapshot = world.snapshot();
    const allDead = snapshot.cars.length > 0 && snapshot.cars.every((c) => !c.alive);
    const hardCap = simTime >= ROUND_HARD_CAP_SEC;
    if (allDead || hardCap) {
      roundEnding = true;
      advanceGeneration(snapshot);
    }
  }
  scheduleTick();
}

function advanceGeneration(snapshot: ReturnType<NonNullable<typeof world>['snapshot']>): void {
  if (!track) return;

  const scored: Scored<Genome>[] = snapshot.cars.map((c, i) => ({
    individual: currentGenomes[i] ?? currentGenomes[0]!,
    fitness: carFitness(c, c.travel, simTime, DEFAULT_FITNESS),
  }));
  const stats = summarizeGeneration(scored, generationIndex);
  const topGenome = (stats.topGenome as Genome | undefined) ?? scored[0]!.individual;

  post({
    type: 'generation',
    payload: {
      stats: {
        generation: stats.generation,
        best: stats.best,
        mean: stats.mean,
        median: stats.median,
        worst: stats.worst,
      },
      topGenome,
    },
  });

  // Build next generation
  generationIndex++;
  currentGenomes = nextGeneration(scored, {
    populationSize: evo.populationSize,
    eliteCount: evo.eliteCount,
    tournamentSize: evo.tournamentSize,
    crossover: (a, b, rng) => crossoverGenomes(a, b, rng),
    mutate: (g, rng) =>
      mutateGenome(g, rng, {
        ...DEFAULT_MUTATION,
        rate: evo.mutationRate,
        sigma: evo.mutationSigma,
        structuralRate: evo.structuralRate,
      }),
    rng: evoRng,
  });

  // Recreate world with the new genomes on the same track.
  try {
    if (world) world.destroy();
  } catch {
    /* ignore */
  }
  void rebuildWorld();
}

async function rebuildWorld(): Promise<void> {
  if (!track) return;
  try {
    world = await createWorld({ track, genomes: currentGenomes, gravity });
    simTime = 0;
    lastSnapshotTime = 0;
    roundEnding = false;
  } catch (err) {
    post({ type: 'error', payload: { message: errorMessage(err) } });
    running = false;
  }
}

function post(msg: WorkerToMain): void {
  self.postMessage(msg);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
