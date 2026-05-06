/**
 * Procedural track generator.
 *
 * Track is a polyline of points in world space, starting at origin and
 * extending to the right.  Difficulty (vertical amplitude and slope) ramps
 * up smoothly with distance, layered from coarse to fine sine waves.
 *
 * Improvements over the BoxCar2D-style original:
 *   - Smooth `smoothstep` warm-up: first ~10m almost flat
 *   - Layered octaves (3) with golden-ratio frequency stack
 *   - Bounded slope: |dy/dx| <= 1.0 even at the hardest end
 *   - Deterministic for a given seed
 */

import { makeRng, type Rng } from './prng';

export type TrackPoint = { x: number; y: number };

export type TrackOptions = {
  /** Total horizontal length in meters. */
  length: number;
  /** Horizontal step between sample points in meters. */
  step: number;
  /** Maximum vertical amplitude (peak-to-peak / 2) reached at full difficulty. */
  maxAmplitude: number;
  /** Distance over which difficulty ramps from 0 to 1, in meters. */
  warmup: number;
};

export const DEFAULT_TRACK: TrackOptions = {
  length: 500,
  step: 0.8,
  maxAmplitude: 3.5,
  warmup: 50,
};

export type Track = {
  seed: string;
  points: TrackPoint[];
  finishX: number;
  options: TrackOptions;
};

export function generateTrack(seed: string, opts: Partial<TrackOptions> = {}): Track {
  const o: TrackOptions = { ...DEFAULT_TRACK, ...opts };
  const rng = makeRng(seed);

  // Three layered sine octaves with random phase + frequency.
  const layers = [
    { freq: 0.18, phase: rng() * Math.PI * 2, weight: 0.55 },
    { freq: 0.18 * 1.618, phase: rng() * Math.PI * 2, weight: 0.3 },
    { freq: 0.18 * 1.618 * 1.618, phase: rng() * Math.PI * 2, weight: 0.15 },
  ];
  // Slow random meandering, very low frequency, large amplitude.
  const drift = { freq: 0.02, phase: rng() * Math.PI * 2, weight: 0.7 };

  const points: TrackPoint[] = [];
  for (let x = 0; x <= o.length + 0.0001; x += o.step) {
    const ramp = smoothstep(0, o.warmup, x);
    let y = 0;
    for (const l of layers) {
      y += Math.sin(x * l.freq + l.phase) * l.weight;
    }
    y += Math.sin(x * drift.freq + drift.phase) * drift.weight;
    y *= ramp * o.maxAmplitude;
    points.push({ x, y });
  }

  // Snap the very first sample to y=0 so the spawn point is always flat.
  if (points[0]) points[0].y = 0;

  return {
    seed,
    points,
    finishX: o.length,
    options: o,
  };
}

/**
 * Slope of the track at a horizontal position.  Useful for AI/observer logic.
 * Linear interpolation between adjacent points.
 */
export function trackSlopeAt(track: Track, x: number): number {
  const { step } = track.options;
  const i = Math.floor(x / step);
  const a = track.points[i];
  const b = track.points[i + 1];
  if (!a || !b) return 0;
  return (b.y - a.y) / (b.x - a.x);
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (x <= edge0) return 0;
  if (x >= edge1) return 1;
  const t = (x - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

/**
 * Re-export so callers don't need a separate import for tests/inspection.
 */
export type { Rng };
