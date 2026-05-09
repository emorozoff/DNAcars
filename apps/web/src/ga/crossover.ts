/**
 * Crossover — combine two parent genomes into a child.
 *
 * For each independent gene we pick one of the two parents at random
 * (uniform crossover).  This keeps things simple and is the most
 * commonly used scheme for GA-style optimisation: children inherit
 * blocks of structure from each parent without us having to design
 * a clever blending rule per axis.
 *
 * Edge cases the function handles:
 *
 *   - Parents may have different chassis vertex counts.  We pick one
 *     parent's count and fill the radii array from whichever parent
 *     has data at that index (with a sensible fallback).
 *   - Parents may have different wheel counts.  We pick one parent's
 *     count, then for each wheel slot pick from whichever parent has
 *     a wheel at that index.
 *   - A wheel's `attachVertex` may exceed the inherited vertex count;
 *     we clamp it so the wheel still attaches to a real vertex.
 */

import type { Genome, Rng, WheelGene } from '../sim/world';

export function crossoverGenomes(a: Genome, b: Genome, rng: Rng): Genome {
  const pick = <T>(x: T, y: T): T => (rng() < 0.5 ? x : y);

  const vertexCount = pick(a.chassisVertexCount, b.chassisVertexCount);

  const radii: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const fromA = a.chassisRadii[i] ?? 0.5;
    const fromB = b.chassisRadii[i] ?? 0.5;
    radii.push(pick(fromA, fromB));
  }

  const wheelCount = pick(a.wheels.length, b.wheels.length);
  const wheels: WheelGene[] = [];
  for (let i = 0; i < wheelCount; i++) {
    // Each parent contributes a "wheel slot" at index i; if a parent
    // has fewer wheels than i we fall back to its last wheel.
    const wA = a.wheels[i] ?? a.wheels[a.wheels.length - 1];
    const wB = b.wheels[i] ?? b.wheels[b.wheels.length - 1];
    if (!wA && !wB) continue;
    if (!wA && wB) {
      wheels.push({ ...wB, attachVertex: clampVertex(wB.attachVertex, vertexCount) });
      continue;
    }
    if (wA && !wB) {
      wheels.push({ ...wA, attachVertex: clampVertex(wA.attachVertex, vertexCount) });
      continue;
    }
    if (!wA || !wB) continue; // narrow for TS
    wheels.push({
      attachVertex: clampVertex(pick(wA.attachVertex, wB.attachVertex), vertexCount),
      radius: pick(wA.radius, wB.radius),
      power: pick(wA.power, wB.power),
    });
  }

  return {
    chassisVertexCount: vertexCount,
    chassisRadii: radii,
    chassisDensity: pick(a.chassisDensity, b.chassisDensity),
    wheels,
    motorSpeed: pick(a.motorSpeed, b.motorSpeed),
  };
}

function clampVertex(v: number, vertexCount: number): number {
  if (v < 0) return 0;
  if (v >= vertexCount) return vertexCount - 1;
  return v;
}
