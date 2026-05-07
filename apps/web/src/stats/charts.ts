/**
 * Stats panel — three-section dashboard mounted as a floating card.
 *
 *   1. Progress hero — combined "best vs mean" line chart over the
 *      windowed history, with big current-value readouts.  The single
 *      most useful view for "is the GA actually getting better?".
 *   2. Distribution — histogram of the current generation's per-car
 *      travel distances, binned 0..max in equal-width bins.  Replaces
 *      the old standalone σ sparkline with something more intuitive.
 *   3. Genome trends — compact sparkline grid for the average genome
 *      stats (chassis verts, wheel count, wheel power, motor speed,
 *      chassis density, chassis size).
 *
 * The window selector in the header (50 / 100 / 200 / All) clamps how
 * many recent generations the progress hero + genome sparklines look
 * at; the histogram always shows the *current* generation only.
 *
 * Adding a new genome-trend chart is one line in `GENOME_DEFS`.
 */

import { t, type TranslationKey } from '../i18n';
import type { GenerationStats } from './collector';
import type { Scored } from '../ga/population';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ─── Header controls ──────────────────────────────────────────────── */

type WindowSize = 50 | 100 | 200 | null;
const WINDOW_OPTIONS: WindowSize[] = [50, 100, 200, null];
const DEFAULT_WINDOW: WindowSize = 50;

/* ─── Genome trend sparklines ──────────────────────────────────────── */

type GenomeDef = {
  key: keyof GenerationStats;
  i18nKey: TranslationKey;
  format: (v: number) => string;
};

