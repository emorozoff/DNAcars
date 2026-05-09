import { describe, expect, it } from 'vitest';
import { decodeGenome, randomGenome, PHYSICS } from '../../sim/genome';
import { makeRng } from '../../sim/prng';
import { crossoverGenomes, mutateGenome, DEFAULT_MUTATION } from '../genome-ops';

describe('genome-ops', () => {
  it('crossover produces a structurally valid genome', () => {
    const rng = makeRng('c');
    const a = randomGenome(rng);
    const b = randomGenome(rng);
    const child = crossoverGenomes(a, b, rng);
    expect(child.chassis.vertexCount).toBeGreaterThanOrEqual(PHYSICS.chassis.minVertices);
    expect(child.chassis.radii.length).toBe(child.chassis.vertexCount);
    expect(child.chassis.angleOffsets.length).toBe(child.chassis.vertexCount);
    expect(child.chassis.ballastVertex).toBeGreaterThanOrEqual(0);
    expect(child.chassis.ballastVertex).toBeLessThan(child.chassis.vertexCount);
    expect(child.wheels.length).toBeGreaterThanOrEqual(PHYSICS.wheel.minCount);
    for (const w of child.wheels) {
      expect(w.attachVertex).toBeGreaterThanOrEqual(0);
      expect(w.attachVertex).toBeLessThan(child.chassis.vertexCount);
      expect(w.friction).toBeGreaterThanOrEqual(0);
      expect(w.friction).toBeLessThanOrEqual(1);
      expect(w.restitution).toBeGreaterThanOrEqual(0);
      expect(w.restitution).toBeLessThanOrEqual(1);
    }
    // Decoder should not throw on the crossover output.
    expect(() => decodeGenome(child)).not.toThrow();
  });

  it('mutation keeps every gene in [0,1] and structure valid', () => {
    const rng = makeRng('m');
    let g = randomGenome(rng);
    for (let i = 0; i < 200; i++) {
      g = mutateGenome(g, rng, { ...DEFAULT_MUTATION, rate: 0.5, sigma: 0.5 });
      expect(g.chassis.density).toBeGreaterThanOrEqual(0);
      expect(g.chassis.density).toBeLessThanOrEqual(1);
      expect(g.chassis.ballastSize).toBeGreaterThanOrEqual(0);
      expect(g.chassis.ballastSize).toBeLessThanOrEqual(1);
      expect(g.chassis.ballastDensity).toBeGreaterThanOrEqual(0);
      expect(g.chassis.ballastDensity).toBeLessThanOrEqual(1);
      expect(g.chassis.ballastVertex).toBeGreaterThanOrEqual(0);
      expect(g.chassis.ballastVertex).toBeLessThan(g.chassis.vertexCount);
      expect(g.chassis.angleOffsets.length).toBe(g.chassis.vertexCount);
      for (const r of g.chassis.radii) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
      for (const a of g.chassis.angleOffsets) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
      for (const w of g.wheels) {
        expect(w.radius).toBeGreaterThanOrEqual(0);
        expect(w.radius).toBeLessThanOrEqual(1);
        expect(w.friction).toBeGreaterThanOrEqual(0);
        expect(w.friction).toBeLessThanOrEqual(1);
        expect(w.restitution).toBeGreaterThanOrEqual(0);
        expect(w.restitution).toBeLessThanOrEqual(1);
        expect(w.attachVertex).toBeLessThan(g.chassis.vertexCount);
      }
      expect(g.chassis.vertexCount).toBeGreaterThanOrEqual(PHYSICS.chassis.minVertices);
      expect(g.chassis.vertexCount).toBeLessThanOrEqual(PHYSICS.chassis.maxVertices);
      expect(g.wheels.length).toBeGreaterThanOrEqual(PHYSICS.wheel.minCount);
      expect(g.wheels.length).toBeLessThanOrEqual(PHYSICS.wheel.maxCount);
    }
  });

  it('mutation with rate=0 is a no-op on floats', () => {
    const rng = makeRng('z');
    const g = randomGenome(rng);
    const m = mutateGenome(g, rng, { rate: 0, sigma: 1, structuralRate: 0 });
    expect(m.chassis.density).toBe(g.chassis.density);
    expect(m.chassis.radii).toEqual(g.chassis.radii);
    expect(m.chassis.angleOffsets).toEqual(g.chassis.angleOffsets);
    expect(m.chassis.ballastSize).toBe(g.chassis.ballastSize);
    expect(m.chassis.ballastDensity).toBe(g.chassis.ballastDensity);
    expect(m.wheels[0]?.friction).toBe(g.wheels[0]?.friction);
    expect(m.wheels[0]?.restitution).toBe(g.wheels[0]?.restitution);
  });
});
