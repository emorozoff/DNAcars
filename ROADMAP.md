# DNAcars Roadmap

Living document — updated on every release. Tracks **what works now**,
**what's next**, and the long-term direction.

Current version: **1.70.3**. Live at <https://emorozoff.github.io/DNAcars/>.

## Legend

- ✅ done and stable
- 🔄 in active iteration (may change)
- ⏳ planned, not started
- 💡 idea, not committed yet

## Vision

A spectacular browser-only "watch them evolve" sandbox in 2D minimalism,
inspired by **Genetic Cars 2** and **BoxCar2D** — but with believable
physics, a calmer feel, and a daily challenge to share.

Stack: TypeScript + Vite + PixiJS + Rapier2D. Cloudflare Pages for the
front, Cloudflare Workers + KV for the leaderboard later. The physics
sim runs in a Web Worker; the GA + track generation stay on the main
thread (they run once per generation, not per frame).

---

## Phase 1 — Foundation (✅ done, v0.5.0)

|     | What                                                      | Where it lives                               |
| --- | --------------------------------------------------------- | -------------------------------------------- |
| ✅  | TS-strict monorepo (npm workspaces)                       | `apps/web`, `apps/server`, `packages/shared` |
| ✅  | Vite + PixiJS v8 dev shell, dark minimalist tokens        | `apps/web/src/styles`                        |
| ✅  | i18n shim EN/RU with localStorage persistence             | `apps/web/src/i18n`                          |
| ✅  | Rapier2D physics core (compat-WASM build)                 | `apps/web/src/sim/world.ts`                  |
| ✅  | Genetic algorithm core (selection / crossover / mutation) | `apps/web/src/ga`                            |
| ✅  | Procedural track generator (layered sines + warm-up)      | `apps/web/src/sim/world.ts`                  |
| ✅  | Vitest unit tests for the GA + stats + i18n               | co-located `*.test.ts`                       |
| ✅  | GitHub Actions CI: format, lint, typecheck, test, build   | `.github/workflows/ci.yml`                   |
| ✅  | GitHub Pages auto-deploy from this branch                 | `.github/workflows/deploy.yml`               |
| ✅  | Visible version badge in the top bar                      | `apps/web/src/main.ts`                       |

## Phase 2 — Convincing Physics (🔄 in iteration, v0.6.0 → 0.8.2)

The user's recurring goal: cars must move in physically believable ways.
Each release closed a specific "this looks fake" complaint.

| Version | Change                                                                | Why                                            |
| ------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| 0.6.0   | Genome v2: dropped suspension, friction, reverse, gear ratio          | Less noise for evolution                       |
| 0.6.0   | Camera follows the leader, not the lowest-index car                   | "I want to see whoever is winning"             |
| 0.7.0   | Slippery chassis (`friction=0`), motor only fires for grounded wheels | "Cars shouldn't drive on their roof"           |
| 0.7.1   | Ground check via `sampleTrackY` instead of Rapier raycast             | `castRay` was unreliable in compat-WASM        |
| 0.7.1   | Heavy chassis vs light wheels                                         | Low CG → flips for real reasons, not random    |
| 0.7.2   | Camera follows max `position.x` (was `travel`)                        | Showed back of pack on staggered spawns        |
| 0.7.2   | Two-sided "wheel on ground" check                                     | Caught wheels that fell through the polyline   |
| 0.8.0   | All cars spawn at the same point                                      | Honest comparisons; Test Arena requires it     |
| 0.8.0   | **Test Arena** mode: 6 hand-crafted physics regression cars           | Visual debugging for physics rules             |
| 0.8.1   | Spawn at x=12 with a back wall at x=0                                 | Cars no longer fall off the start of the world |
| 0.8.2   | Heavy + sticky chassis (density 250-450, friction 0.8)                | Body-on-track now decelerates hard             |
| 0.8.2   | Death rule = **only "no forward progress"** (stall + sliding window)  | User: "kill it only if it can't move"          |
| 0.8.2   | Wider ground tolerance (12 cm)                                        | Wheels register on slopes more reliably        |

### Still to do in this phase

- ⏳ **Visual indicator that a wheel is in contact** (tint/glow on touching wheels) — makes the physics legible
- ⏳ **Track difficulty curves**: longer (800-1000 m), bigger amplitude after warmup, occasional jumps
- ⏳ **Air time and roll counters in the inspector** — for diagnosis
- ✅ **Sim moved into a Web Worker** (v1.68) — physics runs off the main thread, so fast-forward (×32/×64) no longer janks the UI; Rapier also dropped out of the main bundle (≈2 MB → ≈330 KB)
- 💡 **Better contact model**: replace the height-sample with a real Rapier `castShape` on a slim downward arc, once compat-WASM proves stable

## Phase 3 — Evolution UX (⏳ next)

The GA already runs; this phase makes it **understandable**.

- ⏳ Fitness chart (top / mean / median per generation) in a side widget
- ⏳ Genome inspector: click a car → side panel shows its genes with sliders, mutations highlighted
- ⏳ Ancestry view: from any car, walk back N generations to see how the design appeared
- ⏳ Save / Load population to/from a file
- ⏳ Pause + step-frame for inspection

## Phase 4 — Daily Challenge (⏳)

- ⏳ Cloudflare Worker `apps/server` already has a stub `/health` and `/challenge?date=`
- ⏳ Wire KV namespace `LEADERBOARD`
- ⏳ Anonymous client UUID in localStorage
- ⏳ Submit best score for today's track + show your rank
- ⏳ "Replay this run" links for top entries

## Phase 5 — Polish & Wow (⏳)

- ⏳ Particle trails behind moving wheels
- ⏳ Subtle parallax fog layer behind the track
- ⏳ Ambient sound (engine pitch tied to leader's speed)
- ⏳ Mobile-friendly touch + adaptive zoom
- ⏳ Onboarding overlay: 3 frames, "what evolution does"
- 💡 Cinematic camera on finish — slow-mo + accent flash

## Phase 6 — Public release (⏳)

- ⏳ Open Graph image for shares
- ⏳ Custom domain (or stay on `*.github.io`)
- ⏳ Launch posts: HN, r/genetic_algorithms, Twitter
- ⏳ Telemetry (PostHog free tier) for retention

---

## Versioning convention

`MAJOR.MINOR.PATCH`, semver-ish, pre-1.0:

- `MAJOR` = 0 (everything still in flux)
- `MINOR` bumps on user-visible behavioural shifts (camera rule changes, new arena, schema breaks)
- `PATCH` bumps on every commit that the user can verify by reloading the page

Each commit message starts with the new version (`fix(v0.8.2): ...`) and
the badge in the app header reflects what's deployed.

## How to read the live site

- The badge `v0.8.2` in the top-left should match the latest version below.
  If not, GitHub Pages is still building (~1-2 min after a push) or your
  browser is showing a cached copy (`Cmd+Shift+R` to bypass).
- Workflow status: <https://github.com/emorozoff/DNAcars/actions>
