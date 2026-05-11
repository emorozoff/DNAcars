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
 *     parent's count and fill the per-vertex arrays (radii, angle
 *     offsets) from whichever parent has data at that index.
 *   - Parents may have different wheel counts.  We pick one parent's
 *     count, then for each wheel slot pick from whichever parent has
 *     a wheel at that index.
 *   - A wheel's `attachVertex` (or the chassis' `ballastVertex`) may
 *     exceed the inherited vertex count; we clamp it so the
 *     attachment point is always real.
 *   - Older genomes may lack v1.50 fields (angleOffsets, ballast,
 *     grip, bounce); we substitute sensible defaults rather than
 *     fail.
 */

import { pruneOverlappingWheels, type Genome, type Rng, type WheelGene } from '../sim/world';

export function crossoverGenomes(a: Genome, b: Genome, rng: Rng): Genome {
  const pick = <T>(x: T, y: T): T => (rng() < 0.5 ? x : y);

  const vertexCount = pick(a.chassisVertexCount, b.chassisVertexCount);

  const radii: number[] = [];
  const angleOffsets: number[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const rA = a.chassisRadii[i] ?? 0.5;
    const rB = b.chassisRadii[i] ?? 0.5;
    radii.push(pick(rA, rB));
    const aA = a.chassisAngleOffsets?.[i] ?? 0.5;
    const aB = b.chassisAngleOffsets?.[i] ?? 0.5;
    angleOffsets.push(pick(aA, aB));
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
      wheels.push({
        ...withWheelDefaults(wB),
        attachVertex: clampVertex(wB.attachVertex, vertexCount),
      });
      continue;
    }
    if (wA && !wB) {
      wheels.push({
        ...withWheelDefaults(wA),
        attachVertex: clampVertex(wA.attachVertex, vertexCount),
      });
      continue;
    }
    if (!wA || !wB) continue; // narrow for TS
    wheels.push({
      attachVertex: clampVertex(pick(wA.attachVertex, wB.attachVertex), vertexCount),
      radius: pick(wA.radius, wB.radius),
      power: pick(wA.power, wB.power),
      offsetX: pick(wA.offsetX ?? 0.5, wB.offsetX ?? 0.5),
      offsetY: pick(wA.offsetY ?? 0.5, wB.offsetY ?? 0.5),
      grip: pick(wA.grip ?? 0.5, wB.grip ?? 0.5),
      bounce: pick(wA.bounce ?? 0, wB.bounce ?? 0),
    });
  }

  const child: Genome = {
    chassisVertexCount: vertexCount,
    chassisRadii: radii,
    chassisAngleOffsets: angleOffsets,
    chassisDensity: pick(a.chassisDensity, b.chassisDensity),
    ballastVertex: clampVertex(pick(a.ballastVertex ?? 0, b.ballastVertex ?? 0), vertexCount),
    ballastSize: pick(a.ballastSize ?? 0, b.ballastSize ?? 0),
    ballastDensity: pick(a.ballastDensity ?? 0.5, b.ballastDensity ?? 0.5),
    wheels,
    motorSpeed: pick(a.motorSpeed, b.motorSpeed),
    aero: pick(a.aero ?? 0, b.aero ?? 0),
    stabilizer: pick(a.stabilizer ?? 0, b.stabilizer ?? 0),
    driveBias: pick(a.driveBias ?? 0.5, b.driveBias ?? 0.5),
    hue: pick(a.hue ?? 0, b.hue ?? 0),
  };
  // Crossover can pair a wheel from parent A with a chassis from
  // parent B and produce overlaps that neither parent had on its
  // own.  Prune so the child genome's wheel list matches what
  // buildCar will physically construct.
  return pruneOverlappingWheels(child);
}

function clampVertex(v: number, vertexCount: number): number {
  if (v < 0) return 0;
  if (v >= vertexCount) return vertexCount - 1;
  return v;
}

function withWheelDefaults(w: WheelGene): WheelGene {
  return {
    attachVertex: w.attachVertex,
    radius: w.radius,
    power: w.power,
    grip: w.grip ?? 0.5,
    bounce: w.bounce ?? 0,
    offsetX: w.offsetX ?? 0.5,
    offsetY: w.offsetY ?? 0.5,
  };
}
