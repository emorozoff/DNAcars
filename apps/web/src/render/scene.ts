/**
 * Pixi rendering for the physics demo.
 *
 * Visual rules:
 *   - Two parallax silhouette layers behind the track (slow distant
 *     mountains + slightly faster near hills) give the scene depth
 *     without distracting from the cars.
 *   - Track is a thin grey polyline.
 *   - Each car is drawn as its real chassis polygon + wheel circles.
 *   - A wheel currently in ground contact tints green.  This is the
 *     single most useful debug signal: it tells you at a glance which
 *     cars are actually getting traction.
 *   - The currently-followed leader gets a soft pulsing ring around
 *     it so the eye never loses track of "who's in front".
 *   - The camera follows the furthest-along still-running car.
 */

import { Application, Container, Graphics } from 'pixi.js';
import { TUNING, type CarSnapshot, type WorldSnapshot } from '../sim/world';
import { mountMinimap, type MinimapHandle } from './minimap';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Pixels per world-metre.  Lowered 50 → 35 in v0.9.11 by user
 * request: at 50 the camera felt too tight and you couldn't see the
 * upcoming terrain or the rest of the population.  35 fits roughly
 * 40 m of track on a 1400 px screen — plenty of context.
 */
const ZOOM = 35;
const CAMERA_LERP = 0.08;

/** Parallax factors: 1.0 = pinned to camera (foreground), 0 = static. */
const PARALLAX_FAR = 0.25;
const PARALLAX_NEAR = 0.55;

const COLORS = {
  bg: 0x0e0e10,
  track: 0x4a4a55,
  trackTick: 0x2a2a32,
  bgFar: 0x14141a,
  bgNear: 0x1a1a22,
  body: 0xe6e6e9,
  wheel: 0x8b8b94,
  wheelGround: 0xa8ff60,
  highlight: 0xffd166,
} as const;

const HIGHLIGHT_MS = 1500;

export type CarClickHandler = (carIndex: number) => void;

