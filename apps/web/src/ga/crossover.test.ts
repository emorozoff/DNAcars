import { describe, expect, it } from 'vitest';
import { makeRng, randomGenome } from '../sim/world';
import { crossoverGenomes } from './crossover';

describe('crossoverGenomes', () => {
  it('produces a structurally consistent child', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 30; i++) {
      const a = randomGenome(rng);
      const b = randomGenome(rng);
      const child = crossoverGenomes(a, b, rng);
      // Per-vertex arrays must match the inherited vertex count.
      expect(child.chassisRadii).toHaveLength(child.chassisVertexCount);
      expect(child.chassisAngleOffsets).toHaveLength(child.chassisVertexCount);
      // Every wheel must attach to a real vertex.
      for (const w of child.wheels) {
        expect(w.attachVertex).toBeGreaterThanOrEqual(0);
        expect(w.attachVertex).toBeLessThan(child.chassisVertexCount);
      }
    }
  });

  it('inherits the vertex count from one parent or the other', () => {
    const rng = makeRng(2);
    for (let i = 0; i < 30; i++) {
      const a = randomGenome(rng);
      const b = randomGenome(rng);
      const child = crossoverGenomes(a, b, rng);
      expect([a.chassisVertexCount, b.chassisVertexCount]).toContain(child.chassisVertexCount);
    }
  });

  it('takes each scalar gene from one parent or the other', () => {
    const rng = makeRng(3);
    const a = randomGenome(rng);
    const b = randomGenome(rng);
    const child = crossoverGenomes(a, b, rng);
    expect([a.motorSpeed, b.motorSpeed]).toContain(child.motorSpeed);
    expect([a.chassisDensity, b.chassisDensity]).toContain(child.chassisDensity);
    expect([a.driveBias, b.driveBias]).toContain(child.driveBias);
  });

  it('is deterministic for a fixed (parents, seed)', () => {
    const setup = makeRng(4);
    const a = randomGenome(setup);
    const b = randomGenome(setup);
    expect(crossoverGenomes(a, b, makeRng(50))).toEqual(crossoverGenomes(a, b, makeRng(50)));
  });

  it('does not mutate either parent', () => {
    const rng = makeRng(5);
    const a = randomGenome(rng);
    const b = randomGenome(rng);
    const aCopy = structuredClone(a);
    const bCopy = structuredClone(b);
    crossoverGenomes(a, b, rng);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});
