/**
 * SVG-based minimap.  Compresses the entire track length into a tiny
 * 1500 × 50 viewBox at the top of the canvas, then on every snapshot
 * updates several markers:
 *
 *   - a translucent rectangle showing the camera's current viewport
 *   - a green dot for whoever is currently the leader
 *   - up to RECORD_HISTORY_MAX vertical red lines marking the most
 *     recent record-setting positions on this track.  The newest
 *     line is at full opacity; older ones fade.
 *
 * Compared to a Pixi-based minimap (own RenderTexture etc.) the SVG
 * variant is dirt cheap to draw: a single polyline that's set once
 * per session, plus a handful of attribute writes per frame.
 */

import type { WorldSnapshot } from '../sim/world';

/**
 * SVG viewBox: 1500×86.  At our typical display size (≈1400×80) this
 * gives an x-scale of 0.93 and a y-scale of 0.93 — uniform, so
 * strokes and dots don't stretch.  The taller box (was 50 in
 * v0.9.20) lets vertical track features actually read on the
 * minimap; the previous height squished hills into a near-flat
 * line.
 */
const VIEW_W = 1500;
const VIEW_H = 86;
/** Vertical padding inside the viewBox so the track polyline doesn't kiss the edges. */
const PAD_Y = 12;
/** Stride target — keep one polyline node per ≈ 6 viewBox units. */
const STRIDE_TARGET = 6;
/**
 * How many past records to keep on screen.  Newest = full opacity;
 * each older entry is dimmed linearly down to a floor that's still
 * visible but unmistakably "old".
 */
const RECORD_HISTORY_MAX = 5;

