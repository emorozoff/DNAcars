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
      expect(g.chassis.radii.length).toBe(g.chassis.vertexCount);
      expect(g.chassis.angleOffsets.length).toBe(g.chassis.vertexCount);
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
      expect(w.friction).toBeGreaterThanOrEqual(PHYSICS.wheel.minFriction);
      expect(w.friction).toBeLessThanOrEqual(PHYSICS.wheel.maxFriction);
      expect(w.restitution).toBeGreaterThanOrEqual(PHYSICS.wheel.minRestitution);
      expect(w.restitution).toBeLessThanOrEqual(PHYSICS.wheel.maxRestitution);
    }
    expect(d.motor.baseSpeed).toBeGreaterThanOrEqual(PHYSICS.motor.minSpeed);
    expect(d.motor.baseSpeed).toBeLessThanOrEqual(PHYSICS.motor.maxSpeed);
  });

  it('chassis polygon vertices form a closed loop around the origin', () => {
    // Try many seeds — the angle-offset feature must never break the
    // monotonic ccw ordering, otherwise convexHull would degenerate.
    for (let i = 0; i < 50; i++) {
      const d = decodeGenome(randomGenome(makeRng(`poly${i}`)));
      const n = d.chassis.vertices.length;
      expect(n).toBeGreaterThanOrEqual(PHYSICS.chassis.minVertices);
      const angles = d.chassis.vertices.map((v) => Math.atan2(v.y, v.x));
      for (let j = 1; j < angles.length; j++) {
        const prev = angles[j - 1]!;
        const cur = angles[j]!;
        if (cur < prev) {
          expect(cur + 2 * Math.PI).toBeGreaterThan(prev);
        }
      }
    }
  });

  it('angle offsets actually move vertices when set away from 0.5', () => {
    // Two genomes identical except for angle offsets: the decoded vertex
    // angles should differ.  This guarantees v3's new gene actually does
    // something on the way to the phenotype.
    const base = randomGenome(makeRng('ang'));
    base.chassis.angleOffsets = base.chassis.angleOffsets.map(() => 0.5);
    const skewed = {
      ...base,
      chassis: { ...base.chassis, angleOffsets: base.chassis.angleOffsets.map(() => 0.0) },
    };
    const a = decodeGenome(base).chassis.vertices.map((v) => Math.atan2(v.y, v.x));
    const b = decodeGenome(skewed).chassis.vertices.map((v) => Math.atan2(v.y, v.x));
    expect(a).not.toEqual(b);
  });

  it('ballast is omitted when ballastSize is below the off-threshold', () => {
    const g = randomGenome(makeRng('bal-off'));
    g.chassis.ballastSize = 0;
    expect(decodeGenome(g).chassis.ballast).toBeNull();
  });

  it('ballast is present and at a valid vertex when size is large', () => {
    const g = randomGenome(makeRng('bal-on'));
    g.chassis.ballastSize = 1.0;
    g.chassis.ballastVertex = 0;
    const d = decodeGenome(g);
    expect(d.chassis.ballast).not.toBeNull();
    expect(d.chassis.ballast!.density).toBeGreaterThanOrEqual(PHYSICS.chassis.ballast.minDensity);
    expect(d.chassis.ballast!.density).toBeLessThanOrEqual(PHYSICS.chassis.ballast.maxDensity);
    // Position equals the chassis vertex it's attached to.
    expect(d.chassis.ballast!.position).toEqual(d.chassis.vertices[0]);
  });
});
