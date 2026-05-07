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
 * SVG viewBox: 1500×50.  At our typical display size (≈1260×44) this
 * gives an x-scale of 0.84 and a y-scale of 0.88 — close to uniform,
 * so strokes and dots aren't visibly stretched horizontally.  Was
 * 600×50 in v0.9.10 which looked OK at 420 px wide but became
 * obviously stretched once the user bumped the minimap to 1260 px.
 */
const VIEW_W = 1500;
const VIEW_H = 50;
/** Vertical padding inside the viewBox so the track polyline doesn't kiss the edges. */
const PAD_Y = 6;
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
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountMinimap(svg: SVGSVGElement): MinimapHandle {
  const trackEl = svg.querySelector<SVGPolylineElement>('.minimap__track');
  const viewportEl = svg.querySelector<SVGRectElement>('.minimap__viewport');
  const carsGroup = svg.querySelector<SVGGElement>('.minimap__cars');
  const leaderEl = svg.querySelector<SVGCircleElement>('.minimap__leader');
  const recordsGroup = svg.querySelector<SVGGElement>('.minimap__records');
  if (!trackEl || !viewportEl || !carsGroup || !leaderEl || !recordsGroup) {
    throw new Error('mountMinimap: missing child elements');
  }

  let trackLength = 0;
  let trackMinY = 0;
  let trackMaxY = 1;
  /** Pool of <circle> elements for the population dots, grown on demand. */
  const carDots: SVGCircleElement[] = [];
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
        // Grow the dot pool lazily.
        let dot = carDots[i];
        if (!dot) {
          dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('r', '2.4');
          dot.setAttribute('class', 'minimap__car');
          carsGroup.appendChild(dot);
          carDots[i] = dot;
        }
        const dx = xToView(car.position.x);
        const dy = VIEW_H - PAD_Y - ((car.position.y - trackMinY) / yRange) * (VIEW_H - 2 * PAD_Y);
        dot.setAttribute('cx', dx.toFixed(1));
        dot.setAttribute('cy', dy.toFixed(1));
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
        leaderEl.setAttribute('cx', String(lx));
        leaderEl.setAttribute('cy', String(ly));
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
  };
}
