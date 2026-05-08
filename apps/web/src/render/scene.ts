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
  highlight: 0xffd166,
  /** Chassis tint for cars that have crossed the finish line —
   *  same accent green as the leader marker / "wheel on ground"
   *  swatch so finishers visually pair with the rest of the
   *  positive-feedback palette. */
  finisher: 0xa8ff60,
  /** Walls + ceilings — hazard red, matches the record marker. */
  obstacle: 0xd05d5d,
  /** Slick patch — light blue, "ice-like".  Drawn over the track polyline. */
  slick: 0x7ec8ff,
  /** Finish-line stripes alternate between these. */
  finishDark: 0x1a1a1f,
  finishLight: 0xf2f2f5,
  /** Finish flag fabric — warm accent so it reads at a distance. */
  finishFlag: 0xffd166,
  finishPole: 0xc8c8d0,
} as const;

const HIGHLIGHT_MS = 1500;

export type CarClickHandler = (carIndex: number) => void;

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
  setSnapshot(s: WorldSnapshot, opts?: { tier?: RenderTier; headless?: boolean }): void;
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
  let trackFinishLineX: number | null = null;
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
    minimap.onCarSelect((idx) => {
      cameraMode = { type: 'car', idx };
      markManualInput();
      emitCameraChange();
    });
  }

  // Drag on the main canvas → free-camera mode.  The drag delta
  // (in screen pixels) is converted to world-metres via the
  // current zoom and applied directly to freeCameraX so the
  // viewport tracks the cursor 1:1.  Pointer-capture means the
  // gesture survives leaving the canvas bounds while the button
  // is still held.
  //
  // Two-stage state machine to distinguish clicks from drags:
  //   primed = pointer is down but we haven't seen enough motion
  //            to call it a drag yet.  Click-on-car (whose Pixi
  //            handler fires the debug-bundle copy) lives entirely
  //            inside this stage and never switches camera mode.
  //   dragging = motion has crossed DRAG_THRESHOLD_PX, the gesture
  //              is now confirmed as a camera pan.
  const DRAG_THRESHOLD_PX = 4;
  let primed = false;
  let dragging = false;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragLastClientX = 0;
  host.addEventListener('pointerdown', (e) => {
    // Only the primary button (left mouse / first finger) drives
    // the camera — leave middle/right click for browser defaults.
    if (e.button !== 0) return;
    primed = true;
    dragging = false;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    dragLastClientX = e.clientX;
    host.setPointerCapture(e.pointerId);
  });
  host.addEventListener('pointermove', (e) => {
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
    primed = false;
    dragging = false;
    host.classList.remove('stage__canvas--dragging');
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
  };
  host.addEventListener('pointerup', stopHostDragging);
  host.addEventListener('pointercancel', stopHostDragging);

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
    // World vertical anchor — chosen so the track sits roughly mid-
    // frame with extra "sky" above the cars (the part of the canvas
    // we actually paint).  Bumped 0.6 → 0.72 in v1.12.2 by player
    // request: at 0.6 the cars sat near the top third of the canvas
    // and the lower half was empty dark space.
    world.position.set(w / 2 - camera.x * zoom, h * 0.72 + camera.y * zoom);
    world.scale.set(zoom, -zoom);
    // Parallax silhouettes — partial camera follow so they appear
    // farther away.  Each layer has its own ZOOM so the same world
    // coordinates produce different on-screen positions.
    bgFar.position.set(w / 2 - camera.x * PARALLAX_FAR * zoom, h * 0.74 + camera.y * 0.05 * zoom);
    bgFar.scale.set(zoom, -zoom);
    bgNear.position.set(w / 2 - camera.x * PARALLAX_NEAR * zoom, h * 0.74 + camera.y * 0.1 * zoom);
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
        // Ceiling: filled rectangle from the underside-y down by
        // 16 cm, centred at xCenter.
        obstaclesGfx.rect(ob.xCenter - ob.halfWidth, ob.y - 0.08, ob.halfWidth * 2, 0.16);
        obstaclesGfx.fill({ color: COLORS.obstacle, alpha: 0.95 });
      } else if (ob.kind === 'finish') {
        // Finish line: a 20 cm wide vertical wall striped in
        // alternating dark/light bands like a real finish flag,
        // capped with a flag flying off the top.  Geometry sits
        // exactly where the collider in buildTrackColliders is.
        const stripeBand = 0.6; // m per band — readable from a distance
        const halfThickness = 0.1;
        const bandsCount = Math.max(1, Math.ceil(ob.height / stripeBand));
        for (let i = 0; i < bandsCount; i++) {
          const yA = ob.yBase + i * stripeBand;
          const yB = Math.min(ob.yBase + ob.height, yA + stripeBand);
          obstaclesGfx.rect(ob.x - halfThickness, yA, halfThickness * 2, yB - yA);
          obstaclesGfx.fill({
            color: i % 2 === 0 ? COLORS.finishDark : COLORS.finishLight,
            alpha: 1,
          });
        }
        // Flag pole — extends an extra 1.5 m above the wall top so
        // the flag sits clearly above the structure.
        const poleTop = ob.yBase + ob.height + 1.5;
        obstaclesGfx.moveTo(ob.x, ob.yBase + ob.height).lineTo(ob.x, poleTop);
        obstaclesGfx.stroke({ color: COLORS.finishPole, width: 0.06, alpha: 1 });
        // Triangular flag flying *backwards* from the pole (toward
        // the approach side, x < ob.x), so a car crossing reads
        // "I've reached the flag".
        obstaclesGfx
          .moveTo(ob.x, poleTop)
          .lineTo(ob.x - 1.4, poleTop - 0.4)
          .lineTo(ob.x, poleTop - 0.8)
          .closePath();
        obstaclesGfx.fill({ color: COLORS.finishFlag, alpha: 1 });
      } else {
        // Slick patches: re-trace the track polyline between x1
        // and x2 in light blue.  Drawn at a touch heavier stroke
        // than the grey track so it reads as an overlay rather
        // than blending in.
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

    // Visual finish line — a checkered vertical strip at
    // track.finishLineX, sitting in the basin a few metres before
    // the wall.  Cars cross this line to register their finishTime
    // (the wall is just a stopper afterwards).  Render as a stack
    // of alternating dark/light squares so it reads like a real
    // race finish line rather than another obstacle.
    if (trackFinishLineX !== null) {
      const lineX = trackFinishLineX;
      const baseY = sampleTrackY(trackPoints, lineX);
      const totalH = 4; // 4 m tall — visible without dominating
      const square = 0.5; // ½ m per checker square
      const halfW = 0.18;
      const rows = Math.ceil(totalH / square);
      for (let r = 0; r < rows; r++) {
        const yA = baseY + r * square;
        const yB = Math.min(baseY + totalH, yA + square);
        // Two columns per row (left / right halves) so the checker
        // alternates both vertically AND horizontally — classic
        // 2×N checkerboard pattern.
        for (let col = 0; col < 2; col++) {
          const xL = lineX - halfW + col * halfW;
          const dark = (r + col) % 2 === 0;
          obstaclesGfx.rect(xL, yA, halfW, yB - yA);
          obstaclesGfx.fill({
            color: dark ? COLORS.finishDark : COLORS.finishLight,
            alpha: 1,
          });
        }
      }
    }

    // Parallax layers: two silhouette ridges generated by procedural
    // sines.  We only need to redraw them when the track changes.
    drawParallaxLayer(bgFarGfx, last.x, 0.05, 1.6, 0.7, COLORS.bgFar);
    drawParallaxLayer(bgNearGfx, last.x, 0.09, 1.0, 0.4, COLORS.bgNear);
  }

  function setSnapshot(
    snap: WorldSnapshot,
    opts: { tier?: RenderTier; headless?: boolean } = {},
  ): void {
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

    const seen = new Set<number>();
    for (const car of snap.cars) {
      seen.add(car.index);
      let view = carViews.get(car.index);
      if (!view) {
        view = makeCarView(car, (idx) => onCarClickHandler?.(idx));
        carsLayer.addChild(view.container);
        carViews.set(car.index, view);
      }
      updateCarView(view, car, tier);
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
  /**
   * When > performance.now(), the chassis is mid-celebration after
   * crossing the finish line — bright accent tint + scale pop +
   * full alpha.  Set on the per-frame transition from
   * "finishTime === null" to "finishTime !== null".
   */
  celebrateUntil: number;
  /** Last seen `car.finishTime` so we can detect the cross-the-line edge. */
  hadFinishTime: boolean;
  /**
   * True once the car has been drawn in its post-finish pose at
   * least once.  Prevents per-frame Pixi attribute writes for a
   * dead car that physics has already pinned in place.
   */
  finalDrawn: boolean;
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

  const view: CarView = {
    container,
    body,
    wheels,
    highlightUntil: 0,
    celebrateUntil: 0,
    hadFinishTime: false,
    finalDrawn: false,
  };

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

function updateCarView(view: CarView, car: CarSnapshot, tier: RenderTier): void {
  // Skip the entire per-car update once a finished car has been
  // rendered in its final pose at least once — the body is fixed
  // in world.ts so its position will never change again.  Saves
  // a Container.position/rotation write + per-wheel updates for
  // every dead car still on screen.
  if (car.finished && view.finalDrawn) return;

  view.container.position.set(car.position.x, car.position.y);
  view.container.rotation = car.angle;

  // Finish-line cross detector: the moment we see finishTime go
  // null → non-null, kick off a ~1.2 s "celebration" window — bright
  // accent tint + slight scale-pop — so the player gets a
  // distinctive visual ping for each car that crosses.  Past the
  // window, finishers stay accent-tinted (and at full alpha) so
  // they remain visually distinct from cars that merely stalled.
  const isFinisher = car.finishTime !== null;
  if (isFinisher && !view.hadFinishTime) {
    view.celebrateUntil = performance.now() + 1200;
    view.hadFinishTime = true;
  }
  const now = performance.now();
  const celebrating = now < view.celebrateUntil;
  // Alpha: still-running = 1.  Finishers (with or without
  // celebration) = 1, so their accent-coloured chassis pops out.
  // Stalled non-finishers fade to 0.3 as before.
  view.container.alpha = car.finished && !isFinisher ? 0.3 : 1;
  // Scale pop: linear ease 1.18 → 1.0 over the celebration window.
  if (celebrating) {
    const remaining = view.celebrateUntil - now;
    const t = Math.max(0, Math.min(1, remaining / 1200));
    const scale = 1 + 0.18 * t;
    view.container.scale.set(scale, scale);
  } else {
    view.container.scale.set(1, 1);
  }

  // Chassis tint priority: click-highlight > celebration > finisher
  // (accent green) > default body colour.
  if (now < view.highlightUntil) {
    view.body.tint = COLORS.highlight;
  } else if (celebrating || isFinisher) {
    view.body.tint = COLORS.finisher;
  } else {
    view.body.tint = COLORS.body;
  }

  const cos = Math.cos(-car.angle);
  const sin = Math.sin(-car.angle);
  // Wheel tinting policy:
  //   'full' (×1)  — green flash on grounded wheels every frame
  //   'lite' (×8)  — neutral grey only.  At ×8 the green strobe
  //                  is unreadable and a previously-set green tint
  //                  would otherwise stick if we just skipped the
  //                  write (the bug this comment is replacing).
  for (let i = 0; i < view.wheels.length; i++) {
    const wg = view.wheels[i]!;
    const ws = car.wheels[i];
    if (!ws) continue;
    const dx = ws.position.x - car.position.x;
    const dy = ws.position.y - car.position.y;
    wg.position.set(dx * cos - dy * sin, dx * sin + dy * cos);
    wg.rotation = ws.angle - car.angle;
    if (tier === 'full') {
      wg.tint = ws.onGround && !car.finished ? COLORS.wheelGround : COLORS.wheel;
    } else {
      wg.tint = COLORS.wheel;
    }
  }
  // Don't latch the "final pose" while the celebration animation is
  // still playing — otherwise the per-frame skip would freeze the
  // chassis at whatever scale-pop value happened on this tick and
  // never settle back to 1.0.
  if (car.finished && !celebrating) view.finalDrawn = true;
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
