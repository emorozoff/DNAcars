import { describe, expect, it } from 'vitest';
import { makeRng, randomGenome, TUNING } from '../sim/world';
import { mutateGenome } from './mutation';

describe('mutateGenome', () => {
  it('leaves continuous + structural genes untouched at rate 0', () => {
    const rng = makeRng(1);
    const g = randomGenome(rng);
    const out = mutateGenome(g, 0, rng);
    // rate 0 means no nudge ever fires and no structural roll passes.
    expect(out.chassisVertexCount).toBe(g.chassisVertexCount);
    expect(out.motorSpeed).toBe(g.motorSpeed);
    expect(out.chassisDensity).toBe(g.chassisDensity);
    expect(out.aero).toBe(g.aero);
    expect(out.stabilizer).toBe(g.stabilizer);
    expect(out.driveBias).toBe(g.driveBias);
  });

  it('keeps every gene inside its legal range at rate 1', () => {
    const rng = makeRng(2);
    for (let i = 0; i < 50; i++) {
      const out = mutateGenome(randomGenome(rng), 1, rng);
      expect(out.chassisVertexCount).toBeGreaterThanOrEqual(TUNING.chassis.minVertices);
      expect(out.chassisVertexCount).toBeLessThanOrEqual(TUNING.chassis.maxVertices);
      expect(out.chassisDensity).toBeGreaterThanOrEqual(TUNING.chassis.minDensity);
      expect(out.chassisDensity).toBeLessThanOrEqual(TUNING.chassis.maxDensity);
      expect(out.motorSpeed).toBeGreaterThanOrEqual(TUNING.motor.minSpeed);
      expect(out.motorSpeed).toBeLessThanOrEqual(TUNING.motor.maxSpeed);
      for (const r of out.chassisRadii) {
        expect(r).toBeGreaterThanOrEqual(TUNING.chassis.minRadius);
        expect(r).toBeLessThanOrEqual(TUNING.chassis.maxRadius);
      }
      for (const w of out.wheels) {
        expect(w.radius).toBeGreaterThanOrEqual(TUNING.wheel.minRadius);
        expect(w.radius).toBeLessThanOrEqual(TUNING.wheel.maxRadius);
        expect(w.power).toBeGreaterThanOrEqual(0);
        expect(w.power).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the wheel count within the configured bounds', () => {
    const rng = makeRng(3);
    for (let i = 0; i < 50; i++) {
      const out = mutateGenome(randomGenome(rng), 1, rng);
      expect(out.wheels.length).toBeGreaterThanOrEqual(TUNING.wheel.minCount);
      expect(out.wheels.length).toBeLessThanOrEqual(TUNING.wheel.maxCount);
    }
  });

  it('keeps the per-vertex arrays in sync with the vertex count', () => {
    const rng = makeRng(4);
    for (let i = 0; i < 30; i++) {
      const out = mutateGenome(randomGenome(rng), 1, rng);
      expect(out.chassisRadii).toHaveLength(out.chassisVertexCount);
      expect(out.chassisAngleOffsets).toHaveLength(out.chassisVertexCount);
    }
  });

  it('is deterministic for a fixed (genome, rate, seed)', () => {
    const g = randomGenome(makeRng(5));
    expect(mutateGenome(g, 0.5, makeRng(60))).toEqual(mutateGenome(g, 0.5, makeRng(60)));
  });

  it('does not mutate the input genome', () => {
    const g = randomGenome(makeRng(6));
    const copy = structuredClone(g);
    mutateGenome(g, 1, makeRng(7));
    expect(g).toEqual(copy);
  });
});
