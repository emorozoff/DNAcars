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

import type { Genome, WheelGene } from '@dnacars/shared';

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

type ChassisOpts = {
  ballastVertex?: number;
  ballastSize?: number;
  ballastDensity?: number;
  /** Optional per-vertex angle offset overrides; defaults to 0.5 (uniform). */
  angleOffsets?: number[];
};

/** Build a uniform-radius polygon chassis with sane defaults for v3 fields. */
function uniformChassis(
  n: number,
  radius01: number,
  density01: number,
  opts: ChassisOpts = {},
): Genome['chassis'] {
  return {
    vertexCount: n,
    radii: Array.from({ length: n }, () => radius01),
    angleOffsets: opts.angleOffsets ?? Array.from({ length: n }, () => 0.5),
    density: density01,
    ballastVertex: opts.ballastVertex ?? 0,
    ballastSize: opts.ballastSize ?? 0,
    ballastDensity: opts.ballastDensity ?? 0.5,
  };
}

/** Build a wheel gene with v3 defaults — mid-grip rubber, almost no bounce. */
function wheel(
  radius: number,
  density: number,
  attachVertex: number,
  motorTorque: number,
  overrides: Partial<WheelGene> = {},
): WheelGene {
  return {
    radius,
    density,
    attachVertex,
    motorTorque,
    friction: 0.5,
    restitution: 0.1,
    ...overrides,
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
      version: 3,
      chassis: uniformChassis(N, 0.45, 0.6),
      wheels: [
        wheel(0.55, 0.4, vertexAt(N, NEAR_BOTTOM_LEFT), 1.0),
        wheel(0.55, 0.4, vertexAt(N, NEAR_BOTTOM_RIGHT), 1.0),
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
      version: 3,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [wheel(0.7, 0.5, vertexAt(N, NEAR_BOTTOM), 1.0)],
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
      version: 3,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [wheel(0.5, 0.5, vertexAt(N, NEAR_TOP), 1.0)],
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
      version: 3,
      chassis: uniformChassis(N, 0.7, 0.6),
      wheels: [
        wheel(0.35, 0.5, vertexAt(N, NEAR_LEFT), 1.0),
        wheel(0.35, 0.5, vertexAt(N, NEAR_RIGHT), 1.0),
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
      version: 3,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [
        wheel(1.0, 0.5, vertexAt(N, NEAR_BOTTOM_LEFT), 1.0),
        wheel(0.05, 0.3, vertexAt(N, NEAR_BOTTOM_RIGHT), 0.4),
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
      version: 3,
      chassis: uniformChassis(N, 0.5, 0.6),
      wheels: [
        wheel(0.5, 0.5, vertexAt(N, NEAR_BOTTOM_LEFT), 0),
        wheel(0.5, 0.5, vertexAt(N, NEAR_BOTTOM_RIGHT), 0),
      ],
      motor: { baseSpeed: 0.6 },
    },
  },

  // 7. Ballast on the rear-bottom vertex — heavy back end loads the
  //    drive wheel, should grip and climb better than #1 on slopes.
  {
    id: 'rear-ballast',
    labelEn: 'Rear ballast',
    labelRu: 'Балласт сзади',
    expectationEn: 'Drives with extra rear-wheel grip',
    expectationRu: 'Едет с прижатым задним колесом',
    genome: {
      version: 3,
      chassis: uniformChassis(N, 0.5, 0.4, {
        ballastVertex: vertexAt(N, NEAR_BOTTOM_LEFT),
        ballastSize: 0.7,
        ballastDensity: 0.8,
      }),
      wheels: [
        wheel(0.55, 0.4, vertexAt(N, NEAR_BOTTOM_LEFT), 1.0),
        wheel(0.55, 0.4, vertexAt(N, NEAR_BOTTOM_RIGHT), 1.0),
      ],
      motor: { baseSpeed: 0.6 },
    },
  },

  // 8. Wedge chassis: a 5-vertex hull whose right side has been pulled
  //    forward by `angleOffsets` to form a pointed "nose".  This shape
  //    is impossible in v2 (angles were locked to uniform spacing).
  //    Vertex 0 (uniform 36°) is pulled toward 0°, vertex 4 (uniform
  //    324°) is pulled toward 360° — they meet at the front.
  {
    id: 'wedge',
    labelEn: 'Wedge / bullet',
    labelRu: 'Клин (нос вперёд)',
    expectationEn: 'Pointed front, drives nose-first',
    expectationRu: 'Острый нос спереди, едет носом вперёд',
    genome: {
      version: 3,
      chassis: {
        vertexCount: 5,
        radii: [1.0, 0.55, 0.55, 0.55, 1.0],
        angleOffsets: [0.0, 0.5, 0.5, 0.5, 1.0],
        density: 0.5,
        ballastVertex: 0,
        ballastSize: 0,
        ballastDensity: 0.5,
      },
      wheels: [
        wheel(0.5, 0.4, 3, 1.0), // lower-left
        wheel(0.5, 0.4, 4, 1.0), // lower-right (the nose)
      ],
      motor: { baseSpeed: 0.6 },
    },
  },
];

export function arenaGenomes(): Genome[] {
  return ARENA_CASES.map((c) => c.genome);
}
