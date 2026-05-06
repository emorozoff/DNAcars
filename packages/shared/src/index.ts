/**
 * Shared types between web app and server.
 * Keep this surface tiny and stable — anything here is wire format.
 */

export type Locale = 'en' | 'ru';

/** ISO date string, e.g. "2026-05-06". */
export type IsoDate = string;

/** Anonymous client identifier (UUID v4 stored in localStorage). */
export type ClientId = string;

/** Genome — the evolvable definition of a car. Wire-stable. */
export type Genome = {
  /** Schema version, bump on breaking changes to the shape. */
  version: 1;
  chassis: ChassisGene;
  wheels: WheelGene[];
  motor: MotorGene;
};

export type ChassisGene = {
  /** Number of vertices on the convex polygon, 3..16. */
  vertexCount: number;
  /** Per-vertex distance from center, length === vertexCount, normalized [0,1]. */
  radii: number[];
  /** Per-vertex angle jitter, length === vertexCount, normalized [0,1]. */
  angleJitter: number[];
  /** Body density, normalized [0,1]. */
  density: number;
};

export type WheelGene = {
  /** Wheel radius, normalized [0,1]. */
  radius: number;
  /** Wheel density, normalized [0,1]. */
  density: number;
  /** Tyre friction, normalized [0,1]. */
  friction: number;
  /** Index into chassis vertices, 0..vertexCount-1. */
  attachVertex: number;
  /** Suspension stiffness Hz, normalized [0,1]. */
  suspensionStiffness: number;
  /** Suspension damping ratio, normalized [0,1]. */
  suspensionDamping: number;
  /** Fraction of base motor torque, normalized [0,1]. */
  motorTorque: number;
};

export type MotorGene = {
  /** Base angular speed, normalized [0,1]. */
  baseSpeed: number;
  /** Whether the motor can apply reverse torque. */
  canReverse: boolean;
  /** Gear adjustment factor, normalized [0,1]. */
  gearRatio: number;
};

/** Score record for the leaderboard. */
export type Score = {
  clientId: ClientId;
  /** Optional human-friendly nickname. */
  nick?: string;
  /** Final fitness value. */
  value: number;
  /** Distance reached in meters. */
  distance: number;
  /** Generations elapsed before submission. */
  generations: number;
  /** Compact, deterministic genome for replay. */
  genome: Genome;
  /** ISO date of the daily challenge. */
  date: IsoDate;
  /** Submission timestamp (ms since epoch). */
  submittedAt: number;
};

/** Daily challenge descriptor. */
export type DailyChallenge = {
  date: IsoDate;
  /** Seed string used by the procgen track generator. */
  seed: string;
  /** Optional version of the physics rules used to validate scores. */
  physicsVersion: number;
};

export type LeaderboardEntry = {
  rank: number;
  nick?: string;
  value: number;
  distance: number;
  generations: number;
};

export type LeaderboardResponse = {
  challenge: DailyChallenge;
  total: number;
  entries: LeaderboardEntry[];
  /** Caller's own rank if known. */
  self?: LeaderboardEntry;
};

export const PHYSICS_VERSION = 1 as const;