export type SceneHandle = {
  setTrack(points: { x: number; y: number }[]): void;
  /**
   * Apply a new world snapshot.  Camera target + minimap always
   * update; the per-car Pixi rendering updates only when
   * `renderCars` is true (default).  Pass `renderCars: false` in
   * headless modes (×32 / skip-N-gens) so we save the per-frame
   * Pixi work but the minimap still moves.
   */
  setSnapshot(s: WorldSnapshot, opts?: { renderCars?: boolean }): void;
  /** Register (or clear) the callback fired when the user clicks a car. */
  onCarClick(handler: CarClickHandler | null): void;
  /**
   * Pin the minimap's red record marker at this world-x.  Pass null
   * to hide it (e.g. when the track changes every gen and "record on
   * this track" isn't meaningful).
   */
  setRecordPosition(worldX: number | null): void;
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

  // Parallax layers sit *under* the world container and have their own
  // camera transform with a lower parallax factor — so they appear to
  // scroll slower than the foreground.  Generated once per session
  // (rebuilt when setTrack runs) and never updated again.
  const bgFar = new Container();
  const bgNear = new Container();
  app.stage.addChild(bgFar);
  app.stage.addChild(bgNear);
  const bgFarGfx = new Graphics();
  const bgNearGfx = new Graphics();
  bgFar.addChild(bgFarGfx);
  bgNear.addChild(bgNearGfx);

  const world = new Container();
  app.stage.addChild(world);

  const trackGfx = new Graphics();
  world.addChild(trackGfx);

  const carsLayer = new Container();
  world.addChild(carsLayer);

  let trackPoints: { x: number; y: number }[] | null = null;
  const carViews = new Map<number, CarView>();
  let onCarClickHandler: CarClickHandler | null = null;
  /** Most recent record-marker world-x (null = hide marker). */
  let recordX: number | null = null;

  // Optional minimap: if the SVG element is in the DOM at mount-time,
  // wire it up so it gets updated alongside the main scene.
  const minimapEl = document.getElementById('minimap');
  const minimap: MinimapHandle | null =
    minimapEl instanceof SVGSVGElement ? mountMinimap(minimapEl) : null;

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
    // Foreground (cars + track) — full camera follow.
    world.position.set(w / 2 - camera.x * ZOOM, h * 0.6 + camera.y * ZOOM);
    world.scale.set(ZOOM, -ZOOM);
    // Parallax silhouettes — partial camera follow so they appear
    // farther away.  Each layer has its own ZOOM so the same world
    // coordinates produce different on-screen positions.
    bgFar.position.set(w / 2 - camera.x * PARALLAX_FAR * ZOOM, h * 0.62 + camera.y * 0.05 * ZOOM);
    bgFar.scale.set(ZOOM, -ZOOM);
    bgNear.position.set(w / 2 - camera.x * PARALLAX_NEAR * ZOOM, h * 0.62 + camera.y * 0.1 * ZOOM);
    bgNear.scale.set(ZOOM, -ZOOM);
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

    // Parallax layers: two silhouette ridges generated by procedural
    // sines.  We only need to redraw them when the track changes.
    drawParallaxLayer(bgFarGfx, last.x, 0.05, 1.6, 0.7, COLORS.bgFar);
    drawParallaxLayer(bgNearGfx, last.x, 0.09, 1.0, 0.4, COLORS.bgNear);
  }

  function setSnapshot(snap: WorldSnapshot, opts: { renderCars?: boolean } = {}): void {
    const renderCars = opts.renderCars !== false;

    // ── Always run, regardless of headless mode ────────────────────
    // Pick the leader (still-running preferred) for the camera target
    // and the minimap dot.  Cheap: one pass through snap.cars with no
    // Pixi side effects.
    let runningLead: CarSnapshot | null = null;
    let anyLead: CarSnapshot | null = null;
    for (const car of snap.cars) {
      if (!anyLead || car.position.x > anyLead.position.x) anyLead = car;
      if (!car.finished && (!runningLead || car.position.x > runningLead.position.x)) {
        runningLead = car;
      }
    }
    const followed = runningLead ?? anyLead;
    if (followed) cameraTarget = { x: followed.position.x, y: followed.position.y };

    // Minimap is SVG and ~30–50 attribute writes per call; cheap
    // enough that we keep updating it even when the main canvas is
    // hidden in ×32/skip mode.  The user can still see the population
    // crawling along the track up there.
    if (minimap) {
      const dpr = window.devicePixelRatio || 1;
      const viewportWorldWidth = app.renderer.width / dpr / ZOOM;
      minimap.update(snap, camera.x, viewportWorldWidth, recordX);
    }

    // ── Heavy work, skipped when canvas is hidden ──────────────────
    // updateCarView is the per-car Pixi position/rotation/tint write.
    // At 24 cars × N wheels per car this is the bulk of render cost.
    // In headless mode (×32, skip-N-gens) we just don't do it — the
    // canvas is already invisible, so nobody sees the stale views.
    if (!renderCars) return;

    const seen = new Set<number>();
    for (const car of snap.cars) {
      seen.add(car.index);
      let view = carViews.get(car.index);
      if (!view) {
        view = makeCarView(car, (idx) => onCarClickHandler?.(idx));
        carsLayer.addChild(view.container);
        carViews.set(car.index, view);
      }
      updateCarView(view, car);
    }

    for (const [k, v] of carViews) {
      if (!seen.has(k)) {
        carsLayer.removeChild(v.container);
        v.container.destroy({ children: true });
        carViews.delete(k);
      }
    }
  }

  return {
    setTrack(points): void {
      trackPoints = points;
      drawTrack();
      if (minimap) minimap.setTrack(points);
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
    onCarClick(handler): void {
      onCarClickHandler = handler;
    },
    setRecordPosition(x): void {
      recordX = x;
    },
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
  /** When > performance.now(), the chassis tints highlight-yellow (post-click). */
  highlightUntil: number;
};

function makeCarView(car: CarSnapshot, onClick: ((idx: number) => void) | null): CarView {
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

  const view: CarView = { container, body, wheels, highlightUntil: 0 };

  // Click on a car: flash chassis yellow for 1.5 s and fire the
  // external handler so the host can dump a debug bundle to the
  // clipboard.  The flash is the player's confirmation that *this*
  // is the car they meant.
  container.eventMode = 'static';
  container.cursor = 'pointer';
  container.on('pointerdown', () => {
    view.highlightUntil = performance.now() + HIGHLIGHT_MS;
    onClick?.(car.index);
  });

  return view;
}

function updateCarView(view: CarView, car: CarSnapshot): void {
  view.container.position.set(car.position.x, car.position.y);
  view.container.rotation = car.angle;
  // Finished cars dim out so the eye is drawn to whoever is still
  // running.  Their position is frozen in world.ts anyway.
  view.container.alpha = car.finished ? 0.3 : 1;

  // Brief post-click highlight: chassis tint goes yellow until the timer
  // expires, then snaps back to the default body colour.
  view.body.tint = performance.now() < view.highlightUntil ? COLORS.highlight : COLORS.body;

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

/**
 * Draws a procedural silhouette under the y=0 line: a low-frequency
 * sine-wave hill profile filled solid.  Used for the parallax layers.
 * `freq` is rad/m; `amp` is the hill height amplitude in metres;
 * `phase` shifts the profile so the two layers don't align perfectly.
 *
 * Extends `MARGIN` metres past both ends of the track so the polygon
 * always covers the visible viewport, even when the camera is parked
 * near x=0 (where parallax-shifted "screen-centre world x" can be
 * negative) or near the end of the track.  Without this margin a hard
 * vertical edge of the fill becomes visible mid-canvas — the "gray
 * rectangle" bug the user reported in v0.9.19.
 */
function drawParallaxLayer(
  g: Graphics,
  length: number,
  freq: number,
  amp: number,
  phase: number,
  color: number,
): void {
  g.clear();
  const STEP = 4;
  const MARGIN = 200;
  const x0 = -MARGIN;
  const x1 = length + MARGIN;
  const top: { x: number; y: number }[] = [];
  for (let x = x0; x <= x1; x += STEP) {
    top.push({ x, y: Math.sin(x * freq + phase) * amp });
  }
  const points = [...top, { x: x1, y: -50 }, { x: x0, y: -50 }];
  g.poly(points);
  g.fill({ color, alpha: 1 });
}
