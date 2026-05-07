/**
 * SVG-based minimap.  Compresses the entire track length into a tiny
 * 600 × 50 viewBox at the top of the canvas, then on every snapshot
 * updates two markers:
 *
 *   - a translucent rectangle showing the camera's current viewport
 *   - a green dot for whoever is currently the leader
 *
 * Compared to a Pixi-based minimap (own RenderTexture etc.) the SVG
 * variant is dirt cheap to draw: a single polyline that's set once
 * per session and two attribute writes per frame.
 */

import type { WorldSnapshot } from '../sim/world';

const VIEW_W = 600;
const VIEW_H = 50;
/** Vertical padding inside the viewBox so the track polyline doesn't kiss the edges. */
const PAD_Y = 6;

export type MinimapHandle = {
  setTrack(points: { x: number; y: number }[]): void;
  /** Tell the minimap where the camera is currently centred. */
  update(snap: WorldSnapshot, cameraX: number, viewportWorldWidth: number): void;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountMinimap(svg: SVGSVGElement): MinimapHandle {
  const trackEl = svg.querySelector<SVGPolylineElement>('.minimap__track');
  const viewportEl = svg.querySelector<SVGRectElement>('.minimap__viewport');
  const carsGroup = svg.querySelector<SVGGElement>('.minimap__cars');
  const leaderEl = svg.querySelector<SVGCircleElement>('.minimap__leader');
  if (!trackEl || !viewportEl || !carsGroup || !leaderEl) {
    throw new Error('mountMinimap: missing child elements');
  }

  let trackLength = 0;
  let trackMinY = 0;
  let trackMaxY = 1;
  /** Pool of <circle> elements for the population dots, grown on demand. */
  const carDots: SVGCircleElement[] = [];

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
      const stride = Math.max(1, Math.floor(points.length / 240));
      let pts = '';
      for (let i = 0; i < points.length; i += stride) {
        const p = points[i]!;
        const x = (p.x / trackLength) * VIEW_W;
        const y = VIEW_H - PAD_Y - ((p.y - minY) / yRange) * (VIEW_H - 2 * PAD_Y);
        pts += `${x.toFixed(1)},${y.toFixed(1)} `;
      }
      trackEl.setAttribute('points', pts.trim());
    },
    update(snap, cameraX, viewportWorldWidth): void {
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
          dot.setAttribute('r', '1.6');
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
    },
  };
}
