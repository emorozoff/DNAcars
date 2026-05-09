/**
 * Selection — pick parents for the next generation, with probability
 * proportional to fitness ("roulette wheel" / "fitness-proportional"
 * selection).  The all-time canonical GA selection scheme.
 */

import type { Rng } from '../sim/world';

/**
 * Pick one item from `items` with probability ∝ its non-negative
 * weight.  When all weights are zero (everyone tied with fitness 0
 * — first generation can't move at all), fall back to uniform.
 */
export function rouletteSelect<T>(items: readonly T[], weights: readonly number[], rng: Rng): T {
  if (items.length === 0) throw new Error('rouletteSelect: empty pool');
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return items[Math.floor(rng() * items.length)]!;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]! > 0 ? weights[i]! : 0;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/**
 * Return the indices of the top `n` entries in `scores`, sorted from
 * best to worst.  Used to pull the elite cars out of a population.
 */
export function topNIndices(scores: readonly number[], n: number): number[] {
  const idx = scores.map((_, i) => i);
  idx.sort((a, b) => scores[b]! - scores[a]!);
  return idx.slice(0, Math.min(n, idx.length));
}
