/**
 * Stats panel — three-section dashboard mounted as a floating card.
 *
 *   1. Progress hero — combined "best vs mean" line chart over the
 *      windowed history, with big current-value readouts.  The single
 *      most useful view for "is the GA actually getting better?".
 *   2. Genome trends — compact sparkline grid for the average genome
 *      stats (chassis verts, wheel count, wheel power, motor speed,
 *      chassis density, chassis size).
 *
 * The window selector in the header (50 / 100 / 200 / All) clamps how
 * many recent generations the progress hero + genome sparklines look
 * at.
 *
 * Adding a new genome-trend chart is one line in `GENOME_DEFS`.
 *
 * Layout note: axis labels live in HTML (positioned absolutely over
 * the SVG) rather than inside the SVG.  Reason: the SVGs use
 * `preserveAspectRatio="none"` so polylines stretch to fill card
 * width, but that scaling would distort `<text>` elements (visible
 * as the "horizontally stretched" labels in v1.15.x).  HTML text
 * stays at its CSS-controlled font-size regardless of the SVG's
 * non-uniform stretch.
 */

import { t, type TranslationKey } from '../i18n';
import type { GenerationStats } from './collector';

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

// Internal viewBox sizes — actual on-screen width/height comes from
// the CSS (`max-width` + aspect-ratio).  Keep these proportional to
// the rendered aspect so the polyline/bar geometry doesn't get
// stretched too far in either direction even before CSS clamps width.
const HERO_W = 600;
const HERO_H = 200;
const SPARK_W = 160;
const SPARK_H = 44;

/* ─── Public API ───────────────────────────────────────────────────── */

export type ChartsHandle = {
  /** `history` is the per-generation summary stream. */
  update(history: GenerationStats[]): void;
  setVisible(v: boolean): void;
  isVisible(): boolean;
  /** Show / hide the speed-mode "Best finish time" chart. */
  setSpeedMode(on: boolean): void;
};

