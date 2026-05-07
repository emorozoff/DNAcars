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
import { TUNING, type CarSnapshot, type PhysicalObstacle, type WorldSnapshot } from '../sim/world';
import { mountMinimap, type MinimapHandle } from './minimap';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Pixels per world-metre.  Used to be a const; now mutable so the
 * mouse-wheel zoom can adjust it.  35 is the comfortable default
 * (≈40 m of track visible on a 1400 px screen).  Clamped at every
 * adjustment to ZOOM_MIN..ZOOM_MAX so the UI never goes degenerate.
 */
const ZOOM_DEFAULT = 35;
const ZOOM_MIN = 12;
const ZOOM_MAX = 90;
const ZOOM_WHEEL_FACTOR = 1.12;
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
  /** Walls + ceilings — same red palette as the record marker for "hazard". */
  obstacle: 0xd05d5d,
} as const;

const HIGHLIGHT_MS = 1500;

export type CarClickHandler = (carIndex: number) => void;

/**
 * What the camera is currently locked onto.
 *
 *   leader  default — the running leader, falling back to whatever
 *           car is furthest along if everyone has finished.
 *   car     a specific car index (set by clicking its minimap dot).
 *           Falls back to leader when that index isn't in the
 *           snapshot any more (e.g. after a population restart).
 *   free    manual mode — a fixed world-x picked by the user via
 *           minimap drag.  Camera doesn't track anything; user
 *           can drag again to re-position or hit "back to leader".
 */
export type CameraMode = { type: 'leader' } | { type: 'car'; idx: number } | { type: 'free' };

export type CameraInfo = {
  mode: CameraMode;
  /** True when the user has taken control away from leader-follow. */
  manual: boolean;
};

export type CameraChangeHandler = (info: CameraInfo) => void;

