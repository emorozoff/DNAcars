/**
 * DNAcars API — Cloudflare Worker.
 *
 * Skeleton for week 0. Real endpoints land in week 5 (Daily Challenge).
 * For now this only exposes /health and /challenge?date=YYYY-MM-DD,
 * where the challenge is computed deterministically without any storage.
 */

import type { DailyChallenge, IsoDate } from '@dnacars/shared';
import { PHYSICS_VERSION } from '@dnacars/shared';

export type Env = {
  // LEADERBOARD: KVNamespace; — wired in week 5
  [k: string]: unknown;
};

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, physicsVersion: PHYSICS_VERSION });
    }

    if (url.pathname === '/challenge') {
      const date = (url.searchParams.get('date') ?? todayUtc()) as IsoDate;
      const challenge: DailyChallenge = {
        date,
        seed: dateSeed(date),
        physicsVersion: PHYSICS_VERSION,
      };
      return json(challenge);
    }

    return json({ error: 'not_found' }, 404);
  },
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

function todayUtc(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deterministic seed derived from the date.
 * Stable across server restarts — same date always yields the same track.
 */
function dateSeed(date: IsoDate): string {
  let h = 2166136261;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `dna-${(h >>> 0).toString(36)}`;
}