export function mountCharts(host: HTMLElement): ChartsHandle {
  let lastHistory: GenerationStats[] = [];
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

  /* ── Body grid (hero + hist side-by-side, genome below) ───────── */

  const body = document.createElement('div');
  body.className = 'stats-panel__body';
  host.appendChild(body);

  const hero = buildHero();
  body.appendChild(hero.el);

  const speed = buildSpeedChart();
  body.appendChild(speed.el);
  speed.el.hidden = true;

  const genome = buildGenomeGrid();
  body.appendChild(genome.el);

  /* ── Render dispatch ──────────────────────────────────────────── */

  function applyWindow(history: GenerationStats[]): GenerationStats[] {
    if (windowSize === null || history.length <= windowSize) return history;
    return history.slice(history.length - windowSize);
  }

  function drawAll(): void {
    if (lastHistory.length === 0) {
      hero.clear();
      speed.clear();
      genome.clear();
      return;
    }
    const slice = applyWindow(lastHistory);
    hero.update(slice);
    speed.update(slice);
    genome.update(slice);
  }

  updateSegmentedActive();
  drawAll();

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
    setSpeedMode(on: boolean): void {
      speed.el.hidden = !on;
      // Toggle a class on the panel root so the body grid can
      // re-area the layout (speed card sits next to hero when shown,
      // collapses out of the layout when hidden).
      host.classList.toggle('charts-panel--speed-mode', on);
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

  // Chart wrap: SVG + DOM-positioned axis labels.  The SVG stretches
  // freely (`preserveAspectRatio="none"`) so the polyline always fits
  // the card width; the labels are CSS-positioned HTML so their text
  // stays crisp regardless of the stretch.
  const wrap = document.createElement('div');
  wrap.className = 'stats-hero__wrap';

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
  meanLine.setAttribute('vector-effect', 'non-scaling-stroke');
  meanLine.setAttribute('stroke-linecap', 'round');
  meanLine.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(meanLine);

  const bestLine = document.createElementNS(SVG_NS, 'polyline');
  bestLine.setAttribute('class', 'stats-hero__line stats-hero__line--best');
  bestLine.setAttribute('fill', 'none');
  bestLine.setAttribute('stroke', '#a8ff60');
  bestLine.setAttribute('stroke-width', '2');
  bestLine.setAttribute('vector-effect', 'non-scaling-stroke');
  bestLine.setAttribute('stroke-linecap', 'round');
  bestLine.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(bestLine);

  wrap.appendChild(svg);

  // HTML axis labels — positioned absolute over the SVG, so they
  // never inherit the SVG's stretch.  yMax sits top-left, yMin
  // bottom-left, gen-range bottom-right.
  const yMaxLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--y-top');
  const yMinLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--y-bot');
  const genLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--x-end');
  wrap.appendChild(yMaxLabel);
  wrap.appendChild(yMinLabel);
  wrap.appendChild(genLabel);

  // Hover overlay: vertical hairline + tooltip that follows the
  // cursor across the chart and reads back exact best/mean values
  // for whichever generation it's pointing at.  Hidden until first
  // mousemove, hidden again on mouseleave.
  const hairline = document.createElement('div');
  hairline.className = 'stats-hero__hairline';
  hairline.hidden = true;
  wrap.appendChild(hairline);
  const tooltip = document.createElement('div');
  tooltip.className = 'stats-hero__tooltip';
  tooltip.hidden = true;
  wrap.appendChild(tooltip);

  let currentSlice: GenerationStats[] = [];

  wrap.addEventListener('mousemove', (e) => {
    if (currentSlice.length === 0) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (currentSlice.length - 1));
    const gen = currentSlice[idx];
    if (!gen) return;
    const xPct = currentSlice.length > 1 ? (idx / (currentSlice.length - 1)) * 100 : 50;
    hairline.style.left = `${xPct}%`;
    hairline.hidden = false;
    tooltip.hidden = false;
    tooltip.replaceChildren(
      tooltipRow('stats-hero__tooltip-gen', `пок. #${gen.generation}`),
      tooltipRow(
        'stats-hero__tooltip-row stats-hero__tooltip-row--best',
        `${t('stats.progressBest')} · ${gen.best.toFixed(1)} м`,
      ),
      tooltipRow(
        'stats-hero__tooltip-row',
        `${t('stats.progressMean')} · ${gen.mean.toFixed(1)} м`,
      ),
    );
    // Position the tooltip near the cursor, clamped to the wrap so
    // it never escapes the card's right or left edge.
    const cursorX = e.clientX - rect.left;
    const tooltipW = tooltip.offsetWidth || 160;
    let leftPx = cursorX + 14;
    if (leftPx + tooltipW > rect.width - 4) leftPx = cursorX - 14 - tooltipW;
    if (leftPx < 4) leftPx = 4;
    tooltip.style.left = `${leftPx}px`;
  });
  wrap.addEventListener('mouseleave', () => {
    hairline.hidden = true;
    tooltip.hidden = true;
  });

  card.appendChild(wrap);

  function clear(): void {
    bestVal.value.textContent = '—';
    meanVal.value.textContent = '—';
    bestLine.setAttribute('points', '');
    meanLine.setAttribute('points', '');
    yMaxLabel.textContent = '';
    yMinLabel.textContent = '';
    genLabel.textContent = '';
    currentSlice = [];
    hairline.hidden = true;
    tooltip.hidden = true;
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    const latest = history[history.length - 1]!;
    bestVal.value.textContent = `${latest.best.toFixed(1)} м`;
    meanVal.value.textContent = `${latest.mean.toFixed(1)} м`;

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

    yMaxLabel.textContent = `${max.toFixed(0)}м`;
    yMinLabel.textContent = '0';
    const firstGen = history[0]!.generation;
    const lastGen = latest.generation;
    genLabel.textContent =
      firstGen === lastGen ? `пок. ${lastGen}` : `пок. ${firstGen}–${lastGen}`;
    currentSlice = history;
  }

  return { el: card, update, clear };
}

function tooltipRow(className: string, text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  return div;
}

/* ─── Section 1b: Speed-mode chart (best finish time per gen) ─────── */

type Speed = {
  el: HTMLElement;
  update(history: GenerationStats[]): void;
  clear(): void;
};

