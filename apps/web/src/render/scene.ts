/**
 * Scene controller — owns the Pixi application, world container, track and
 * cars graphics.  Consumes `WorldSnapshot`s from the simulation worker and
 * keeps the visual state in sync.
 *
 * Movement is *interpolated*: physics snapshots arrive at ~60 Hz but their
 * timing jitters (worker queues, GC, OS timers).  Naively snapping the
 * sprites to each snapshot causes a stuttery feel.  Instead we keep the
 * previous and current snapshot for each car and lerp between them on the
 * Pixi ticker, which gives perfectly smooth motion regardless of how
 * messages arrive.
 */

import { Application, Container, Graphics } from 'pixi.js';
import type { CarSnapshot, WorldSnapshot } from '../sim/world';

const DEFAULT_ZOOM = 60;
const CAMERA_LERP = 0.08;
/** Fallback if we don't have two snapshots yet to measure the real interval. */
const FALLBACK_SNAPSHOT_INTERVAL_MS = 1000 / 60;

export type SceneHandle = {
  setTrack(points: { x: number; y: number }[]): void;
  setSnapshot(snapshot: WorldSnapshot): void;
  destroy(): void;
};

export async function mountScene(host: HTMLElement): Promise<SceneHandle> {
  const app = new Application();
  const colors = readColors();

  await app.init({
    background: colors.bg,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    resizeTo: host,
  });
  host.appendChild(app.canvas);

  // World transform: meters → pixels.
  const world = new Container();
  app.stage.addChild(world);

  const trackGfx = new Graphics();
  world.addChild(trackGfx);

  const carsLayer = new Container();
  world.addChild(carsLayer);

  const zoom = DEFAULT_ZOOM;
  const camera = { x: 0, y: 0 };
  let cameraTarget = { x: 0, y: 0 };

  const carViews = new Map<number, CarView>();
  let trackPoints: { x: number; y: number }[] | null = null;

  // Two most recent snapshots — used for interpolation.
  let prevSnapshot: WorldSnapshot | null = null;
  let currSnapshot: WorldSnapshot | null = null;
  let prevPostedAt = 0;
  let currPostedAt = 0;

  applyTransform();

  const onResize = (): void => {
    drawTrack();
    applyTransform();
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(host);

  app.ticker.add(() => {
    if (currSnapshot) {
      const ageMs = performance.now() - currPostedAt;
      // Use the actual interval between the last two snapshots so jitter in
      // their delivery doesn't translate into jitter on screen.  Clamped to
      // [0, 1] — no extrapolation, the worst we do is hold the frame still
      // for one extra rAF if a snapshot is briefly late.
      const interval =
        prevPostedAt && currPostedAt > prevPostedAt
          ? currPostedAt - prevPostedAt
          : FALLBACK_SNAPSHOT_INTERVAL_MS;
      const alpha = clamp(ageMs / interval, 0, 1);
      renderInterpolated(prevSnapshot, currSnapshot, alpha);
    }
    camera.x += (cameraTarget.x - camera.x) * CAMERA_LERP;
    camera.y += (cameraTarget.y - camera.y) * CAMERA_LERP;
    applyTransform();
  });

  function applyTransform(): void {
    const w = app.renderer.width / (window.devicePixelRatio || 1);
    const h = app.renderer.height / (window.devicePixelRatio || 1);
    world.position.set(w / 2 - camera.x * zoom, h * 0.6 + camera.y * zoom);
    world.scale.set(zoom, -zoom);
  }

  function drawTrack(): void {
    if (!trackPoints || trackPoints.length < 2) return;
    trackGfx.clear();

    const last = trackPoints[trackPoints.length - 1]!;
    for (let x = 0; x <= last.x; x += 25) {
      const y = sampleTrackY(trackPoints, x);
      trackGfx.circle(x, y, 0.08).fill({ color: colors.fg, alpha: 0.25 });
    }

    trackGfx.moveTo(trackPoints[0]!.x, trackPoints[0]!.y);
    for (let i = 1; i < trackPoints.length; i++) {
      const p = trackPoints[i]!;
      trackGfx.lineTo(p.x, p.y);
    }
    trackGfx.stroke({ color: colors.track, width: 0.08, alpha: 1 });

    // Finish wall: 8m vertical, matches the physics collider on the same x.
    trackGfx
      .moveTo(last.x, last.y)
      .lineTo(last.x, last.y + 8)
      .stroke({ color: colors.accent, width: 0.08, alpha: 0.9 });
    trackGfx.circle(last.x, last.y + 8, 0.14).fill({ color: colors.accent, alpha: 0.9 });
  }

  function renderInterpolated(
    prev: WorldSnapshot | null,
    curr: WorldSnapshot,
    alpha: number,
  ): void {
    const seen = new Set<number>();
    const prevByIndex = new Map<number, CarSnapshot>();
    if (prev) for (const c of prev.cars) prevByIndex.set(c.index, c);

    // Camera target: prefer car index 0 if alive, otherwise the lowest-index
    // alive car, otherwise no change.
    const followedIndex = pickFollowedIndex(curr.cars);
    let followedX: number | null = null;
    let followedY: number | null = null;

    for (const car of curr.cars) {
      seen.add(car.index);
      let view = carViews.get(car.index);
      if (!view) {
        view = makeCarView(car, colors);
        carsLayer.addChild(view.container);
        carViews.set(car.index, view);
      }
      const prevCar = prevByIndex.get(car.index);
      // No interpolation for dead cars — they're frozen anyway.
      const a = car.alive && prevCar ? alpha : 1;
      const px = prevCar ? prevCar.position.x : car.position.x;
      const py = prevCar ? prevCar.position.y : car.position.y;
      const pAng = prevCar ? prevCar.angle : car.angle;
      const ix = lerp(px, car.position.x, a);
      const iy = lerp(py, car.position.y, a);
      const iAng = lerpAngle(pAng, car.angle, a);
      const isFollowed = car.index === followedIndex;
      updateCarView(view, car, prevCar, a, ix, iy, iAng, colors, isFollowed);

      if (isFollowed) {
        followedX = ix;
        followedY = iy;
      }
    }

    for (const [k, view] of carViews) {
      if (!seen.has(k)) {
        carsLayer.removeChild(view.container);
        view.container.destroy({ children: true });
        carViews.delete(k);
      }
    }

    if (followedX !== null && followedY !== null) {
      cameraTarget = { x: followedX, y: followedY };
    }
  }

  return {
    setTrack(points): void {
      trackPoints = points;
      drawTrack();
      camera.x = points[0]?.x ?? 0;
      camera.y = points[0]?.y ?? 0;
      cameraTarget = { ...camera };
    },
    setSnapshot(snapshot): void {
      prevSnapshot = currSnapshot;
      prevPostedAt = currPostedAt;
      currSnapshot = snapshot;
      currPostedAt = performance.now();
    },
    destroy(): void {
      ro.disconnect();
      app.destroy(true, { children: true });
    },
  };
}

/* ─── Per-car view ──────────────────────────────────────────────────────── */

type CarView = {
  container: Container;
  body: Graphics;
  wheels: Graphics[];
  recolored: boolean;
};

function makeCarView(car: CarSnapshot, colors: ReturnType<typeof readColors>): CarView {
  const container = new Container();
  const body = new Graphics();
  body.poly(car.vertices.map((v) => ({ x: v.x, y: v.y })));
  body.fill({ color: colors.bg, alpha: 0.0 });
  body.stroke({ color: colors.body, width: 0.05 });
  container.addChild(body);

  const wheels: Graphics[] = [];
  for (const w of car.wheels) {
    const g = new Graphics();
    g.circle(0, 0, w.radius);
    g.stroke({ color: colors.wheel, width: 0.045 });
    g.moveTo(0, 0).lineTo(w.radius, 0);
    g.stroke({ color: colors.wheel, width: 0.04 });
    wheels.push(g);
    container.addChild(g);
  }
  return { container, body, wheels, recolored: false };
}

function updateCarView(
  view: CarView,
  car: CarSnapshot,
  prevCar: CarSnapshot | undefined,
  alpha: number,
  ix: number,
  iy: number,
  iAng: number,
  colors: ReturnType<typeof readColors>,
  isFollowed: boolean,
): void {
  view.container.position.set(ix, iy);
  view.container.rotation = iAng;
  view.container.alpha = car.alive ? 1 : 0.25;

  for (let i = 0; i < view.wheels.length; i++) {
    const wg = view.wheels[i]!;
    const ws = car.wheels[i];
    if (!ws) continue;
    const wp = prevCar?.wheels[i];
    // Interpolate wheel world position, then express it in the chassis frame.
    const wx = wp ? lerp(wp.position.x, ws.position.x, alpha) : ws.position.x;
    const wy = wp ? lerp(wp.position.y, ws.position.y, alpha) : ws.position.y;
    const dx = wx - ix;
    const dy = wy - iy;
    const cos = Math.cos(-iAng);
    const sin = Math.sin(-iAng);
    wg.position.set(dx * cos - dy * sin, dx * sin + dy * cos);
    const wAng = wp ? lerpAngle(wp.angle, ws.angle, alpha) : ws.angle;
    wg.rotation = wAng - iAng;
  }

  if (!car.alive && !view.recolored) {
    view.body.tint = colors.dim;
    for (const w of view.wheels) w.tint = colors.dim;
    view.recolored = true;
  }

  // Highlight the followed car so the user knows which one the camera is on.
  const targetTint = isFollowed && car.alive ? colors.accent : colors.body;
  if (car.alive && view.body.tint !== targetTint) {
    view.body.tint = targetTint;
    for (const w of view.wheels) w.tint = targetTint;
  }
}

/* ─── Math helpers ──────────────────────────────────────────────────────── */

/**
 * Camera follows the leader: the alive car that has travelled the most.
 * When everyone is dead, falls back to the overall best-travelling car
 * so we still see the result of the round.
 */
function pickFollowedIndex(cars: CarSnapshot[]): number | null {
  let bestAlive: CarSnapshot | null = null;
  let bestAny: CarSnapshot | null = null;
  for (const c of cars) {
    if (!bestAny || c.travel > bestAny.travel) bestAny = c;
    if (c.alive && (!bestAlive || c.travel > bestAlive.travel)) bestAlive = c;
  }
  return (bestAlive ?? bestAny)?.index ?? null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Lerp through the shortest arc. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/* ─── Colors ────────────────────────────────────────────────────────────── */

function readColors(): {
  bg: number;
  track: number;
  body: number;
  wheel: number;
  accent: number;
  dim: number;
  fg: number;
} {
  const css = (name: string, fallback: number): number => parseColor(getCssVar(name)) ?? fallback;
  return {
    bg: css('--color-bg', 0x0e0e10),
    track: css('--color-track', 0x4a4a55),
    body: css('--color-car-body', 0xe6e6e9),
    wheel: css('--color-car-wheel', 0x8b8b94),
    accent: css('--color-accent', 0xa8ff60),
    dim: css('--color-fg-dim', 0x5a5a63),
    fg: css('--color-fg', 0xe6e6e9),
  };
}

function sampleTrackY(points: { x: number; y: number }[], x: number): number {
  if (x <= 0) return 0;
  const last = points[points.length - 1]!;
  if (x >= last.x) return last.y;
  const step = points.length > 1 ? points[1]!.x - points[0]!.x : 1;
  const i = Math.floor(x / step);
  const a = points[i];
  const b = points[i + 1];
  if (!a) return 0;
  if (!b) return a.y;
  const t = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

function getCssVar(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function parseColor(input: string): number | null {
  if (!input || !input.startsWith('#')) return null;
  const hex = input.slice(1);
  if (hex.length === 3) {
    const c0 = hex[0] ?? '0';
    const c1 = hex[1] ?? '0';
    const c2 = hex[2] ?? '0';
    return (parseInt(c0 + c0, 16) << 16) | (parseInt(c1 + c1, 16) << 8) | parseInt(c2 + c2, 16);
  }
  if (hex.length === 6) return parseInt(hex, 16);
  return null;
}

export { DEFAULT_ZOOM };
