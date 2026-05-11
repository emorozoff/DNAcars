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
/**
 * Zoom-per-wheel-tick multiplier.  1.04 means each notch changes the
 * pixels-per-metre by 4 % — gentle enough that holding the wheel for
 * a second still lands you near the desired scale instead of
 * jump-cutting past it.  Bumped from 1.12 in v1.27 by player
 * request: 12 % per tick was zooming clear past the leader on a
 * single notch.
 */
const ZOOM_WHEEL_FACTOR = 1.04;
const CAMERA_LERP = 0.08;
/**
 * After the user takes manual control of the camera (drag on the
 * main canvas, click on a car-dot, etc.) the camera waits this
 * many real-time milliseconds of *no further interaction* before
 * snapping back to the running leader.  10 s feels long enough
 * to inspect a specific spot without having to keep nudging the
 * mouse to hold position.
 */
const CAMERA_IDLE_RETURN_MS = 10_000;

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
  /** Chassis tint for cars that have crossed the finish line —
   *  same accent green as the leader marker / "wheel on ground"
   *  swatch so finishers visually pair with the rest of the
   *  positive-feedback palette. */
  finisher: 0xa8ff60,
  /** Chassis tint for the current real-time leader when that
   *  leader IS an elite carryover from prev gen — "old champion
   *  still on top".  Same accent green as the wheel-on-ground
   *  swatch / finish flash. */
  leaderElite: 0xa8ff60,
  /** Chassis tint for the current real-time leader when it's NOT
   *  an elite — i.e. a mutated child or random gen-0 car has
   *  overtaken the inherited champions.  Warm red-orange to read
   *  as "fresh blood in front". */
  leaderNewcomer: 0xe8845a,
  /** Walls + ceilings — hazard red, matches the record marker. */
  obstacle: 0xd05d5d,
  /** Slick patch — light blue, "ice-like".  Drawn over the track polyline. */
  slick: 0x7ec8ff,
  /** Dashed finish-line stroke — soft white that reads against the
   *  dark canvas without overpowering the cars + track. */
  finishLight: 0xf2f2f5,
} as const;

/**
 * How much rendering work to do per frame.  Mapped from the host's
 * speed setting in main.ts: ×1 → 'full', ×8 → 'lite', ×32 → 'none'.
 */
