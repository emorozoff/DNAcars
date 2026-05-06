/**
 * Pixi rendering for the physics demo.
 *
 * Visual rules — chosen to make the physics legible:
 *   - Track is a thin grey polyline.
 *   - Each car is drawn as its real chassis polygon + wheel circles.
 *   - A wheel that's currently in ground contact lights up green.  This is
 *     the single most useful debug signal: it shows at a glance whether the
 *     motor is doing anything.
 *   - A crashed car turns dim red and stops being highlighted.
 *   - The camera follows whichever uncrashed car is furthest along.
 */

import { Application, Container, Graphics } from 'pixi.js';
import type { CarSnapshot, WorldSnapshot } from './physics';

const ZOOM = 50;
const CAMERA_LERP = 0.08;

const COLORS = {
  bg: 0x0e0e10,
  track: 0x4a4a55,
  trackTick: 0x2a2a32,
  body: 0xe6e6e9,
  bodyDim: 0x55555c,
  wheel: 0x8b8b94,
  wheelGround: 0xa8ff60,
  crashed: 0xff5d5d,
  accent: 0xa8ff60,
} as const;

export type SceneHandle = {
  setTrack(points: { x: number; y: number }[]): void;
  setSnapshot(s: WorldSnapshot): void;
  destroy(): void;
};

export async function mountScene(host: HTMLElement): Promise<SceneHandle> {
  const app = new Application();
  await app.init({
    background: COLORS.bg,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    resizeTo: host,
  });
  host.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  const trackGfx = new Graphics();
  world.addChild(trackGfx);

  const carsLayer = new Container();
  world.addChild(carsLayer);

  let trackPoints: { x: number; y: number }[] | null = null;
  const carViews = new Map<number, CarView>();

  const camera = { x: 0, y: 0 };
  let cameraTarget = { x: 0, y: 0 };

  applyTransform();
  const ro = new ResizeObserver(() => {
    drawTrack();
    applyTransform();
  });
  ro.observe(host);

  app.ticker.add(() => {
    camera.x += (cameraTarget.x - camera.x) * CAMERA_LERP;
    camera.y += (cameraTarget.y - camera.y) * CAMERA_LERP;
    applyTransform();
  });

  function applyTransform(): void {
    const w = app.renderer.width / (window.devicePixelRatio || 1);
    const h = app.renderer.height / (window.devicePixelRatio || 1);
    world.position.set(w / 2 - camera.x * ZOOM, h * 0.6 + camera.y * ZOOM);
    world.scale.set(ZOOM, -ZOOM);
  }

  function drawTrack(): void {
    if (!trackPoints || trackPoints.length < 2) return;
    trackGfx.clear();

    // Distance ticks every 25 m for scale.
    const last = trackPoints[trackPoints.length - 1]!;
    for (let x = 0; x <= last.x; x += 25) {
      const y = sampleTrackY(trackPoints, x);
      trackGfx.circle(x, y, 0.1).fill({ color: COLORS.trackTick, alpha: 0.6 });
    }

    trackGfx.moveTo(trackPoints[0]!.x, trackPoints[0]!.y);
    for (let i = 1; i < trackPoints.length; i++) {
      const p = trackPoints[i]!;
      trackGfx.lineTo(p.x, p.y);
    }
    trackGfx.stroke({ color: COLORS.track, width: 0.08, alpha: 1 });
  }

  function setSnapshot(snap: WorldSnapshot): void {
    const seen = new Set<number>();
    let leader: CarSnapshot | null = null;
    let leaderAny: CarSnapshot | null = null;

    for (const car of snap.cars) {
      seen.add(car.index);
      let view = carViews.get(car.index);
      if (!view) {
        view = makeCarView(car);
        carsLayer.addChild(view.container);
        carViews.set(car.index, view);
      }
      updateCarView(view, car);

      if (!leaderAny || car.position.x > leaderAny.position.x) leaderAny = car;
      if (!car.crashed) {
        if (!leader || car.position.x > leader.position.x) leader = car;
      }
    }

    for (const [k, v] of carViews) {
      if (!seen.has(k)) {
        carsLayer.removeChild(v.container);
        v.container.destroy({ children: true });
        carViews.delete(k);
      }
    }

    const followed = leader ?? leaderAny;
    if (followed) cameraTarget = { x: followed.position.x, y: followed.position.y };
  }

  return {
    setTrack(points): void {
      trackPoints = points;
      drawTrack();
      camera.x = points[0]?.x ?? 0;
      camera.y = points[0]?.y ?? 0;
      cameraTarget = { ...camera };
    },
    setSnapshot,
    destroy(): void {
      ro.disconnect();
      app.destroy(true, { children: true });
    },
  };
}

/* ─── Per-car view ─────────────────────────────────────────────────────── */

type CarView = {
  container: Container;
  body: Graphics;
  wheels: Graphics[];
  lastCrashed: boolean;
};

function makeCarView(car: CarSnapshot): CarView {
  const container = new Container();
  const body = new Graphics();
  body.poly(car.vertices.map((v) => ({ x: v.x, y: v.y })));
  body.stroke({ color: COLORS.body, width: 0.05 });
  container.addChild(body);

  const wheels: Graphics[] = [];
  for (const w of car.wheels) {
    const g = new Graphics();
    g.circle(0, 0, w.radius);
    // Stroke pure white so the per-frame tint (grey / green / red) shows
    // up at full saturation.  A grey base would multiply tint colours
    // down and "green" would render as a muddy olive.
    g.stroke({ color: 0xffffff, width: 0.05 });
    g.moveTo(0, 0).lineTo(w.radius, 0);
    g.stroke({ color: 0xffffff, width: 0.04 });
    g.tint = COLORS.wheel; // grey by default until updateCarView runs.
    wheels.push(g);
    container.addChild(g);
  }
  return { container, body, wheels, lastCrashed: false };
}

function updateCarView(view: CarView, car: CarSnapshot): void {
  view.container.position.set(car.position.x, car.position.y);
  view.container.rotation = car.angle;
  view.container.alpha = car.crashed ? 0.45 : 1;

  // Re-tint chassis on crash transition.
  if (car.crashed !== view.lastCrashed) {
    view.body.tint = car.crashed ? COLORS.crashed : COLORS.body;
    view.lastCrashed = car.crashed;
  }

  // Wheels: position in chassis-local frame so rotation handles itself,
  // and tint by ground-contact / crash state.
  const cos = Math.cos(-car.angle);
  const sin = Math.sin(-car.angle);
  for (let i = 0; i < view.wheels.length; i++) {
    const wg = view.wheels[i]!;
    const ws = car.wheels[i];
    if (!ws) continue;
    const dx = ws.position.x - car.position.x;
    const dy = ws.position.y - car.position.y;
    wg.position.set(dx * cos - dy * sin, dx * sin + dy * cos);
    wg.rotation = ws.angle - car.angle;
    if (car.crashed) wg.tint = COLORS.bodyDim;
    else if (ws.onGround) wg.tint = COLORS.wheelGround;
    else wg.tint = COLORS.wheel;
  }
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function sampleTrackY(points: { x: number; y: number }[], x: number): number {
  if (x <= 0) return points[0]?.y ?? 0;
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
