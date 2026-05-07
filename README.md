# DNAcars

Evolutionary 2D car simulation — a genetic algorithm in your browser.

Inspired by [Genetic Cars 2](https://rednuht.org/genetic_cars_2/) and BoxCar2D, but built from scratch with a modern stack and a wow-effect minimalist look.

## Status

Week 0 — foundation. The shell renders, i18n works, but nothing evolves yet.

## Stack

- **TypeScript** strict, **Vite** dev server, **PixiJS v8** renderer
- **Rapier2D** physics (WASM) — wired in week 1
- **Web Worker** for the simulation loop
- **nanostores** for UI state
- **Cloudflare Workers + KV** for the global daily-challenge leaderboard
- **Vitest** for unit tests, **ESLint** + **Prettier** for hygiene

## Layout

```
apps/
  web/        — frontend (Vite + PixiJS)
  server/     — Cloudflare Worker (leaderboard API)
packages/
  shared/     — wire-format types shared between client and server
```

## Develop

```sh
npm install
npm run dev          # web app at http://localhost:5173
npm run dev --workspace=@dnacars/server   # API at http://localhost:8787
```

```sh
npm run typecheck    # all workspaces
npm run lint
npm run test
npm run build
```

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) — the living plan with current status,
done items, and what's next. Updated on every meaningful release.

## License

MIT — see `LICENSE`.