export type MinimapHandle = {
  setTrack(points: { x: number; y: number }[]): void;
  /**
   * Tell the minimap where the camera is currently centred and which
   * record-positions to highlight.  `recordHistory` is ordered oldest
   * → newest; the last entry is the current track record (drawn at
   * full opacity), earlier entries fade with age.  Pass an empty
   * array (or omit) to hide all record markers — e.g. when the track
   * changes every gen and "record on this track" isn't meaningful.
   */
  update(
    snap: WorldSnapshot,
    cameraX: number,
    viewportWorldWidth: number,
    recordHistory?: number[],
  ): void;
  /**
   * Subscribe to "user clicked or dragged on the minimap surface".
   * The handler is called with the world-x corresponding to the
   * cursor position.  Used by the host to enter free-camera mode.
   * Click on a specific car dot does NOT fire this — those have
   * their own pointerdown handler that stops propagation.
   */
  onJump(handler: ((worldX: number) => void) | null): void;
  /**
   * Subscribe to "user clicked a specific car dot on the minimap".
   * The handler is called with that car's snapshot index.  Host
   * uses this to enter follow-this-car mode.
   */
  onCarSelect(handler: ((carIdx: number) => void) | null): void;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountMinimap(svg: SVGSVGElement): MinimapHandle {
  const trackEl = svg.querySelector<SVGPolylineElement>('.minimap__track');
  const viewportEl = svg.querySelector<SVGRectElement>('.minimap__viewport');
  const carsGroup = svg.querySelector<SVGGElement>('.minimap__cars');
  const leaderEl = svg.querySelector<SVGLineElement>('.minimap__leader');
  const recordsGroup = svg.querySelector<SVGGElement>('.minimap__records');
  if (!trackEl || !viewportEl || !carsGroup || !leaderEl || !recordsGroup) {
    throw new Error('mountMinimap: missing child elements');
  }

  let trackLength = 0;
  let trackMinY = 0;
  let trackMaxY = 1;
  /**
   * Pool of <line> elements (one per car).  Lines instead of
   * circles because the minimap SVG uses
   * `preserveAspectRatio="none"` — circles get squashed into
   * ellipses on the tall ×32-mode minimap, but vertical lines
   * with `vector-effect="non-scaling-stroke"` keep their
   * stroke 2 px regardless of aspect, so they always read as
   * crisp tick marks.
   */
  const carDots: SVGLineElement[] = [];
  /** Half-length (viewBox y-units) of each car's vertical tick. */
  const CAR_TICK_HALF = 2.4;
  /** Half-length of the leader's tick — bigger so it stands out. */
  const LEADER_TICK_HALF = 6;
  /**
   * Pool of <line> elements for the record-history vertical lines.
   * Pre-built once at mount time — RECORD_HISTORY_MAX is small and
   * fixed, so we never grow this pool dynamically.  Lines we don't
   * have a history entry for get hidden via opacity 0 each frame.
   */
  const recordLines: SVGLineElement[] = [];
  for (let i = 0; i < RECORD_HISTORY_MAX; i++) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'minimap__record');
    line.setAttribute('y1', '0');
    line.setAttribute('y2', String(VIEW_H));
    line.setAttribute('opacity', '0');
    recordsGroup.appendChild(line);
    recordLines.push(line);
  }

  let jumpHandler: ((worldX: number) => void) | null = null;
  let carSelectHandler: ((idx: number) => void) | null = null;
  let dragging = false;

  // Clicking a car-dot is a "follow this car" gesture; the handler
  // stops propagation so the surrounding minimap-surface listener
  // doesn't *also* treat it as a free-camera jump.  Dot indices are
  // stored in dataset and updated each frame in update() — this lets
  // a single delegated listener service the whole pool.
  carsGroup.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof SVGElement)) return;
    const idxStr = e.target.dataset['carIdx'];
    if (idxStr === undefined) return;
    e.stopPropagation();
    carSelectHandler?.(Number(idxStr));
  });

  // Click or drag anywhere else on the minimap → manual camera jump
  // to that world-x.  Uses pointer capture so the drag keeps tracking
  // even if the cursor leaves the SVG bounds while still pressed.
  function emitJumpFromEvent(e: PointerEvent): void {
    if (!jumpHandler || trackLength === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    const worldX = Math.max(0, Math.min(trackLength, ratio * trackLength));
    jumpHandler(worldX);
  }
  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    svg.classList.add('minimap--dragging');
    svg.setPointerCapture(e.pointerId);
    emitJumpFromEvent(e);
  });
  svg.addEventListener('pointermove', (e) => {
    if (dragging) emitJumpFromEvent(e);
  });
  const stopDragging = (e: PointerEvent): void => {
    dragging = false;
    svg.classList.remove('minimap--dragging');
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  };
  svg.addEventListener('pointerup', stopDragging);
  svg.addEventListener('pointercancel', stopDragging);

  return {
    setTrack(points): void {
      if (points.length < 2) return;
      trackLength = points[points.length - 1]!.x;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of points) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      trackMinY = minY;
      trackMaxY = maxY;
      const yRange = maxY - minY || 1;
      // Stride through points so we don't put 2500 nodes into a 600-px-wide line.
      // Target ~one node every STRIDE_TARGET viewBox units.  At
      // VIEW_W=1500 that's 250 nodes — dense enough to look smooth
      // even when the canvas is wide.
      const stride = Math.max(1, Math.floor(points.length / (VIEW_W / STRIDE_TARGET)));
      let pts = '';
      for (let i = 0; i < points.length; i += stride) {
        const p = points[i]!;
        const x = (p.x / trackLength) * VIEW_W;
        const y = VIEW_H - PAD_Y - ((p.y - minY) / yRange) * (VIEW_H - 2 * PAD_Y);
        pts += `${x.toFixed(1)},${y.toFixed(1)} `;
      }
      trackEl.setAttribute('points', pts.trim());
    },
    update(snap, cameraX, viewportWorldWidth, recordHistory): void {
      if (trackLength === 0) return;
      const xToView = (worldX: number): number => (worldX / trackLength) * VIEW_W;
      const halfW = (viewportWorldWidth / trackLength) * VIEW_W * 0.5;
      const cx = xToView(cameraX);
      viewportEl.setAttribute('x', String(Math.max(0, cx - halfW)));
      viewportEl.setAttribute('width', String(Math.min(VIEW_W, halfW * 2)));

      // Render every car as a tiny dot AND pick the running leader.
      const yRange = trackMaxY - trackMinY || 1;
      let leader: { x: number; y: number } | null = null;
      let leaderRunning: { x: number; y: number } | null = null;
      for (let i = 0; i < snap.cars.length; i++) {
        const car = snap.cars[i]!;
        // Grow the line pool lazily.
        let dot = carDots[i];
        if (!dot) {
          dot = document.createElementNS(SVG_NS, 'line');
          dot.setAttribute('class', 'minimap__car');
          dot.setAttribute('vector-effect', 'non-scaling-stroke');
          carsGroup.appendChild(dot);
          carDots[i] = dot;
        }
        // Stamp the car index on the DOM node so the delegated
        // pointerdown listener on `carsGroup` can read it back when
        // the user clicks.  Re-set every frame because the pool is
        // reused across populations.
        dot.dataset['carIdx'] = String(car.index);
        const dx = xToView(car.position.x);
        const dy = VIEW_H - PAD_Y - ((car.position.y - trackMinY) / yRange) * (VIEW_H - 2 * PAD_Y);
        // Vertical tick centred on (dx, dy), CAR_TICK_HALF either
        // side.  x1 == x2 so the line is purely vertical; the
        // non-scaling-stroke means it stays a 2 px tick on screen
        // regardless of how tall the minimap is rendered.
        dot.setAttribute('x1', dx.toFixed(1));
        dot.setAttribute('x2', dx.toFixed(1));
        dot.setAttribute('y1', (dy - CAR_TICK_HALF).toFixed(1));
        dot.setAttribute('y2', (dy + CAR_TICK_HALF).toFixed(1));
        dot.setAttribute('opacity', car.finished ? '0.35' : '0.75');

        if (!leader || car.position.x > leader.x) leader = { x: car.position.x, y: car.position.y };
        if (!car.finished && (!leaderRunning || car.position.x > leaderRunning.x)) {
          leaderRunning = { x: car.position.x, y: car.position.y };
        }
      }
      // Hide any pool entries that are no longer in use (population shrunk).
      for (let i = snap.cars.length; i < carDots.length; i++) {
        carDots[i]!.setAttribute('opacity', '0');
      }

      const lead = leaderRunning ?? leader;
      if (lead) {
        const lx = xToView(lead.x);
        const ly = VIEW_H - PAD_Y - ((lead.y - trackMinY) / yRange) * (VIEW_H - 2 * PAD_Y);
        leaderEl.setAttribute('x1', String(lx));
        leaderEl.setAttribute('x2', String(lx));
        leaderEl.setAttribute('y1', String(ly - LEADER_TICK_HALF));
        leaderEl.setAttribute('y2', String(ly + LEADER_TICK_HALF));
        leaderEl.setAttribute('opacity', '1');
      } else {
        leaderEl.setAttribute('opacity', '0');
      }

      // Record-history lines.  Each entry in `recordHistory` (oldest
      // → newest) maps to one of the pooled <line> elements.  The
      // newest gets full opacity; older ones fade linearly down to
      // a floor, so a long-broken record is still visible but
      // unmistakably "old".  Lines we have no history for stay
      // hidden (opacity 0).
      const history = recordHistory ?? [];
      const N = Math.min(history.length, RECORD_HISTORY_MAX);
      for (let i = 0; i < recordLines.length; i++) {
        const line = recordLines[i]!;
        if (i >= N) {
          line.setAttribute('opacity', '0');
          continue;
        }
        const x = history[history.length - N + i]!;
        const lx = xToView(x);
        // age = 0 for the newest, N-1 for the oldest.  Map to
        // opacity in [0.18, 1.0] so even the oldest stays readable.
        const age = N - 1 - i;
        const denom = Math.max(1, RECORD_HISTORY_MAX - 1);
        const opacity = 1 - (age / denom) * 0.82;
        line.setAttribute('x1', String(lx));
        line.setAttribute('x2', String(lx));
        line.setAttribute('opacity', opacity.toFixed(2));
      }
    },
    onJump(handler): void {
      jumpHandler = handler;
    },
    onCarSelect(handler): void {
      carSelectHandler = handler;
    },
  };
}
