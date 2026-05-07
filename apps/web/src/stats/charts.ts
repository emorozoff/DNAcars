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

import { t, type TranslationKey } from '../i18n';
import type { GenerationStats } from './collector';

const SVG_NS = 'http://www.w3.org/2000/svg';

type ChartDef = {
  key: keyof GenerationStats;
  /** i18n key for the title — wired through data-i18n so EN/RU toggle works. */
  i18nKey: TranslationKey;
  /** Renders the latest value as a string (e.g. "12.3 m"). */
  format: (v: number) => string;
  /** Optional override stroke colour; defaults to muted grey. */
  color?: string;
};

const CHART_DEFS: ChartDef[] = [
  {
    key: 'best',
    i18nKey: 'chart.best',
    format: (v) => `${v.toFixed(1)} m`,
    color: '#a8ff60',
  },
  { key: 'mean', i18nKey: 'chart.mean', format: (v) => `${v.toFixed(1)} m` },
  { key: 'stdev', i18nKey: 'chart.stdev', format: (v) => `${v.toFixed(1)} m` },
  { key: 'alive', i18nKey: 'chart.alive', format: (v) => v.toFixed(0) },
  { key: 'avgVertexCount', i18nKey: 'chart.avgVerts', format: (v) => v.toFixed(1) },
  { key: 'avgWheelCount', i18nKey: 'chart.avgWheels', format: (v) => v.toFixed(2) },
  { key: 'avgWheelPower', i18nKey: 'chart.avgWheelPower', format: (v) => v.toFixed(2) },
  {
    key: 'avgMotorSpeed',
    i18nKey: 'chart.avgMotorSpeed',
    format: (v) => `${v.toFixed(1)} rad/s`,
  },
  {
    key: 'avgChassisDensity',
    i18nKey: 'chart.avgChassisDensity',
    format: (v) => v.toFixed(0),
  },
  {
    key: 'avgChassisRadius',
    i18nKey: 'chart.avgChassisSize',
    format: (v) => v.toFixed(2),
  },
];

const SPARK_W = 160;
const SPARK_H = 44;

/**
 * How many of the most recent generations to plot.  `null` = all,
 * the historical default.  At 50 (the new default) the chart zooms
 * in on recent evolution — handy when total runs hit hundreds of
 * generations and the long tail squashes detail.
 */
type WindowSize = 50 | 100 | 200 | null;
const WINDOW_OPTIONS: WindowSize[] = [50, 100, 200, null];
const DEFAULT_WINDOW: WindowSize = 50;

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
  // Top-of-panel window selector.  The cells go in their own
  // grid container below so the segmented row sits cleanly above
  // them with header-style typography.
  const header = document.createElement('div');
  header.className = 'charts-panel__header';
  const label = document.createElement('span');
  label.className = 'charts-panel__label';
  label.setAttribute('data-i18n', 'panel.chartWindow');
  label.textContent = t('panel.chartWindow');
  const seg = document.createElement('div');
  seg.className = 'segmented charts-panel__window';
  seg.setAttribute('role', 'radiogroup');
  const segItems: HTMLButtonElement[] = [];
  let windowSize: WindowSize = DEFAULT_WINDOW;
  let lastHistory: GenerationStats[] = [];
  const updateSegmentedActive = (): void => {
    for (const btn of segItems) {
      const v = btn.dataset['window'];
      const active = (v === 'all' && windowSize === null) || Number(v) === windowSize;
      btn.classList.toggle('segmented__item--active', active);
    }
  };
  for (const opt of WINDOW_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segmented__item';
    if (opt === null) {
      btn.dataset['window'] = 'all';
      btn.setAttribute('data-i18n', 'panel.chartWindowAll');
      btn.textContent = t('panel.chartWindowAll');
    } else {
      btn.dataset['window'] = String(opt);
      btn.textContent = String(opt);
    }
    btn.addEventListener('click', () => {
      windowSize = opt;
      updateSegmentedActive();
      drawAll();
      btn.blur();
    });
    seg.appendChild(btn);
    segItems.push(btn);
  }
  header.appendChild(label);
  header.appendChild(seg);
  host.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'charts-grid';
  host.appendChild(grid);

  const cells: Cell[] = CHART_DEFS.map((def) => buildCell(def, grid));

  let visible = !host.hasAttribute('hidden');

  function applyWindow(history: GenerationStats[]): GenerationStats[] {
    if (windowSize === null || history.length <= windowSize) return history;
    return history.slice(history.length - windowSize);
  }

  function drawAll(): void {
    if (lastHistory.length === 0) return;
    const slice = applyWindow(lastHistory);
    const latest = slice[slice.length - 1]!;
    for (const cell of cells) {
      const current = latest[cell.def.key] as number;
      cell.value.textContent = cell.def.format(current);
      const series = slice.map((h) => h[cell.def.key] as number);
      renderSparkline(cell.polyline, series);
    }
  }

  updateSegmentedActive();

  return {
    update(history): void {
      lastHistory = history;
      drawAll();
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
  // data-i18n lets the existing applyTranslations() pick this up and
  // re-translate the title when the user toggles the language button.
  title.setAttribute('data-i18n', def.i18nKey);
  title.textContent = t(def.i18nKey);
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
