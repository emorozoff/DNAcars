/**
 * Pixi rendering for the physics demo.
 *
 * Visual rules:
 *   - Track is a thin grey polyline.
 *   - Each car is drawn as its real chassis polygon + wheel circles.
 *   - A wheel currently in ground contact tints green.  This is the
 *     single most useful debug signal: it tells you at a glance which
 *     cars are actually getting traction.
 *   - There is no "crashed" colour — bad shapes simply don't move,
 *     which is the visible signal we care about.
 *   - The camera follows the furthest-along car.
 */

import { Application, Container, Graphics } from 'pixi.js';
import { TUNING, type CarSnapshot, type WorldSnapshot } from '../sim/world';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const ZOOM = 50;
const CAMERA_LERP = 0.08;

const COLORS = {
  bg: 0x0e0e10,
  track: 0x4a4a55,
  trackTick: 0x2a2a32,
  body: 0xe6e6e9,
  wheel: 0x8b8b94,
  wheelGround: 0xa8ff60,
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
    // Camera prefers the furthest *still-running* car so it doesn't park
    // on a finished leader while the rest of the population is still
    // moving along behind it.  Falls back to the furthest finished car
    // if no one is still running (end of generation).
    let runningLead: CarSnapshot | null = null;
    let anyLead: CarSnapshot | null = null;

    for (const car of snap.cars) {
      seen.add(car.index);
      let view = carViews.get(car.index);
      if (!view) {
        view = makeCarView(car);
        carsLayer.addChild(view.container);
        carViews.set(car.index, view);
      }
      updateCarView(view, car);
      if (!anyLead || car.position.x > anyLead.position.x) anyLead = car;
      if (!car.finished && (!runningLead || car.position.x > runningLead.position.x)) {
        runningLead = car;
      }
    }

    for (const [k, v] of carViews) {
      if (!seen.has(k)) {
        carsLayer.removeChild(v.container);
        v.container.destroy({ children: true });
        carViews.delete(k);
      }
    }

    const followed = runningLead ?? anyLead;
    if (followed) cameraTarget = { x: followed.position.x, y: followed.position.y };
  }

  return {
    setTrack(points): void {
      trackPoints = points;
      drawTrack();
      // Drop every cached per-car view.  Views are keyed by car index
      // (0..N-1), and a new session reuses the same indices for a
      // fresh batch of genomes with different chassis polygons and
      // wheels.  Without this wipe, the rendered shape stays pinned
      // to the FIRST session's genomes while the physics moves the
      // SECOND session's shapes — and the result looks exactly like
      // "the physics is broken on every restart but the first".
      for (const v of carViews.values()) {
        carsLayer.removeChild(v.container);
        v.container.destroy({ children: true });
      }
      carViews.clear();
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
    // Stroke thickness is the *visible* signal of a wheel's `power` gene
    // — thin = weak/light, thick = strong/heavy.  Player can read a
    // wheel's power off its line weight without any extra UI.
    const stroke = lerp(TUNING.wheel.minStroke, TUNING.wheel.maxStroke, w.power);
    g.circle(0, 0, w.radius);
    // White stroke so the per-frame tint (grey / green) renders at full
    // saturation.  A grey stroke would multiply colours down to mud.
    g.stroke({ color: 0xffffff, width: stroke });
    // Spoke from hub to rim — a touch thinner than the rim so the orientation
    // reads at a glance.
    g.moveTo(0, 0).lineTo(w.radius, 0);
    g.stroke({ color: 0xffffff, width: stroke * 0.7 });
    g.tint = COLORS.wheel;
    wheels.push(g);
    container.addChild(g);
  }
  return { container, body, wheels };
}

function updateCarView(view: CarView, car: CarSnapshot): void {
  view.container.position.set(car.position.x, car.position.y);
  view.container.rotation = car.angle;
  // Finished cars dim out so the eye is drawn to whoever is still
  // running.  Their position is frozen in world.ts anyway.
  view.container.alpha = car.finished ? 0.3 : 1;

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
    wg.tint = ws.onGround && !car.finished ? COLORS.wheelGround : COLORS.wheel;
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
