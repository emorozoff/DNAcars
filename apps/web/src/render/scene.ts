/**
 * Scene controller — owns the Pixi application, world container, track and
 * cars graphics.  Consumes `WorldSnapshot`s from the simulation worker and
 * keeps the visual state in sync.
 */

import { Application, Container, Graphics } from 'pixi.js';
import type { CarSnapshot, WorldSnapshot } from '../sim/world';

const DEFAULT_ZOOM = 60;
const CAMERA_LERP = 0.08;

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

  applyTransform();

  const onResize = (): void => {
    drawTrack();
    applyTransform();
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(host);

  // Smooth camera & re-apply transform every frame.
  app.ticker.add(() => {
    camera.x += (cameraTarget.x - camera.x) * CAMERA_LERP;
    camera.y += (cameraTarget.y - camera.y) * CAMERA_LERP;
    applyTransform();
  });

  function applyTransform(): void {
    const w = app.renderer.width / (window.devicePixelRatio || 1);
    const h = app.renderer.height / (window.devicePixelRatio || 1);
    // Center the camera horizontally, place it ~60% down the screen.
    world.position.set(w / 2 - camera.x * zoom, h * 0.6 + camera.y * zoom);
    world.scale.set(zoom, -zoom);
  }

  function drawTrack(): void {
    if (!trackPoints || trackPoints.length < 2) return;
    trackGfx.clear();
    trackGfx.moveTo(trackPoints[0]!.x, trackPoints[0]!.y);
    for (let i = 1; i < trackPoints.length; i++) {
      const p = trackPoints[i]!;
      trackGfx.lineTo(p.x, p.y);
    }
    trackGfx.stroke({ color: colors.track, width: 0.05, alpha: 1 });

    // A subtle horizon line below the track to give a hint of depth.
    trackGfx.moveTo(trackPoints[0]!.x, trackPoints[0]!.y - 100);
    trackGfx.lineTo(trackPoints[trackPoints.length - 1]!.x, 0);
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
      // Add / update views for each car.
      const seen = new Set<number>();
      for (const car of snapshot.cars) {
        seen.add(car.index);
        let view = carViews.get(car.index);
        if (!view) {
          view = makeCarView(car, colors);
          carsLayer.addChild(view.container);
          carViews.set(car.index, view);
        }
        updateCarView(view, car, colors);
      }
      // Drop views for cars that disappeared (e.g. world reset).
      for (const [k, view] of carViews) {
        if (!seen.has(k)) {
          carsLayer.removeChild(view.container);
          view.container.destroy({ children: true });
          carViews.delete(k);
        }
      }
      // Camera follows the leader (max x among alive cars).
      const leader = pickLeader(snapshot.cars);
      if (leader) {
        cameraTarget = { x: leader.position.x, y: leader.position.y };
      }
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
};

function makeCarView(car: CarSnapshot, colors: ReturnType<typeof readColors>): CarView {
  const container = new Container();
  const body = new Graphics();
  body.poly(car.vertices.map((v) => ({ x: v.x, y: v.y })));
  body.fill({ color: colors.bg, alpha: 0.0 }); // transparent fill, outlined body
  body.stroke({ color: colors.body, width: 0.05 });
  container.addChild(body);

  const wheels: Graphics[] = [];
  for (const w of car.wheels) {
    const g = new Graphics();
    g.circle(0, 0, w.radius);
    g.stroke({ color: colors.wheel, width: 0.045 });
    // Spoke for visible rotation.
    g.moveTo(0, 0).lineTo(w.radius, 0);
    g.stroke({ color: colors.wheel, width: 0.04 });
    wheels.push(g);
    container.addChild(g);
  }
  return { container, body, wheels };
}

function updateCarView(
  view: CarView,
  car: CarSnapshot,
  colors: ReturnType<typeof readColors>,
): void {
  view.container.position.set(car.position.x, car.position.y);
  view.container.rotation = car.angle;
  view.container.alpha = car.alive ? 1 : 0.25;

  for (let i = 0; i < view.wheels.length; i++) {
    const wg = view.wheels[i]!;
    const ws = car.wheels[i];
    if (!ws) continue;
    // Wheels live in world space, not in the chassis frame, so undo the
    // chassis transform: position relative to chassis, then rotate by
    // -car.angle to express the wheel's world position in the chassis's
    // local frame (since the chassis container itself rotates by car.angle).
    const dx = ws.position.x - car.position.x;
    const dy = ws.position.y - car.position.y;
    const cos = Math.cos(-car.angle);
    const sin = Math.sin(-car.angle);
    wg.position.set(dx * cos - dy * sin, dx * sin + dy * cos);
    wg.rotation = ws.angle - car.angle;
  }
  // Recolor on death just for clarity (one pass).
  if (!car.alive && view.body.tint !== colors.dim) {
    view.body.tint = colors.dim;
    for (const w of view.wheels) w.tint = colors.dim;
  }
}

function pickLeader(cars: CarSnapshot[]): CarSnapshot | null {
  let best: CarSnapshot | null = null;
  for (const c of cars) {
    if (!c.alive) continue;
    if (!best || c.travel > best.travel) best = c;
  }
  return best ?? cars[0] ?? null;
}

/* ─── Colors ────────────────────────────────────────────────────────────── */

function readColors(): {
  bg: number;
  track: number;
  body: number;
  wheel: number;
  accent: number;
  dim: number;
} {
  const css = (name: string, fallback: number): number => parseColor(getCssVar(name)) ?? fallback;
  return {
    bg: css('--color-bg', 0x0e0e10),
    track: css('--color-track', 0x2a2a31),
    body: css('--color-car-body', 0xe6e6e9),
    wheel: css('--color-car-wheel', 0x8b8b94),
    accent: css('--color-accent', 0xa8ff60),
    dim: css('--color-fg-dim', 0x5a5a63),
  };
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