function buildSpeedChart(): Speed {
  const card = document.createElement('div');
  card.className = 'stats-card stats-card--speed';

  const title = document.createElement('h4');
  title.className = 'stats-card__title';
  title.setAttribute('data-i18n', 'stats.speed');
  title.textContent = t('stats.speed');
  card.appendChild(title);

  const valueRow = document.createElement('div');
  valueRow.className = 'stats-hero__values';
  const bestVal = makeBigStat('stats.speedBest', '#a8ff60');
  valueRow.appendChild(bestVal.el);
  card.appendChild(valueRow);

  const wrap = document.createElement('div');
  wrap.className = 'stats-hero__wrap';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'stats-hero__chart');
  svg.setAttribute('viewBox', `0 0 ${HERO_W} ${HERO_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

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

  // One polyline per contiguous run of finished gens.  Gens with no
  // finishers (bestFinishTime=null) split the line so the chart
  // shows gaps where the GA hadn't cracked the track yet.  In
  // practice the line is usually one segment after the first finish.
  const linesGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(linesGroup);

  wrap.appendChild(svg);

  const yMaxLabel = document.createElement('span');
  yMaxLabel.className = 'stats-hero__axis stats-hero__axis--y-top';
  const yMinLabel = document.createElement('span');
  yMinLabel.className = 'stats-hero__axis stats-hero__axis--y-bot';
  const genLabel = document.createElement('span');
  genLabel.className = 'stats-hero__axis stats-hero__axis--x-end';
  wrap.appendChild(yMaxLabel);
  wrap.appendChild(yMinLabel);
  wrap.appendChild(genLabel);

  // Hover overlay (same pattern as the hero chart): hairline +
  // tooltip showing exact finish time at the hovered generation.
  // Tooltip skips gens with no finisher (bestFinishTime === null)
  // and shows "no finishers" instead.
  const hairline = document.createElement('div');
  hairline.className = 'stats-hero__hairline';
  hairline.hidden = true;
  wrap.appendChild(hairline);
  const tooltip = document.createElement('div');
  tooltip.className = 'stats-hero__tooltip';
  tooltip.hidden = true;
  wrap.appendChild(tooltip);

  let currentSlice: GenerationStats[] = [];

  wrap.addEventListener('mousemove', (e) => {
    if (currentSlice.length === 0) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (currentSlice.length - 1));
    const gen = currentSlice[idx];
    if (!gen) return;
    const xPct = currentSlice.length > 1 ? (idx / (currentSlice.length - 1)) * 100 : 50;
    hairline.style.left = `${xPct}%`;
    hairline.hidden = false;
    tooltip.hidden = false;
    const valueRow =
      gen.bestFinishTime !== null
        ? tooltipRow(
            'stats-hero__tooltip-row stats-hero__tooltip-row--best',
            `${t('stats.speedBest')} · ${gen.bestFinishTime.toFixed(2)} s`,
          )
        : tooltipRow('stats-hero__tooltip-row', '—');
    tooltip.replaceChildren(
      tooltipRow('stats-hero__tooltip-gen', `пок. #${gen.generation}`),
      valueRow,
    );
    const cursorX = e.clientX - rect.left;
    const tooltipW = tooltip.offsetWidth || 160;
    let leftPx = cursorX + 14;
    if (leftPx + tooltipW > rect.width - 4) leftPx = cursorX - 14 - tooltipW;
    if (leftPx < 4) leftPx = 4;
    tooltip.style.left = `${leftPx}px`;
  });
  wrap.addEventListener('mouseleave', () => {
    hairline.hidden = true;
    tooltip.hidden = true;
  });

  card.appendChild(wrap);

  function clearPolylines(): void {
    while (linesGroup.firstChild) linesGroup.removeChild(linesGroup.firstChild);
  }

  function clear(): void {
    bestVal.value.textContent = '—';
    clearPolylines();
    yMaxLabel.textContent = '';
    yMinLabel.textContent = '';
    genLabel.textContent = '';
    currentSlice = [];
    hairline.hidden = true;
    tooltip.hidden = true;
  }

  function update(history: GenerationStats[]): void {
    clearPolylines();
    if (history.length === 0) {
      clear();
      return;
    }

    // Latest readout: the most recent gen that had a finish, or
    // "—" if no gen on the chart had any finisher.
    let latestWithFinish: GenerationStats | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.bestFinishTime !== null) {
        latestWithFinish = history[i]!;
        break;
      }
    }
    bestVal.value.textContent =
      latestWithFinish !== null ? `${latestWithFinish.bestFinishTime!.toFixed(2)} s` : '—';

    // Y range: anchor at 0 (instant finish), top = max finish time
    // we've seen.  Lower line = better (faster).
    let maxT = 0;
    for (const h of history) {
      if (h.bestFinishTime !== null && h.bestFinishTime > maxT) maxT = h.bestFinishTime;
    }
    if (maxT < 1) maxT = 1;

    const denom = Math.max(1, history.length - 1);
    // Walk the history in order, accumulating points into segments.
    // A null bestFinishTime breaks the line: flush the current
    // segment as a polyline, start a new one on the next finish.
    let pts = '';
    let pointsInSegment = 0;
    const flush = (): void => {
      if (pointsInSegment > 0) {
        const line = document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('class', 'stats-hero__line stats-hero__line--best');
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', '#a8ff60');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('stroke-linejoin', 'round');
        line.setAttribute('points', pts.trim());
        linesGroup.appendChild(line);
      }
      pts = '';
      pointsInSegment = 0;
    };
    for (let i = 0; i < history.length; i++) {
      const h = history[i]!;
      if (h.bestFinishTime === null) {
        flush();
        continue;
      }
      const x = (i / denom) * HERO_W;
      const y = HERO_H - (h.bestFinishTime / maxT) * HERO_H;
      pts += `${x.toFixed(1)},${y.toFixed(1)} `;
      pointsInSegment++;
    }
    flush();

    yMaxLabel.textContent = `${maxT.toFixed(2)} s`;
    yMinLabel.textContent = '0';
    const firstGen = history[0]!.generation;
    const lastGen = history[history.length - 1]!.generation;
    genLabel.textContent =
      firstGen === lastGen ? `пок. ${lastGen}` : `пок. ${firstGen}–${lastGen}`;
    currentSlice = history;
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

function makeAxisLabel(className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  return span;
}

/* ─── Section 2: Genome trend sparklines ───────────────────────────── */

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
    polyline.setAttribute('vector-effect', 'non-scaling-stroke');
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
