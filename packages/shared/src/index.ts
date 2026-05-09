/**
 * Shared wire-format types between the web app and the server.
 *
 * Keep this surface tiny and stable — anything here is part of the
 * public API to the leaderboard / daily-challenge backend.  The
 * evolvable game state (genomes, runtime physics) lives inside the
 * web app and is intentionally not exported.
 */

export type Locale = 'en' | 'ru';

/** ISO date string, e.g. "2026-05-06". */
export type IsoDate = string;

/** Anonymous client identifier (UUID v4 stored in localStorage). */
export type ClientId = string;

/** Daily challenge descriptor. */
export type DailyChallenge = {
  date: IsoDate;
  /** Seed string used by the procgen track generator. */
  seed: string;
  /** Version of the physics rules used to validate scores. */
  physicsVersion: number;
};

export const PHYSICS_VERSION = 1 as const;
