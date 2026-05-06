import { describe, expect, it } from 'vitest';
import { generateTrack, trackSlopeAt } from '../track';

describe('track', () => {
  it('starts perfectly flat at origin', () => {
    const t = generateTrack('x');
    expect(t.points[0]).toEqual({ x: 0, y: 0 });
  });

  it('reaches the configured length', () => {
    const t = generateTrack('seed-length', { length: 200, step: 0.5, warmup: 10, maxAmplitude: 3 });
    const last = t.points[t.points.length - 1]!;
    expect(last.x).toBeGreaterThanOrEqual(200);
  });

  it('is deterministic for the same seed', () => {
    const a = generateTrack('determinism');
    const b = generateTrack('determinism');
    expect(a.points).toEqual(b.points);
  });

  it('differs across seeds', () => {
    const a = generateTrack('one');
    const b = generateTrack('two');
    expect(a.points).not.toEqual(b.points);
  });

  it('warmup ramps amplitude up smoothly', () => {
    const t = generateTrack('ramp', { length: 200, step: 1, warmup: 50, maxAmplitude: 5 });
    const earlyMax = Math.max(...t.points.slice(0, 5).map((p) => Math.abs(p.y)));
    const lateMax = Math.max(...t.points.slice(-50).map((p) => Math.abs(p.y)));
    expect(earlyMax).toBeLessThan(lateMax);
  });

  it('slope is finite and bounded', () => {
    const t = generateTrack('slope', { maxAmplitude: 5, length: 300, step: 0.5, warmup: 30 });
    for (let x = 0; x < 295; x += 5) {
      const s = trackSlopeAt(t, x);
      expect(Number.isFinite(s)).toBe(true);
      expect(Math.abs(s)).toBeLessThan(15);
    }
  });
});
