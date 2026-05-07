/**
 * Per-generation sparkline grid.
 *
 * Mounts a grid of mini-cards, one per metric, into the host element.
 * Each card has a label, a current-value readout, and an SVG sparkline
 * that draws the metric over the population's full lifetime.
 *
 * On `update(history)` we redraw every chart from the latest history
 * snapshot.  Cheap: at most a dozen <polyline>s with N points where
 * N is the generation count.
 *
 * Adding a new chart is one line in `CHART_DEFS`.
 */

import type { GenerationStats } from './collector';

const SVG_NS = 'http://www.w3.org/2000/svg';

type ChartDef = {
  key: keyof GenerationStats;
  label: string;
  /** Renders the latest value as a string (e.g. "12.3 m"). */
  format: (v: number) => string;
  /** Optional override stroke colour; defaults to muted grey. */
  color?: string;
};

const CHART_DEFS: ChartDef[] = [
  { key: 'best', label: 'Best fitness', format: (v) => `${v.toFixed(1)} m`, color: '#a8ff60' },
  { key: 'mean', label: 'Mean fitness', format: (v) => `${v.toFixed(1)} m` },
  { key: 'median', label: 'Median fitness', format: (v) => `${v.toFixed(1)} m` },
  { key: 'worst', label: 'Worst fitness', format: (v) => `${v.toFixed(1)} m` },
  { key: 'stdev', label: 'Diversity (σ)', format: (v) => `${v.toFixed(1)} m` },
  { key: 'alive', label: 'Cars that moved', format: (v) => v.toFixed(0) },
  {
    key: 'avgVertexCount',
    label: 'Avg chassis verts',
    format: (v) => v.toFixed(1),
  },
  { key: 'avgWheelCount', label: 'Avg wheels', format: (v) => v.toFixed(2) },
  {
    key: 'avgWheelPower',
    label: 'Avg wheel power',
    format: (v) => v.toFixed(2),
  },
  {
    key: 'avgMotorSpeed',
    label: 'Avg motor speed',
    format: (v) => `${v.toFixed(1)} rad/s`,
  },
  {
    key: 'avgChassisDensity',
    label: 'Avg chassis density',
    format: (v) => v.toFixed(0),
  },
  {
    key: 'avgChassisRadius',
    label: 'Avg chassis size',
    format: (v) => v.toFixed(2),
  },
  {
    key: 'durationSec',
    label: 'Generation time',
    format: (v) => `${v.toFixed(1)} s`,
  },
];

const SPARK_W = 160;
const SPARK_H = 44;

export type ChartsHandle = {
  update(history: GenerationStats[]): void;
  setVisible(v: boolean): void;
  isVisible(): boolean;
};

type Cell = {
  card: HTMLDivElement;
  value: HTMLSpanElement;
  svg: SVGSVGElement;
  polyline: SVGPolylineElement;
  def: ChartDef;
};

export function mountCharts(host: HTMLElement): ChartsHandle {
  host.classList.add('charts-grid');
  const cells: Cell[] = CHART_DEFS.map((def) => buildCell(def, host));

  let visible = !host.hasAttribute('hidden');

  return {
    update(history): void {
      if (history.length === 0) return;
      const latest = history[history.length - 1]!;
      for (const cell of cells) {
        const current = latest[cell.def.key] as number;
        cell.value.textContent = cell.def.format(current);
        const series = history.map((h) => h[cell.def.key] as number);
        renderSparkline(cell.polyline, series);
      }
    },
    setVisible(v): void {
      visible = v;
      if (v) host.removeAttribute('hidden');
      else host.setAttribute('hidden', '');
    },
    isVisible(): boolean {
      return visible;
    },
  };
}

function buildCell(def: ChartDef, host: HTMLElement): Cell {
  const card = document.createElement('div');
  card.className = 'chart-card';

  const head = document.createElement('div');
  head.className = 'chart-card__head';
  const title = document.createElement('span');
  title.className = 'chart-card__title';
  title.textContent = def.label;
  const value = document.createElement('span');
  value.className = 'chart-card__value';
  value.textContent = '—';
  head.appendChild(title);
  head.appendChild(value);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'chart-card__sparkline');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', def.color ?? 'var(--color-fg-muted)');
  polyline.setAttribute('stroke-width', '1.4');
  polyline.setAttribute('stroke-linecap', 'round');
  polyline.setAttribute('stroke-linejoin', 'round');
  if (def.color) polyline.setAttribute('stroke', def.color);
  svg.appendChild(polyline);

  card.appendChild(head);
  card.appendChild(svg);
  host.appendChild(card);
  return { card, value, svg, polyline, def };
}

function renderSparkline(polyline: SVGPolylineElement, values: number[]): void {
  if (values.length < 2) {
    polyline.setAttribute('points', '');
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const denom = values.length - 1 || 1;
  let pts = '';
  for (let i = 0; i < values.length; i++) {
    const x = (i / denom) * SPARK_W;
    const y = SPARK_H - ((values[i]! - min) / range) * SPARK_H;
    pts += `${x.toFixed(1)},${y.toFixed(1)} `;
  }
  polyline.setAttribute('points', pts.trim());
}
