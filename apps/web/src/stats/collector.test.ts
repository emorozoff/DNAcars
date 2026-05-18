import { describe, expect, it } from 'vitest';
import { makeRng, randomGenome } from '../sim/world';
import type { Scored } from '../ga/population';
import { collectStats } from './collector';

const rng = makeRng(1);

function scored(travel: number, finishTime: number | null = null): Scored {
  return { genome: randomGenome(rng), fitness: travel, travel, finishTime };
}

describe('collectStats', () => {
  it('returns zeroed stats for an empty population', () => {
    const s = collectStats(0, 1, [], 200);
    expect(s.total).toBe(0);
    expect(s.best).toBe(0);
    expect(s.mean).toBe(0);
    expect(s.finishedCount).toBe(0);
    expect(s.finishRate).toBe(0);
    expect(s.trackLength).toBe(200);
  });

  it('computes best / worst / mean / median over travel distances', () => {
    const results = [scored(5), scored(100), scored(50), scored(0.5), scored(200)];
    const s = collectStats(3, 2, results, 300);
    expect(s.best).toBe(200);
    expect(s.worst).toBe(0.5);
    expect(s.mean).toBeCloseTo((5 + 100 + 50 + 0.5 + 200) / 5, 5);
    // Sorted: [0.5, 5, 50, 100, 200] — middle element.
    expect(s.median).toBe(50);
    expect(s.total).toBe(5);
  });

  it('counts only cars that travelled more than 1 m as alive', () => {
    const s = collectStats(0, 1, [scored(0.2), scored(1), scored(1.5), scored(80)], 200);
    // 1 m exactly is not "> 1"; 0.2 and 1 are dead, 1.5 and 80 are alive.
    expect(s.alive).toBe(2);
  });

  it('derives finishedCount + finishRate from non-null finish times', () => {
    const results = [scored(200, 12.5), scored(190, 14), scored(40), scored(10)];
    const s = collectStats(0, 1, results, 200);
    expect(s.finishedCount).toBe(2);
    expect(s.finishRate).toBe(50);
    expect(s.bestFinishTime).toBe(12.5);
    expect(s.finishTimes).toEqual([12.5, 14]);
  });

  it('reports a null bestFinishTime when nobody finished', () => {
    const s = collectStats(0, 1, [scored(40), scored(10)], 200);
    expect(s.bestFinishTime).toBeNull();
    expect(s.finishRate).toBe(0);
  });

  it('averages wheel radius across every wheel of every car', () => {
    const results = [scored(10), scored(20), scored(30)];
    let totalRadius = 0;
    let totalWheels = 0;
    for (const r of results) {
      for (const w of r.genome.wheels) {
        totalRadius += w.radius;
        totalWheels += 1;
      }
    }
    const s = collectStats(0, 1, results, 200);
    expect(s.avgWheelRadius).toBeCloseTo(totalRadius / totalWheels, 5);
  });
});