export type RenderTier = 'full' | 'lite' | 'none';

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
    finishLineX?: number,
  ): void;
  /**
   * Apply a new world snapshot.
   *
   * `tier` controls how much per-car work the renderer does:
   *
   *   'full' (×1) — full quality.  Wheel-on-ground green tint
   *                  and full spoke detail.  All tier-specific
   *                  effects are gated here to avoid wasted work
   *                  at higher speeds.
   *   'lite' (×8) — minimal.  No wheel tint, no spoke updates.
   *                  Cars zooming at 8× real-time blur into
   *                  colour anyway; skipping these per-frame
   *                  attribute writes is 60 cars × 4 wheels ×
   *                  ~3 properties = ~720 writes saved.
   *   'none' (×32) — headless.  Camera + minimap still update;
   *                   no per-car Pixi work at all.
   */
  setSnapshot(
    s: WorldSnapshot,
    opts?: {
      tier?: RenderTier;
      headless?: boolean;
      /**
       * When true, only the running leader is drawn; every other car
       * gets `container.visible = false` so the player can watch the
       * champion driving the track on its own.  Physics still
       * simulates the whole population in the background.
       */
      showOnlyLeader?: boolean;
    },
  ): void;
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
  /**
   * Subscribe to "user clicked on a car".  Handler receives the
   * clicked car's snapshot index — host typically builds a debug
   * bundle (genome + timeline + seed + gen) and copies it to the
   * clipboard.  Pass `null` to clear.
   */
  onCarPick(handler: ((carIdx: number) => void) | null): void;
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
  // Cap the Pixi-side ticker (camera lerp + applyTransform) at 60 fps
  // even on 120 Hz / ProMotion displays.  The host's main physics
  // tick is wallclock-based so cadence is unaffected; this only
  // limits how often the camera-smoothing ticker fires its callback.
  app.ticker.maxFPS = 60;
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
  let trackFinishLineX: number | null = null;
  const carViews = new Map<number, CarView>();
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
  /**
   * Most recent leader index seen across setSnapshot calls.  When
   * it changes — i.e. some car overtook the previous leader by even
   * 1 cm — we kick the new leader's CarView into the same brief
   * celebrate animation used at finish-line crossing, so the
   * transition gets a visible ping (scale-pop + green tint).
   */
  let lastLeaderIdx: number | null = null;
  /** Sticky world-x for free-camera mode.  Updated each minimap drag. */
  let freeCameraX = 0;
  let cameraChangeHandler: CameraChangeHandler | null = null;
  function emitCameraChange(): void {
    cameraChangeHandler?.({ mode: cameraMode, manual: cameraMode.type !== 'leader' });
  }

  /**
   * Real-time clock at the moment the user last did anything that
   * counts as "manual camera input" (drag on the main canvas,
   * click on a car-dot, etc.).  Used by the idle-return timer in
   * the ticker: once `now - lastManualInputAt` exceeds
   * CAMERA_IDLE_RETURN_MS, we snap the camera mode back to leader.
   */
  let lastManualInputAt = 0;
  function markManualInput(): void {
    lastManualInputAt = performance.now();
  }

  // Cached most-recent world snapshot — populated by setSnapshot and
  // read by the canvas-click hit-test below.  Lets a click on the
  // main canvas pick out which car the user tapped without the host
  // having to plumb a snapshot back through.
  let lastSnap: WorldSnapshot | null = null;
  let carPickHandler: ((carIdx: number) => void) | null = null;

  // Wire minimap interactions (only when a minimap actually mounted).
  // Minimap drag and car-dot picks are still supported alongside the
  // new main-canvas drag — they all count as "manual input" and
  // share the same idle-return timer.
  if (minimap) {
    minimap.onJump((worldX) => {
      cameraMode = { type: 'free' };
      freeCameraX = worldX;
      cameraTarget = { x: worldX, y: cameraTarget.y };
      markManualInput();
      emitCameraChange();
    });
  }

  // Drag on the main canvas → free-camera mode.  Two simultaneous
  // pointers → pinch-zoom (so iPhone players have a way to zoom
  // without a mouse wheel).  Mechanics:
  //
  //   single pointer:  the existing 1-finger drag, untouched.
  //   two pointers:    first pinch sample latches the initial
  //                    distance + zoom; subsequent moves scale
  //                    `zoom` by the current/initial-distance
  //                    ratio, clamped to ZOOM_MIN..ZOOM_MAX.
  //                    A pinch *suppresses* drag for the duration
  //                    so the camera doesn't lurch sideways while
  //                    the fingers are converging.
  //
  // `activePointers` keys by pointerId so a finger lifting mid-pinch
  // gracefully reverts to a single-pointer drag at whatever its
  // remaining position is.
  const DRAG_THRESHOLD_PX = 4;
  let primed = false;
  let dragging = false;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragLastClientX = 0;
  type Pt = { x: number; y: number };
  const activePointers = new Map<number, Pt>();
  let pinchStartDistance = 0;
  let pinchStartZoom = ZOOM_DEFAULT;
  function pinchActive(): boolean {
    return activePointers.size >= 2;
  }
  function currentPinchDistance(): number {
    if (activePointers.size < 2) return 0;
    const [a, b] = [...activePointers.values()];
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  }
  host.addEventListener('pointerdown', (e) => {
    // Only the primary button (left mouse / first finger) drives
    // the camera — leave middle/right click for browser defaults.
    if (e.button !== 0) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2) {
      // Second finger landed — open a pinch gesture.  Cancel any
      // in-flight 1-finger drag state so the camera stops sliding
      // while the user zooms.
      primed = false;
      dragging = false;
      host.classList.remove('stage__canvas--dragging');
      pinchStartDistance = currentPinchDistance();
      pinchStartZoom = zoom;
      return;
    }
    primed = true;
    dragging = false;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    dragLastClientX = e.clientX;
    host.setPointerCapture(e.pointerId);
  });
  host.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchActive()) {
      const d = currentPinchDistance();
      if (pinchStartDistance > 0 && d > 0) {
        const next = pinchStartZoom * (d / pinchStartDistance);
        zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
      }
      return;
    }
    if (!primed) return;
    if (!dragging) {
      // Still inside the click-vs-drag dead zone.  Promote to
      // drag once the pointer has moved past DRAG_THRESHOLD_PX
      // from the start position.
      const dx = e.clientX - dragStartClientX;
      const dy = e.clientY - dragStartClientY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      host.classList.add('stage__canvas--dragging');
      // Drag started for real → enter free-camera mode at the
      // current camera-x so the user grabs whatever they're
      // already looking at (no teleport).
      cameraMode = { type: 'free' };
      freeCameraX = camera.x;
      markManualInput();
      emitCameraChange();
    }
    const dxPx = e.clientX - dragLastClientX;
    dragLastClientX = e.clientX;
    // Inverted: dragging right pulls the world right, so the camera
    // slides left.  Matches the standard "grab and pull" gesture.
    freeCameraX -= dxPx / zoom;
    cameraTarget = { x: freeCameraX, y: cameraTarget.y };
    markManualInput();
  });
  const stopHostDragging = (e: PointerEvent): void => {
    const wasClick = primed && !dragging && e.type === 'pointerup';
    activePointers.delete(e.pointerId);
    primed = false;
    dragging = false;
    host.classList.remove('stage__canvas--dragging');
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
    // If the user lifted one of two fingers mid-pinch, re-anchor
    // the pinch baseline so the next move tick doesn't snap the
    // zoom level (the remaining distance shouldn't suddenly
    // re-scale relative to the original two-finger gap).
    if (activePointers.size >= 2) {
      pinchStartDistance = currentPinchDistance();
      pinchStartZoom = zoom;
    }
    // No drag, just a tap → try to pick a car under the cursor.
    if (wasClick && carPickHandler && lastSnap) {
      const picked = pickCarAt(e.clientX, e.clientY);
      if (picked !== -1) carPickHandler(picked);
    }
  };
  host.addEventListener('pointerup', stopHostDragging);
  host.addEventListener('pointercancel', stopHostDragging);

  /**
   * Screen → world coordinate hit-test.  Returns the snapshot index
   * of the nearest car whose chassis bounding-circle contains the
   * clicked point, or -1 if no car is within the tolerance.
   *
   * The world transform maps a car at world-(wx, wy) onto screen
   * coords using:
   *    screenX = (wx - camera.x) * zoom + width  * 0.5
   *    screenY = (camera.y - wy) * zoom + height * anchor
   * The inverse maps the click back to world space.
   *
   * Tolerance is a per-car "approximate radius" that includes
   * the chassis hull *and* every wheel — chosen generously so
   * tiny cars are still tappable on touch screens.
   */
  function pickCarAt(clientX: number, clientY: number): number {
    if (!lastSnap) return -1;
    const rect = host.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const aspect = w / h;
    const anchor = aspect > 1.4 ? 0.72 : 0.55;
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const worldX = (sx - w * 0.5) / zoom + camera.x;
    const worldY = camera.y - (sy - h * anchor) / zoom;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (const car of lastSnap.cars) {
      // Approximate the car's overall extent: max distance from
      // chassis centre to any chassis vertex or wheel rim, then
      // add a generous 0.4 m tap-tolerance (≈ 14 px at default
      // zoom — comfortable on a finger).
      let extent = 0;
      for (const v of car.vertices) {
        const r = Math.hypot(v.x, v.y);
        if (r > extent) extent = r;
      }
      for (const wh of car.wheels) {
        const dx = wh.position.x - car.position.x;
        const dy = wh.position.y - car.position.y;
        const r = Math.hypot(dx, dy) + wh.radius;
        if (r > extent) extent = r;
      }
      const tolerance = extent + 0.4;
      const d = Math.hypot(worldX - car.position.x, worldY - car.position.y);
      if (d <= tolerance && d < bestDist) {
        bestDist = d;
        bestIdx = car.index;
      }
    }
    return bestIdx;
  }

  // Mouse-wheel zoom on the main canvas.  Wheel-up zooms in (more
  // pixels per metre), wheel-down zooms out.  preventDefault to
  // suppress the browser's default page scroll on top of the
  // canvas.  applyTransform reads `zoom` directly so the next RAF
  // tick picks up the new value.  Wheel doesn't count as "manual
  // input" for the idle-return purpose — zoom is orthogonal to
  // pan, and we don't want a quick zoom adjustment to lock the
  // camera in place forever.
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
    // Auto-return to leader-follow after idle.  Only fires when
    // we're in a manual mode (free / car) — leader mode has no
    // timer to expire.  `lastManualInputAt = 0` is the initial
    // value before anything has happened, in which case we don't
    // want the timer to immediately fire on the first frame.
    if (cameraMode.type !== 'leader' && lastManualInputAt > 0 && !dragging) {
      const idle = performance.now() - lastManualInputAt;
      if (idle >= CAMERA_IDLE_RETURN_MS) {
        cameraMode = { type: 'leader' };
        emitCameraChange();
      }
    }
    camera.x += (cameraTarget.x - camera.x) * CAMERA_LERP;
    camera.y += (cameraTarget.y - camera.y) * CAMERA_LERP;
    applyTransform();
  });

  function applyTransform(): void {
    const w = app.renderer.width / (window.devicePixelRatio || 1);
    const h = app.renderer.height / (window.devicePixelRatio || 1);
    // World vertical anchor — adaptive to the canvas aspect ratio.
    // Wide canvases (desktop, aspect > 1.4) keep the v1.12.2 0.72
    // anchor: cars in the lower third with lots of "what's coming"
    // sky above.  On a portrait phone the same 0.72 lands the cars
    // way too low — 72 % of a 500-px-tall canvas is 360 px down,
    // leaving only ~140 px of underground and *all* the sky pinned
    // at the top.  Center the framing for portrait so the cars
    // sit near vertical mid + sky and underground share the room
    // more evenly.
    const aspect = w / h;
    const anchor = aspect > 1.4 ? 0.72 : 0.55;
    world.position.set(w / 2 - camera.x * zoom, h * anchor + camera.y * zoom);
    world.scale.set(zoom, -zoom);
    // Parallax silhouettes — partial camera follow so they appear
    // farther away.  Track the same anchor so the silhouettes line
    // up with the world's track surface regardless of aspect.
    const bgAnchor = anchor + 0.02;
    bgFar.position.set(
      w / 2 - camera.x * PARALLAX_FAR * zoom,
      h * bgAnchor + camera.y * 0.05 * zoom,
    );
    bgFar.scale.set(zoom, -zoom);
    bgNear.position.set(
      w / 2 - camera.x * PARALLAX_NEAR * zoom,
      h * bgAnchor + camera.y * 0.1 * zoom,
    );
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

    // Discrete obstacles — walls, ceilings, kill-zones, plus the
    // surface modifiers (slick / bouncy) drawn as a coloured stroke
    // along the actual track curve where they apply.  Geometry
    // mirrors the simulation side: walls + ceilings are real
    // colliders, kill-zones are AABB triggers, slick/bouncy are
    // friction/restitution overrides on the surface segments.
    obstaclesGfx.clear();
    for (const ob of trackPhysicalObstacles) {
      if (ob.kind === 'wall') {
        const surfaceY = sampleTrackY(trackPoints, ob.x);
        // 10 cm wide, full configured height, sitting on the surface.
        obstaclesGfx.rect(ob.x - 0.05, surfaceY, 0.1, ob.height);
        obstaclesGfx.fill({ color: COLORS.obstacle, alpha: 0.95 });
      } else if (ob.kind === 'ceiling') {
        // Ceiling pole (v1.53): thin vertical "stalactite" hanging
        // from the sky down to ob.y.  Drawn 14 cm wide and 35 m
        // tall — outside the typical camera frame at the top, so
        // the eye reads it as a column descending from somewhere
        // above the visible world.
        obstaclesGfx.rect(ob.x - 0.07, ob.y, 0.14, 35);
        obstaclesGfx.fill({ color: COLORS.obstacle, alpha: 0.95 });
      } else if (ob.kind === 'finish') {
        // End-of-track wall — drawn as a continuation of the grey
        // track polyline bending 90° upward, not a striped post +
        // flag.  Same colour and stroke width as the regular track
        // line so the eye reads it as "the track ends here, going
        // up".  The wall sits on the run-out surface.
        obstaclesGfx.moveTo(ob.x, ob.yBase).lineTo(ob.x, ob.yBase + ob.height);
        obstaclesGfx.stroke({ color: COLORS.track, width: 0.08, alpha: 1 });
      } else {
        // Slick patch: re-trace the track polyline between x1 and
        // x2 in the slick overlay colour.  Drawn at a touch heavier
        // stroke than the grey track so it reads as a surface
        // treatment, not a separate object.
        const stride = 0.6;
        let first = true;
        for (let x = ob.x1; x <= ob.x2 + 1e-4; x += stride) {
          const xc = Math.min(x, ob.x2);
          const y = sampleTrackY(trackPoints, xc);
          if (first) {
            obstaclesGfx.moveTo(xc, y);
            first = false;
          } else {
            obstaclesGfx.lineTo(xc, y);
          }
        }
        obstaclesGfx.stroke({ color: COLORS.slick, width: 0.16, alpha: 0.95 });
      }
    }

    // Visual finish line — a dashed white vertical line at
    // track.finishLineX.  Short dashes with small gaps so it reads
    // as "marker" rather than "wall"; thin stroke keeps it from
    // overpowering the cars + track.
    if (trackFinishLineX !== null) {
      const lineX = trackFinishLineX;
      const baseY = sampleTrackY(trackPoints, lineX);
      // 100 m tall — well past anything the camera will frame at any
      // zoom, so the marker reads as "infinitely tall" without us
      // having to recompute it on every camera tick.  Drawn once on
      // setTrack; Pixi clips dashes outside the viewport, so the
      // out-of-view segments cost nothing per frame.
      const totalH = 100;
      const dashLen = 0.25;
      const gapLen = 0.1;
      const stride = dashLen + gapLen;
      let y = baseY;
      while (y < baseY + totalH) {
        const yEnd = Math.min(baseY + totalH, y + dashLen);
        obstaclesGfx.moveTo(lineX, y).lineTo(lineX, yEnd);
        y += stride;
      }
      obstaclesGfx.stroke({ color: COLORS.finishLight, width: 0.05, alpha: 1 });
    }

    // Parallax layers: two silhouette ridges generated by procedural
    // sines.  We only need to redraw them when the track changes.
    drawParallaxLayer(bgFarGfx, last.x, 0.05, 1.6, 0.7, COLORS.bgFar);
    drawParallaxLayer(bgNearGfx, last.x, 0.09, 1.0, 0.4, COLORS.bgNear);
  }

  function setSnapshot(
    snap: WorldSnapshot,
    opts: {
      tier?: RenderTier;
      headless?: boolean;
      showOnlyLeader?: boolean;
    } = {},
  ): void {
    // Cache for the canvas-click hit-test (debug-bundle copy).
    lastSnap = snap;
    const tier: RenderTier = opts.tier ?? 'full';
    // `headless` is the session-level flag the host knows about
    // (true on ×32 / ×64 / ×128 — canvas hidden the whole time).
    // Falls back to "tier === 'none'" so older callers without the
    // explicit flag still behave.  Important: do NOT use the tier
    // alone — at ×8 the per-frame skip alternates tier between
    // 'lite' and 'none' and the minimap mode would oscillate
    // (visible flicker on the camera-viewport rect + car ticks).
    const headless = opts.headless ?? tier === 'none';
    const renderCars = tier !== 'none';

    // ── Always run, regardless of tier ────────────────────────────
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

    // Leader-change ping.  Whenever the running-leader's index
    // differs from the previous frame's, we kick the new leader's
    // CarView into a brief celebrate animation (scale-pop + green
    // tint) — even a 1-cm overtake therefore produces a visible
    // cue.  Skip during the very first snapshot (lastLeaderIdx is
    // null) since "leader" hasn't been established yet.
    const newLeaderIdx = runningLead?.index ?? null;
    if (newLeaderIdx !== null && lastLeaderIdx !== null && newLeaderIdx !== lastLeaderIdx) {
      const newView = carViews.get(newLeaderIdx);
      if (newView) newView.celebrateUntil = performance.now() + 700;
    }
    lastLeaderIdx = newLeaderIdx;

    // Resolve the actual camera target based on mode.
    //
    //   free mode — X is whatever the user dragged to, Y tracks the
    //               track surface under that X so the road stays in
    //               the visible band.  Without this Y-follow the
    //               camera kept the Y from the moment the user
    //               grabbed the camera, and panning to a basin or
    //               a peak left the road off-screen with empty sky
    //               filling the rest of the canvas (player report).
    //               sampleTrackY is one array lookup — runs at every
    //               speed tier without measurable cost.
    //   car mode  — follow that car's chassis position (already
    //               above ground by chassis radius).  Falls back to
    //               leader if the picked car isn't in the snapshot.
    //   leader    — follow the running leader's chassis.
    if (cameraMode.type === 'free') {
      const groundY = trackPoints ? sampleTrackY(trackPoints, freeCameraX) : cameraTarget.y;
      cameraTarget = { x: freeCameraX, y: groundY };
    } else if (cameraMode.type === 'car' && pickedCar) {
      cameraTarget = visualCenter(pickedCar);
    } else {
      const leader = runningLead ?? anyLead;
      if (leader) {
        const center = visualCenter(leader);
        // Cap the leader-follow camera at the finish line.  Once a
        // car has crossed the line its physical position keeps
        // rolling forward (toward the wall), but the renderer
        // freezes the visual at the finish line — so following the
        // physical position would slide the camera right past the
        // visual leader, leaving the finish marker stuck on the
        // far left of the canvas with empty run-out filling the
        // right.  Clamp to finishLineX so the marker stays
        // centred + the visually-frozen leader stays at canvas
        // centre as the run-out scrolls behind it.
        if (trackFinishLineX !== null && center.x > trackFinishLineX) {
          center.x = trackFinishLineX;
        }
        cameraTarget = center;
      }
    }

    // Minimap is SVG and ~30–50 attribute writes per call; cheap
    // enough that we keep updating it even when the main canvas is
    // hidden in ×32/skip mode.  The user can still see the population
    // crawling along the track up there.
    if (minimap) {
      const dpr = window.devicePixelRatio || 1;
      const viewportWorldWidth = app.renderer.width / dpr / zoom;
      // Use the session-level `headless` flag, not the per-frame
      // tier — at ×8 the skip-alternation flips tier between 'lite'
      // and 'none' which would otherwise toggle the minimap
      // headless layout 30 Hz and visibly flicker.
      minimap.setHeadless(headless);
      minimap.update(snap, camera.x, viewportWorldWidth, recordHistory);
    }

    // ── Heavy work, skipped when canvas is hidden ──────────────────
    // updateCarView is the per-car Pixi position/rotation/tint write.
    // At 24 cars × N wheels per car this is the bulk of render cost.
    // In headless mode (×32, skip-N-gens) we just don't do it — the
    // canvas is already invisible, so nobody sees the stale views.
    if (!renderCars) return;

    // Show-only-leader mode: hide every car except the running
    // leader so the player can watch the champion drive the track
    // alone.  When the flag is off the cars all become visible
    // again on the very next call, so toggling mid-run is cheap.
    const onlyLeader = !!opts.showOnlyLeader;
    const leaderForViewIdx = onlyLeader ? (runningLead?.index ?? anyLead?.index ?? -1) : -1;

    const seen = new Set<number>();
    for (const car of snap.cars) {
      seen.add(car.index);
      let view = carViews.get(car.index);
      if (!view) {
        view = makeCarView(car);
        carsLayer.addChild(view.container);
        carViews.set(car.index, view);
      }
      if (onlyLeader && car.index !== leaderForViewIdx) {
        if (view.container.visible) view.container.visible = false;
        continue;
      }
      if (!view.container.visible) view.container.visible = true;
      updateCarView(view, car, tier, car.index === newLeaderIdx);
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
    setTrack(points, physicalObstacles, finishLineX): void {
      trackPoints = points;
      trackPhysicalObstacles = physicalObstacles ?? [];
      trackFinishLineX = finishLineX ?? null;
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
      // Also clear the idle-return clock so the next manual gesture
      // starts a fresh 10-second window — otherwise a half-elapsed
      // timer carries over from the previous run and can snap the
      // camera back almost immediately.
      lastManualInputAt = 0;
    },
    setSnapshot,
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
    onCarPick(handler): void {
      carPickHandler = handler;
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
  /**
   * When > performance.now(), the chassis is mid scale-pop ping —
   * used by the leader-change cue to give the new leader a brief
   * tint + size flash.  Finish-line crossing no longer sets this
   * (v1.40 visual change: finishers fade to alpha 0.4 + neutral
   * tint instead of celebrating).
   */
  celebrateUntil: number;
  /**
   * True once the car has been drawn in its post-finish pose at
   * least once.  Prevents per-frame Pixi attribute writes for a
   * dead car that physics has already pinned in place.
   */
  finalDrawn: boolean;
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
    // Bounce visualisation (v1.54): a thinner inner concentric ring
    // whose radius shrinks with the per-wheel `bounce` gene.  At
    // bounce ≈ 0 the inner ring sits flush with the rim and reads
    // as a solid puck; at bounce ≈ 1 it shrinks to ~45 % of the
    // wheel radius, producing a hollow "tyre with a hub" silhouette
    // that's immediately recognisable as "this wheel is bouncy".
    // Drawn only above a small threshold so non-bouncy wheels stay
    // crisply solid.
    if (w.bounce > 0.05) {
      const innerR = w.radius * lerp(0.92, 0.45, w.bounce);
      g.circle(0, 0, innerR);
      g.stroke({ color: 0xffffff, width: stroke * 0.6 });
    }
    // Spoke from hub to rim — a touch thinner than the rim so the orientation
    // reads at a glance.
    g.moveTo(0, 0).lineTo(w.radius, 0);
    g.stroke({ color: 0xffffff, width: stroke * 0.7 });
    g.tint = COLORS.wheel;
    wheels.push(g);
    container.addChild(g);
  }

  return {
    container,
    body,
    wheels,
    celebrateUntil: 0,
    finalDrawn: false,
  };
}

function updateCarView(view: CarView, car: CarSnapshot, tier: RenderTier, isLeader: boolean): void {
  const isFinisher = car.finishTime !== null;
  // "Done" = either physics-frozen (stalled / out-of-time) or just
  // crossed the finish line.  Both freeze the renderer at the
  // car's current pose.  Note: a finisher's body keeps physically
  // rolling forward toward the wall after crossing, but the
  // renderer stops following it the moment finishTime is set so
  // the player sees a clean "you made it, you're done" frame at
  // the finish line.
  const isDone = car.finished || isFinisher;
  // Skip the entire per-car update once the car has been rendered
  // in its final pose at least once — the position is fixed
  // visually so we save a Container.position/rotation write +
  // per-wheel updates for every "done" car still on screen.
  if (isDone && view.finalDrawn) return;

  view.container.position.set(car.position.x, car.position.y);
  view.container.rotation = car.angle;

  // Finish-line state.  Was a 1.2-s celebration window with a
  // scale-pop + bright tint; v1.40 dropped that on player request.
  // Finishers now read as "done" via alpha 0.4 + neutral white tint
  // (no celebration animation).  The leader-change ping below
  // still uses celebrateUntil / scale-pop for *non-finished* cars.
  // (isFinisher / isDone are computed at the top of the function.)
  const now = performance.now();
  const celebrating = now < view.celebrateUntil;
  // Alpha:
  //   finishers   — 0.4 (semi-transparent fade after crossing).
  //   stalled     — 0.3 (cars that died without finishing).
  //   alive       — 1.0.
  view.container.alpha = isFinisher ? 0.4 : car.finished ? 0.3 : 1;
  // Scale pop survives only for the leader-change ping; finishers
  // never set celebrateUntil now, so this branch is dead for them.
  if (celebrating && !isFinisher) {
    const remaining = view.celebrateUntil - now;
    const t = Math.max(0, Math.min(1, remaining / 1200));
    const scale = 1 + 0.18 * t;
    view.container.scale.set(scale, scale);
  } else {
    view.container.scale.set(1, 1);
  }

  // Chassis tint policy:
  //   tier !== 'full'   — neutral white body for everyone, no
  //                       accents.  At ×8+ the strobing of leader
  //                       tints is unreadable and burns GPU cycles.
  //   finisher          — neutral white (the alpha 0.4 carries the
  //                       "done" cue, no colour needed).
  //   leader-change ping — accent green flash on the new leader.
  //   leader & elite    — accent green steady.
  //   leader & !elite   — warm red-orange ("fresh blood in front").
  //   default           — white body.
  if (tier !== 'full') {
    view.body.tint = COLORS.body;
  } else if (isFinisher) {
    view.body.tint = COLORS.body;
  } else if (celebrating) {
    view.body.tint = COLORS.finisher;
  } else if (isLeader) {
    view.body.tint = car.isElite ? COLORS.leaderElite : COLORS.leaderNewcomer;
  } else {
    view.body.tint = COLORS.body;
  }

  const cos = Math.cos(-car.angle);
  const sin = Math.sin(-car.angle);
  // Per-tier wheel work:
  //   'full' (×1)  — full update.  Position, spin angle, and
  //                  green flash on grounded wheels.  Finishers
  //                  get neutral grey wheels (no green strobe,
  //                  alpha-fade carries the "done" cue).
  //   'lite' (×8+) — position only.  Spin animation is invisible
  //                  at ×8 anyway and the green strobe is too.
  for (let i = 0; i < view.wheels.length; i++) {
    const wg = view.wheels[i]!;
    const ws = car.wheels[i];
    if (!ws) continue;
    const dx = ws.position.x - car.position.x;
    const dy = ws.position.y - car.position.y;
    wg.position.set(dx * cos - dy * sin, dx * sin + dy * cos);
    if (tier === 'full') {
      wg.rotation = ws.angle - car.angle;
      if (isFinisher || car.finished) {
        wg.tint = COLORS.wheel;
      } else {
        wg.tint = ws.onGround ? COLORS.wheelGround : COLORS.wheel;
      }
    } else {
      wg.tint = COLORS.wheel;
    }
  }
  // Latch the "final pose" the moment a car becomes done — either
  // physics-finished (stalled / out-of-time) or just crossed the
  // finish line.  The next per-frame call hits the early-return
  // at the top of updateCarView and the car stays frozen at
  // whatever pose was drawn here.  For finishers the body keeps
  // physically rolling (until it stalls at the wall) but the
  // renderer no longer follows it — visual freeze at the line.
  if (isDone) view.finalDrawn = true;
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

/**
 * World-space "visual middle" of a car — the chassis polygon's
 * centroid (averaged local vertices) transformed by the chassis's
 * world position + rotation.  Used as the camera-follow target
 * instead of the bare chassis position so that asymmetric
 * polygons (e.g. a chassis with one long radius pulling the
 * polygon to one side) sit visually centered on screen.
 *
 * The chassis position is the body's physics anchor, which is at
 * (0, 0) in local coords — but the *visible* shape can drift
 * far off that anchor when vertex radii are uneven (max chassis
 * radius is 3.5 m, so the visual centroid can be metres away
 * from the physics anchor).  Without this offset the leader
 * tended to render visibly off-center on narrow portrait
 * canvases.
 */
function visualCenter(car: CarSnapshot): { x: number; y: number } {
  const verts = car.vertices;
  if (verts.length === 0) return { x: car.position.x, y: car.position.y };
  let cx = 0;
  let cy = 0;
  for (const v of verts) {
    cx += v.x;
    cy += v.y;
  }
  cx /= verts.length;
  cy /= verts.length;
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  return {
    x: car.position.x + cx * cos - cy * sin,
    y: car.position.y + cx * sin + cy * cos,
  };
}

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