export type SceneHandle = {
  setTrack(
    points: { x: number; y: number }[],
    physicalObstacles?: readonly PhysicalObstacle[],
  ): void;
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
   * Pass an array of world-x values for the recent record-setting
   * positions on the current track, oldest → newest.  The minimap
   * draws each as a vertical line; the newest at full opacity, older
   * ones progressively dimmer.  Pass an empty array to hide every
   * line — used when the track changes per gen and "record on this
   * track" isn't meaningful.
   */
  setRecordHistory(worldXs: number[]): void;
  /** Switch the camera back to "follow the running leader". */
  followLeader(): void;
  /** Switch the camera to follow the car with the given snapshot index. */
  followCar(idx: number): void;
  /**
   * Manual mode: park the camera at this world-x and stop tracking
   * anything.  Camera lerps there and stays.  Used by the minimap
   * drag handler.
   */
  setCameraX(worldX: number): void;
  /** Multiply the current zoom by `factor`, clamped to ZOOM_MIN..ZOOM_MAX. */
  zoomBy(factor: number): void;
  /** Subscribe to camera-mode changes (so the host can update UI). */
  onCameraChange(handler: CameraChangeHandler | null): void;
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

  // Discrete obstacles (walls, ceilings) draw on a separate layer
  // above the track polyline so the red strokes read clearly
  // against the grey surface.
  const obstaclesGfx = new Graphics();
  world.addChild(obstaclesGfx);

  const carsLayer = new Container();
  world.addChild(carsLayer);

  let trackPoints: { x: number; y: number }[] | null = null;
  let trackPhysicalObstacles: readonly PhysicalObstacle[] = [];
  const carViews = new Map<number, CarView>();
  let onCarClickHandler: CarClickHandler | null = null;
  /**
   * World-x values of the recent record-setting positions on the
   * current track, oldest → newest.  Passed to the minimap on every
   * frame so the cluster of vertical record lines stays in sync with
   * whatever record-history main.ts is maintaining.
   */
  let recordHistory: number[] = [];

  // Optional minimap: if the SVG element is in the DOM at mount-time,
  // wire it up so it gets updated alongside the main scene.
  const minimapEl = document.getElementById('minimap');
  const minimap: MinimapHandle | null =
    minimapEl instanceof SVGSVGElement ? mountMinimap(minimapEl) : null;

  let zoom = ZOOM_DEFAULT;
  const camera = { x: 0, y: 0 };
  let cameraTarget = { x: 0, y: 0 };
  let cameraMode: CameraMode = { type: 'leader' };
  /** Sticky world-x for free-camera mode.  Updated each minimap drag. */
  let freeCameraX = 0;
  let cameraChangeHandler: CameraChangeHandler | null = null;
  function emitCameraChange(): void {
    cameraChangeHandler?.({ mode: cameraMode, manual: cameraMode.type !== 'leader' });
  }

  // Wire minimap interactions (only when a minimap actually mounted).
  if (minimap) {
    minimap.onJump((worldX) => {
      cameraMode = { type: 'free' };
      freeCameraX = worldX;
      cameraTarget = { x: worldX, y: cameraTarget.y };
      emitCameraChange();
    });
    minimap.onCarSelect((idx) => {
      cameraMode = { type: 'car', idx };
      emitCameraChange();
    });
  }

  // Mouse-wheel zoom on the main canvas.  Wheel-up zooms in (more
  // pixels per metre), wheel-down zooms out.  preventDefault to
  // suppress the browser's default page scroll on top of the
  // canvas.  applyTransform reads `zoom` directly so the next RAF
  // tick picks up the new value.
  host.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
    },
    { passive: false },
  );

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
    world.position.set(w / 2 - camera.x * zoom, h * 0.6 + camera.y * zoom);
    world.scale.set(zoom, -zoom);
    // Parallax silhouettes — partial camera follow so they appear
    // farther away.  Each layer has its own ZOOM so the same world
    // coordinates produce different on-screen positions.
    bgFar.position.set(w / 2 - camera.x * PARALLAX_FAR * zoom, h * 0.62 + camera.y * 0.05 * zoom);
    bgFar.scale.set(zoom, -zoom);
    bgNear.position.set(w / 2 - camera.x * PARALLAX_NEAR * zoom, h * 0.62 + camera.y * 0.1 * zoom);
    bgNear.scale.set(zoom, -zoom);
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

    // Discrete obstacles — walls (vertical posts) and ceilings
    // (horizontal beams).  Both drawn as filled rectangles in the
    // hazard-red colour so the player sees them at a glance,
    // matched to the actual collider geometry built in
    // buildTrackColliders.
    obstaclesGfx.clear();
    for (const ob of trackPhysicalObstacles) {
      if (ob.kind === 'wall') {
        const surfaceY = sampleTrackY(trackPoints, ob.x);
        // 10 cm wide, full configured height, sitting on the surface.
        obstaclesGfx.rect(ob.x - 0.05, surfaceY, 0.1, ob.height);
        obstaclesGfx.fill({ color: COLORS.obstacle, alpha: 0.95 });
      } else {
        // Ceiling: filled rectangle from the underside-y down by
        // 16 cm, centred at xCenter.
        obstaclesGfx.rect(ob.xCenter - ob.halfWidth, ob.y - 0.08, ob.halfWidth * 2, 0.16);
        obstaclesGfx.fill({ color: COLORS.obstacle, alpha: 0.95 });
      }
    }

    // Parallax layers: two silhouette ridges generated by procedural
    // sines.  We only need to redraw them when the track changes.
    drawParallaxLayer(bgFarGfx, last.x, 0.05, 1.6, 0.7, COLORS.bgFar);
    drawParallaxLayer(bgNearGfx, last.x, 0.09, 1.0, 0.4, COLORS.bgNear);
  }

  function setSnapshot(snap: WorldSnapshot, opts: { renderCars?: boolean } = {}): void {
    const renderCars = opts.renderCars !== false;

    // ── Always run, regardless of headless mode ────────────────────
    // Pick the leader (still-running preferred) and look up the
    // explicitly-followed car (if any) in a single pass.  Cheap:
    // O(N) with no Pixi side effects.
    let runningLead: CarSnapshot | null = null;
    let anyLead: CarSnapshot | null = null;
    let pickedCar: CarSnapshot | null = null;
    const followedIdx = cameraMode.type === 'car' ? cameraMode.idx : -1;
    for (const car of snap.cars) {
      if (!anyLead || car.position.x > anyLead.position.x) anyLead = car;
      if (!car.finished && (!runningLead || car.position.x > runningLead.position.x)) {
        runningLead = car;
      }
      if (car.index === followedIdx) pickedCar = car;
    }

    // Resolve the actual camera target based on mode.  `free` mode
    // parks at freeCameraX (no per-frame update); `car` falls back
    // to leader if the picked car isn't in the snapshot any more.
    if (cameraMode.type === 'free') {
      cameraTarget = { x: freeCameraX, y: cameraTarget.y };
    } else if (cameraMode.type === 'car' && pickedCar) {
      cameraTarget = { x: pickedCar.position.x, y: pickedCar.position.y };
    } else {
      const leader = runningLead ?? anyLead;
      if (leader) cameraTarget = { x: leader.position.x, y: leader.position.y };
    }

    // Minimap is SVG and ~30–50 attribute writes per call; cheap
    // enough that we keep updating it even when the main canvas is
    // hidden in ×32/skip mode.  The user can still see the population
    // crawling along the track up there.
    if (minimap) {
      const dpr = window.devicePixelRatio || 1;
      const viewportWorldWidth = app.renderer.width / dpr / zoom;
      minimap.update(snap, camera.x, viewportWorldWidth, recordHistory);
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
    setTrack(points, physicalObstacles): void {
      trackPoints = points;
      trackPhysicalObstacles = physicalObstacles ?? [];
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
      // Each new generation resets the camera to leader-follow.  The
      // user can manually re-pick a car or free-cam position right
      // after.  Sticky-across-restarts behaviour gets confusing —
      // the same `idx` selects a wholly different genome on the
      // next gen, so following car #5 across gens means jumping to
      // a stranger.  Better to default back to "watch the action".
      if (cameraMode.type !== 'leader') {
        cameraMode = { type: 'leader' };
        emitCameraChange();
      }
    },
    setSnapshot,
    onCarClick(handler): void {
      onCarClickHandler = handler;
    },
    setRecordHistory(worldXs): void {
      recordHistory = worldXs;
    },
    followLeader(): void {
      cameraMode = { type: 'leader' };
      emitCameraChange();
    },
    followCar(idx): void {
      cameraMode = { type: 'car', idx };
      emitCameraChange();
    },
    setCameraX(worldX): void {
      cameraMode = { type: 'free' };
      freeCameraX = worldX;
      cameraTarget = { x: worldX, y: cameraTarget.y };
      emitCameraChange();
    },
    zoomBy(factor): void {
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
    },
    onCameraChange(handler): void {
      cameraChangeHandler = handler;
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