const GENOME_DEFS: GenomeDef[] = [
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

/* ─── Layout constants ─────────────────────────────────────────────── */

const HERO_W = 600;
const HERO_H = 160;
const HIST_W = 600;
const HIST_H = 100;
const SPARK_W = 130;
const SPARK_H = 36;
const HIST_BINS = 16;

/* ─── Public API ───────────────────────────────────────────────────── */

export type ChartsHandle = {
  /**
   * `history` is the per-generation summary stream; `lastResults`
   * carries the *current* gen's per-car fitnesses for the histogram.
   * Pass `null` for lastResults outside an active gen.
   */
  update(history: GenerationStats[], lastResults?: Scored[] | null): void;
  setVisible(v: boolean): void;
  isVisible(): boolean;
};

export function mountCharts(host: HTMLElement): ChartsHandle {
  let lastHistory: GenerationStats[] = [];
  let lastResults: Scored[] | null = null;
  let windowSize: WindowSize = DEFAULT_WINDOW;
  let visible = !host.hasAttribute('hidden');

  /* ── Header (window selector) ─────────────────────────────────── */

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

  /* ── Section 1: Progress hero ─────────────────────────────────── */

  const hero = buildHero();
  host.appendChild(hero.el);

  /* ── Section 2: Distribution histogram ────────────────────────── */

  const histogram = buildHistogram();
  host.appendChild(histogram.el);

  /* ── Section 3: Genome trend sparklines ───────────────────────── */

  const genome = buildGenomeGrid();
  host.appendChild(genome.el);

  /* ── Render dispatch ──────────────────────────────────────────── */

  function applyWindow(history: GenerationStats[]): GenerationStats[] {
    if (windowSize === null || history.length <= windowSize) return history;
    return history.slice(history.length - windowSize);
  }

  function drawAll(): void {
    const empty = lastHistory.length === 0 && (!lastResults || lastResults.length === 0);
    if (empty) {
      hero.clear();
      histogram.clear();
      genome.clear();
      return;
    }
    const slice = applyWindow(lastHistory);
    hero.update(slice);
    histogram.update(lastResults);
    genome.update(slice);
  }

  updateSegmentedActive();
  drawAll();

  return {
    update(history, results = null): void {
      lastHistory = history;
      lastResults = results;
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

/* ─── Section 1: Progress hero ─────────────────────────────────────── */

type Hero = {
  el: HTMLElement;
  update(history: GenerationStats[]): void;
  clear(): void;
};

function buildHero(): Hero {
  const card = document.createElement('div');
  card.className = 'stats-card stats-card--hero';

  const title = document.createElement('h4');
  title.className = 'stats-card__title';
  title.setAttribute('data-i18n', 'stats.progress');
  title.textContent = t('stats.progress');
  card.appendChild(title);

  const valueRow = document.createElement('div');
  valueRow.className = 'stats-hero__values';
  const bestVal = makeBigStat('stats.progressBest', '#a8ff60');
  const meanVal = makeBigStat('stats.progressMean');
  valueRow.appendChild(bestVal.el);
  valueRow.appendChild(meanVal.el);
  card.appendChild(valueRow);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'stats-hero__chart');
  svg.setAttribute('viewBox', `0 0 ${HERO_W} ${HERO_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  // Y-axis grid lines (horizontal hairlines at 25/50/75% of range)
  for (let i = 0; i < 3; i++) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'stats-hero__grid');
    const y = ((i + 1) / 4) * HERO_H;
    line.setAttribute('x1', '0');
    line.setAttribute('x2', String(HERO_W));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    svg.appendChild(line);
  }

  const meanLine = document.createElementNS(SVG_NS, 'polyline');
  meanLine.setAttribute('class', 'stats-hero__line stats-hero__line--mean');
  meanLine.setAttribute('fill', 'none');
  meanLine.setAttribute('stroke', 'var(--color-fg-muted)');
  meanLine.setAttribute('stroke-width', '1.4');
  meanLine.setAttribute('stroke-linecap', 'round');
  meanLine.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(meanLine);

  const bestLine = document.createElementNS(SVG_NS, 'polyline');
  bestLine.setAttribute('class', 'stats-hero__line stats-hero__line--best');
  bestLine.setAttribute('fill', 'none');
  bestLine.setAttribute('stroke', '#a8ff60');
  bestLine.setAttribute('stroke-width', '1.8');
  bestLine.setAttribute('stroke-linecap', 'round');
  bestLine.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(bestLine);

  // Y-axis labels: max + min at the corners.
  const yMaxLabel = document.createElementNS(SVG_NS, 'text');
  yMaxLabel.setAttribute('class', 'stats-hero__axis');
  yMaxLabel.setAttribute('x', '4');
  yMaxLabel.setAttribute('y', '12');
  svg.appendChild(yMaxLabel);

  const yMinLabel = document.createElementNS(SVG_NS, 'text');
  yMinLabel.setAttribute('class', 'stats-hero__axis');
  yMinLabel.setAttribute('x', '4');
  yMinLabel.setAttribute('y', String(HERO_H - 4));
  svg.appendChild(yMinLabel);

  // Gen-range label (bottom-right)
  const genLabel = document.createElementNS(SVG_NS, 'text');
  genLabel.setAttribute('class', 'stats-hero__axis');
  genLabel.setAttribute('x', String(HERO_W - 4));
  genLabel.setAttribute('y', String(HERO_H - 4));
  genLabel.setAttribute('text-anchor', 'end');
  svg.appendChild(genLabel);

  card.appendChild(svg);

  function clear(): void {
    bestVal.value.textContent = '—';
    meanVal.value.textContent = '—';
    bestLine.setAttribute('points', '');
    meanLine.setAttribute('points', '');
    yMaxLabel.textContent = '';
    yMinLabel.textContent = '';
    genLabel.textContent = '';
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    const latest = history[history.length - 1]!;
    bestVal.value.textContent = `${latest.best.toFixed(1)} m`;
    meanVal.value.textContent = `${latest.mean.toFixed(1)} m`;

    // Shared Y-range across both series so they're visually
    // comparable.  Always anchor min at 0 so "improvement" reads as
    // "line goes up" without the floor sliding around.
    let max = 0;
    for (const h of history) {
      if (h.best > max) max = h.best;
    }
    if (max < 1) max = 1;

    const denom = Math.max(1, history.length - 1);
    let bestPts = '';
    let meanPts = '';
    for (let i = 0; i < history.length; i++) {
      const x = (i / denom) * HERO_W;
      const yBest = HERO_H - (history[i]!.best / max) * HERO_H;
      const yMean = HERO_H - (history[i]!.mean / max) * HERO_H;
      bestPts += `${x.toFixed(1)},${yBest.toFixed(1)} `;
      meanPts += `${x.toFixed(1)},${yMean.toFixed(1)} `;
    }
    bestLine.setAttribute('points', bestPts.trim());
    meanLine.setAttribute('points', meanPts.trim());

    yMaxLabel.textContent = `${max.toFixed(0)}m`;
    yMinLabel.textContent = '0';
    const firstGen = history[0]!.generation;
    const lastGen = latest.generation;
    genLabel.textContent =
      firstGen === lastGen ? `gen ${lastGen}` : `gen ${firstGen}–${lastGen}`;
  }

  return { el: card, update, clear };
}

function makeBigStat(
  i18nKey: TranslationKey,
  color?: string,
): { el: HTMLElement; value: HTMLSpanElement } {
  const el = document.createElement('div');
  el.className = 'stats-hero__big';
  const lab = document.createElement('span');
  lab.className = 'stats-hero__big-label';
  lab.setAttribute('data-i18n', i18nKey);
  lab.textContent = t(i18nKey);
  if (color) lab.style.setProperty('--big-accent', color);
  const value = document.createElement('span');
  value.className = 'stats-hero__big-value';
  if (color) value.style.color = color;
  value.textContent = '—';
  el.appendChild(lab);
  el.appendChild(value);
  return { el, value };
}

/* ─── Section 2: Distribution histogram ────────────────────────────── */

type Histogram = {
  el: HTMLElement;
  update(results: Scored[] | null): void;
  clear(): void;
};

function buildHistogram(): Histogram {
  const card = document.createElement('div');
  card.className = 'stats-card stats-card--hist';

  const head = document.createElement('div');
  head.className = 'stats-card__head';
  const title = document.createElement('h4');
  title.className = 'stats-card__title';
  title.setAttribute('data-i18n', 'stats.distribution');
  title.textContent = t('stats.distribution');
  head.appendChild(title);
  card.appendChild(head);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'stats-hist');
  svg.setAttribute('viewBox', `0 0 ${HIST_W} ${HIST_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const bars: SVGRectElement[] = [];
  const barW = HIST_W / HIST_BINS;
  for (let i = 0; i < HIST_BINS; i++) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('class', 'stats-hist__bar');
    r.setAttribute('x', String(i * barW + 1));
    r.setAttribute('width', String(barW - 2));
    r.setAttribute('y', String(HIST_H));
    r.setAttribute('height', '0');
    svg.appendChild(r);
    bars.push(r);
  }

  // X-axis labels: 0 on the left, max on the right
  const xMin = document.createElementNS(SVG_NS, 'text');
  xMin.setAttribute('class', 'stats-hist__axis');
  xMin.setAttribute('x', '4');
  xMin.setAttribute('y', String(HIST_H - 4));
  svg.appendChild(xMin);

  const xMax = document.createElementNS(SVG_NS, 'text');
  xMax.setAttribute('class', 'stats-hist__axis');
  xMax.setAttribute('x', String(HIST_W - 4));
  xMax.setAttribute('y', String(HIST_H - 4));
  xMax.setAttribute('text-anchor', 'end');
  svg.appendChild(xMax);

  card.appendChild(svg);

  function clear(): void {
    for (const r of bars) {
      r.setAttribute('height', '0');
      r.setAttribute('y', String(HIST_H));
    }
    xMin.textContent = '';
    xMax.textContent = '';
  }

  function update(results: Scored[] | null): void {
    if (!results || results.length === 0) {
      clear();
      return;
    }
    let max = 0;
    for (const r of results) {
      if (r.fitness > max) max = r.fitness;
    }
    // Round max up to a "nice" bin top so the bins align cleanly.
    const niceMax = max <= 0 ? 1 : Math.max(1, Math.ceil(max / HIST_BINS) * HIST_BINS);
    const bins = new Array<number>(HIST_BINS).fill(0);
    for (const r of results) {
      const idx = Math.min(HIST_BINS - 1, Math.floor((r.fitness / niceMax) * HIST_BINS));
      bins[idx] = (bins[idx] ?? 0) + 1;
    }
    let peak = 1;
    for (const c of bins) if (c > peak) peak = c;
    for (let i = 0; i < HIST_BINS; i++) {
      const count = bins[i] ?? 0;
      const h = (count / peak) * (HIST_H - 14);
      bars[i]!.setAttribute('y', String(HIST_H - h));
      bars[i]!.setAttribute('height', String(h));
    }
    xMin.textContent = '0';
    xMax.textContent = `${niceMax.toFixed(0)}m`;
  }

  return { el: card, update, clear };
}

/* ─── Section 3: Genome trend sparklines ───────────────────────────── */

type GenomeGrid = {
  el: HTMLElement;
  update(history: GenerationStats[]): void;
  clear(): void;
};

type SparkCell = {
  value: HTMLSpanElement;
  polyline: SVGPolylineElement;
  def: GenomeDef;
};

function buildGenomeGrid(): GenomeGrid {
  const card = document.createElement('div');
  card.className = 'stats-card stats-card--genome';

  const title = document.createElement('h4');
  title.className = 'stats-card__title';
  title.setAttribute('data-i18n', 'stats.genome');
  title.textContent = t('stats.genome');
  card.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'stats-genome__grid';
  card.appendChild(grid);

  const cells: SparkCell[] = GENOME_DEFS.map((def) => {
    const cell = document.createElement('div');
    cell.className = 'stats-genome__cell';
    const head = document.createElement('div');
    head.className = 'stats-genome__head';
    const cellTitle = document.createElement('span');
    cellTitle.className = 'stats-genome__title';
    cellTitle.setAttribute('data-i18n', def.i18nKey);
    cellTitle.textContent = t(def.i18nKey);
    const cellVal = document.createElement('span');
    cellVal.className = 'stats-genome__value';
    cellVal.textContent = '—';
    head.appendChild(cellTitle);
    head.appendChild(cellVal);
    cell.appendChild(head);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'stats-genome__spark');
    svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const polyline = document.createElementNS(SVG_NS, 'polyline');
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', 'var(--color-fg-muted)');
    polyline.setAttribute('stroke-width', '1.4');
    polyline.setAttribute('stroke-linecap', 'round');
    polyline.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(polyline);
    cell.appendChild(svg);

    grid.appendChild(cell);
    return { value: cellVal, polyline, def };
  });

  function clear(): void {
    for (const c of cells) {
      c.value.textContent = '—';
      c.polyline.setAttribute('points', '');
    }
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    const latest = history[history.length - 1]!;
    for (const cell of cells) {
      const cur = latest[cell.def.key] as number;
      cell.value.textContent = cell.def.format(cur);
      const series = history.map((h) => h[cell.def.key] as number);
      renderSparkline(cell.polyline, series);
    }
  }

  return { el: card, update, clear };
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
