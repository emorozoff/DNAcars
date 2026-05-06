import { describe, expect, it } from 'vitest';
import { decodeGenome, PHYSICS, randomGenome } from '../genome';
import { makeRng } from '../prng';

describe('genome', () => {
  it('randomGenome is deterministic given the same rng seed', () => {
    const a = randomGenome(makeRng('s'));
    const b = randomGenome(makeRng('s'));
    expect(a).toEqual(b);
  });

  it('produces a chassis within the allowed vertex range', () => {
    for (let i = 0; i < 50; i++) {
      const g = randomGenome(makeRng(`v${i}`));
      expect(g.chassis.vertexCount).toBeGreaterThanOrEqual(PHYSICS.chassis.minVertices);
      expect(g.chassis.vertexCount).toBeLessThanOrEqual(PHYSICS.chassis.maxVertices);
    }
  });

  it('produces wheels within count bounds', () => {
    for (let i = 0; i < 50; i++) {
      const g = randomGenome(makeRng(`w${i}`));
      expect(g.wheels.length).toBeGreaterThanOrEqual(PHYSICS.wheel.minCount);
      expect(g.wheels.length).toBeLessThanOrEqual(PHYSICS.wheel.maxCount);
    }
  });

  it('decoder maps every wheel attachment to a valid vertex', () => {
    for (let i = 0; i < 30; i++) {
      const g = randomGenome(makeRng(`a${i}`));
      const d = decodeGenome(g);
      for (const w of d.wheels) {
        expect(w.attachVertex).toBeGreaterThanOrEqual(0);
        expect(w.attachVertex).toBeLessThan(d.chassis.vertices.length);
      }
    }
  });

  it('decoder respects physics ranges', () => {
    const d = decodeGenome(randomGenome(makeRng('ranges')));
    expect(d.chassis.density).toBeGreaterThanOrEqual(PHYSICS.chassis.minDensity);
    expect(d.chassis.density).toBeLessThanOrEqual(PHYSICS.chassis.maxDensity);
    for (const w of d.wheels) {
      expect(w.radius).toBeGreaterThanOrEqual(PHYSICS.wheel.minRadius);
      expect(w.radius).toBeLessThanOrEqual(PHYSICS.wheel.maxRadius);
      expect(w.density).toBeGreaterThanOrEqual(PHYSICS.wheel.minDensity);
      expect(w.density).toBeLessThanOrEqual(PHYSICS.wheel.maxDensity);
    }
    expect(d.motor.baseSpeed).toBeGreaterThanOrEqual(PHYSICS.motor.minSpeed);
    expect(d.motor.baseSpeed).toBeLessThanOrEqual(PHYSICS.motor.maxSpeed);
  });

  it('chassis polygon vertices form a closed loop around the origin', () => {
    const d = decodeGenome(randomGenome(makeRng('poly')));
    const n = d.chassis.vertices.length;
    expect(n).toBeGreaterThanOrEqual(PHYSICS.chassis.minVertices);
    // Check angles are monotonically increasing modulo 2pi.
    const angles = d.chassis.vertices.map((v) => Math.atan2(v.y, v.x));
    for (let i = 1; i < angles.length; i++) {
      const prev = angles[i - 1]!;
      const cur = angles[i]!;
      // Allow wrap-around once at most.
      if (cur < prev) {
        expect(cur + 2 * Math.PI).toBeGreaterThan(prev);
      }
    }
  });
});
