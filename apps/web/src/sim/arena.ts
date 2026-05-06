/**
 * Hand-crafted test cars for the physics test arena.
 *
 * Each entry is a fixed Genome chosen to expose one specific behaviour
 * we want to verify visually:
 *   - "should drive normally"
 *   - "should not drive at all" (motor unable to engage, no traction)
 *   - "should struggle, drag the body, eventually die"
 *
 * Verts are placed on evenly spaced rays around the centre (the same way
 * `decodeGenome` does it).  The first ray is at angle (0+0.5)/n × 2π,
 * i.e. counter-clockwise from the +x axis.  Convenience helpers below
 * pick the index whose ray points in a given direction.
 */

import type { Genome } from '@dnacars/shared';

export type ArenaCase = {
  /** Stable identifier — used in URLs and logs. */
  id: string;
  /** Short human-readable label for the side panel. */
  labelEn: string;
  labelRu: string;
  /** Why this case exists. */
  expectationEn: string;
  expectationRu: string;
  genome: Genome;
};

/** Helper: index of the chassis vertex closest to a given world angle. */
function vertexAt(n: number, targetAngle: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    // Wrap to [-π, π] for shortest-arc distance.
    let d = Math.abs(((a - targetAngle + Math.PI) % (Math.PI * 2)) - Math.PI);
    if (Number.isNaN(d)) d = Math.abs(a - targetAngle);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

const NEAR_BOTTOM = -Math.PI / 2; // pointing down
const NEAR_TOP = Math.PI / 2;
const NEAR_LEFT = Math.PI;
const NEAR_RIGHT = 0;
const NEAR_BOTTOM_LEFT = (-Math.PI * 3) / 4;
const NEAR_BOTTOM_RIGHT = -Math.PI / 4;

/** Build a uniform-radius hexagon-ish chassis for predictable shapes. */
function uniformChassis(n: number, radius01: number, density01: number): Genome['chassis'] {
  return {
    vertexCount: n,
    radii: Array.from({ length: n }, () => radius01),
    density: density01,
  };
}

const N = 8; // common vertex count

export const ARENA_CASES: ArenaCase[] = [
  // 1. Two wheels at the bottom corners — the textbook "good" car.
  {
    id: 'two-bottom',
    labelEn: '2 wheels (correct)',
    labelRu: '2 колеса (правильная)',
    expectationEn: 'Drives smoothly all the way',
    expectationRu: 'Едет уверенно',
    genome: {
      version: 2,
      chassis: uniformChassis(N, 0.45, 0.6),
      wheels: [
        {
          radius: 0.55,
          density: 0.4,
          attachVertex: vertexAt(N, NEAR_BOTTOM_LEFT),
          motorTorque: 1.0,
        },
        {
          radius: 0.55,
          density: 0.4,
          attachVertex: vertexAt(N, NEAR_BOTTOM_RIGHT),
          motorTorque: 1.0,
        },
      ],
      motor: { baseSpeed: 0.6 },
    },
  },

  // 2. One wheel at the very bottom — should drive but wobble.
  {
    id: 'one-bottom',
    labelEn: '1 wheel (centre)',
    labelRu: '1 колесо (внизу-центр)',
    expectationEn: 'Drives, wobbly. Body may scrape on slopes.',
    expectationRu: 'Едет, шатается. На склонах задевает корпусом.',
    genome: {
      version: 2,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [
        {
          radius: 0.7,
          density: 0.5,
          attachVertex: vertexAt(N, NEAR_BOTTOM),
          motorTorque: 1.0,
        },
      ],
      motor: { baseSpeed: 0.6 },
    },
  },

  // 3. One wheel mounted on the top — never touches ground.
  {
    id: 'one-top',
    labelEn: '1 wheel on top',
    labelRu: '1 колесо сверху',
    expectationEn: 'Should not move — motor never engages',
    expectationRu: 'Не должна ехать — мотор никогда не включается',
    genome: {
      version: 2,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [
        {
          radius: 0.5,
          density: 0.5,
          attachVertex: vertexAt(N, NEAR_TOP),
          motorTorque: 1.0,
        },
      ],
      motor: { baseSpeed: 0.6 },
    },
  },

  // 4. Wheels on the sides — hangs in the air, body skates.
  {
    id: 'side-wheels',
    labelEn: 'Side wheels',
    labelRu: 'Колёса по бокам',
    expectationEn: 'Wheels miss the ground; should die quickly',
    expectationRu: 'Колёса висят; должна быстро умереть',
    genome: {
      version: 2,
      chassis: uniformChassis(N, 0.7, 0.6),
      wheels: [
        {
          radius: 0.35,
          density: 0.5,
          attachVertex: vertexAt(N, NEAR_LEFT),
          motorTorque: 1.0,
        },
        {
          radius: 0.35,
          density: 0.5,
          attachVertex: vertexAt(N, NEAR_RIGHT),
          motorTorque: 1.0,
        },
      ],
      motor: { baseSpeed: 0.6 },
    },
  },

  // 5. One big rear wheel + one tiny front wheel — nose-down stance.
  {
    id: 'big-rear',
    labelEn: 'Big rear, tiny front',
    labelRu: 'Большое сзади, малое спереди',
    expectationEn: 'Drives with a noticeable forward lean',
    expectationRu: 'Едет с заметным наклоном вперёд',
    genome: {
      version: 2,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [
        {
          radius: 1.0,
          density: 0.5,
          attachVertex: vertexAt(N, NEAR_BOTTOM_LEFT),
          motorTorque: 1.0,
        },
        {
          radius: 0.05,
          density: 0.3,
          attachVertex: vertexAt(N, NEAR_BOTTOM_RIGHT),
          motorTorque: 0.4,
        },
      ],
      motor: { baseSpeed: 0.6 },
    },
  },

  // 6. Motor torque set to zero on every wheel — pure inertia, no drive.
  {
    id: 'no-motor',
    labelEn: 'No motor',
    labelRu: 'Без мотора',
    expectationEn: 'Should not drive at all',
    expectationRu: 'Не должна ехать совсем',
    genome: {
      version: 2,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [
        {
          radius: 0.5,
          density: 0.5,
          attachVertex: vertexAt(N, NEAR_BOTTOM_LEFT),
          motorTorque: 0,
        },
        {
          radius: 0.5,
          density: 0.5,
          attachVertex: vertexAt(N, NEAR_BOTTOM_RIGHT),
          motorTorque: 0,
        },
      ],
      motor: { baseSpeed: 0.6 },
    },
  },
];

export function arenaGenomes(): Genome[] {
  return ARENA_CASES.map((c) => c.genome);
}
