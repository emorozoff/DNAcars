/**
 * Deterministic 32-bit PRNG (mulberry32).
 *
 * Reproducible across browsers and Node — same seed always yields the same
 * float64 stream in [0, 1).  Used for both terrain generation and any
 * GA-side decisions where we want exact replays.
 */

export type Rng = () => number;

/**
 * Hash an arbitrary string into a 32-bit unsigned integer (FNV-1a).
 * Convenient when the seed is human-readable like "2026-05-06".
 */
export function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Build a PRNG closure over a seed.  The seed may be a number or string.
 */
export function makeRng(seed: number | string): Rng {
  let state = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  return function rng(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [min, max). */
export function rngRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Integer in [min, max] inclusive. */
export function rngInt(rng: Rng, min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}
