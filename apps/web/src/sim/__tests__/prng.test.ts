import { describe, expect, it } from 'vitest';
import { hashSeed, makeRng, rngInt, rngRange } from '../prng';

describe('prng', () => {
  it('produces deterministic streams for the same seed', () => {
    const a = makeRng('alpha');
    const b = makeRng('alpha');
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = Array.from({ length: 50 }, makeRng('alpha'));
    const b = Array.from({ length: 50 }, makeRng('beta'));
    expect(a).not.toEqual(b);
  });

  it('values fall in [0, 1)', () => {
    const r = makeRng(42);
    for (let i = 0; i < 10_000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('rngRange respects bounds', () => {
    const r = makeRng('rg');
    for (let i = 0; i < 1000; i++) {
      const v = rngRange(r, -3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
    }
  });

  it('rngInt is inclusive on both ends', () => {
    const r = makeRng('int');
    let sawMin = false;
    let sawMax = false;
    for (let i = 0; i < 5000; i++) {
      const v = rngInt(r, 0, 3);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
      if (v === 0) sawMin = true;
      if (v === 3) sawMax = true;
    }
    expect(sawMin && sawMax).toBe(true);
  });

  it('hashSeed is stable across calls', () => {
    expect(hashSeed('2026-05-06')).toBe(hashSeed('2026-05-06'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});
