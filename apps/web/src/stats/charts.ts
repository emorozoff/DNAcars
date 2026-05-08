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

  /* ── Body grid (hero on top, then secondary metrics, then genome) ─ */

  const body = document.createElement('div');
  body.className = 'stats-panel__body';
  host.appendChild(body);

  const hero = buildHero();
  body.appendChild(hero.el);

  const speed = buildSpeedChart();
  body.appendChild(speed.el);
  speed.el.hidden = true;

  const finishDist = buildFinishDistribution();
  body.appendChild(finishDist.el);
  finishDist.el.hidden = true;

  const insights = buildInsights();
  body.appendChild(insights.el);

  const stallMap = buildStallHeatmap();
  body.appendChild(stallMap.el);

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
      finishDist.clear();
      insights.clear();
      stallMap.clear();
      genome.clear();
      return;
    }
    const slice = applyWindow(lastHistory);
    hero.update(slice);
    speed.update(slice);
    finishDist.update(slice);
    insights.update(slice);
    stallMap.update(slice);
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
      // The finish-time distribution (per-gen min/median/max for
      // finishers) is only meaningful when speed mode is on — outside
      // it, finish-times still get recorded but the chart focus stays
      // on travel distance.  Hide alongside the hero speed card.
      finishDist.el.hidden = !on;
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

    // Don't render axis labels when no gen has produced a finish
    // yet — the y range is just the placeholder "1 s" default and
    // showing "1.00 s" up there reads as if a record was set, which
    // it wasn't.  Once any gen has a finisher, real labels appear.
    if (latestWithFinish !== null) {
      yMaxLabel.textContent = `${maxT.toFixed(2)} s`;
      yMinLabel.textContent = '0';
    } else {
      yMaxLabel.textContent = '';
      yMinLabel.textContent = '';
    }
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

/* ─── Section 3: Insights — cumulative records + elite age ─────────── */

type Insights = {
  el: HTMLElement;
  update(history: GenerationStats[]): void;
  clear(): void;
};

/** Walk history and produce per-gen "cumulative record-breaks" +
 *  "consecutive gens without a record-break" series.  Both series are
 *  derived from `best`: a record breaks when `best > runningMax`. */
function deriveInsightSeries(history: GenerationStats[]): {
  cumRecords: number[];
  eliteAge: number[];
} {
  const cumRecords: number[] = [];
  const eliteAge: number[] = [];
  let runningMax = -Infinity;
  let breaks = 0;
  let age = 0;
  // 0.5 m epsilon: in strict-det the elite carries `best` exactly,
  // but in non-strict-det the multi-body world has FP noise that
  // jitters `best` by a few centimetres run-to-run.  Half a metre is
  // far above the noise floor and well below any real overtake.
  const EPS = 0.5;
  for (const h of history) {
    if (h.best > runningMax + EPS) {
      runningMax = h.best;
      breaks += 1;
      age = 1;
    } else {
      age += 1;
    }
    cumRecords.push(breaks);
    eliteAge.push(age);
  }
  return { cumRecords, eliteAge };
}

function buildInsights(): Insights {
  const card = document.createElement('div');
  card.className = 'stats-card stats-card--insights';

  const title = document.createElement('h4');
  title.className = 'stats-card__title';
  title.setAttribute('data-i18n', 'stats.insights');
  title.textContent = t('stats.insights');
  card.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'stats-insights__grid';
  card.appendChild(grid);

  const cumCell = makeInsightCell('chart.cumRecords');
  const ageCell = makeInsightCell('chart.eliteAge');
  grid.appendChild(cumCell.el);
  grid.appendChild(ageCell.el);

  function clear(): void {
    cumCell.value.textContent = '—';
    cumCell.polyline.setAttribute('points', '');
    ageCell.value.textContent = '—';
    ageCell.polyline.setAttribute('points', '');
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    const { cumRecords, eliteAge } = deriveInsightSeries(history);
    cumCell.value.textContent = String(cumRecords[cumRecords.length - 1] ?? 0);
    renderSparkline(cumCell.polyline, cumRecords);
    ageCell.value.textContent = String(eliteAge[eliteAge.length - 1] ?? 0);
    renderSparkline(ageCell.polyline, eliteAge);
  }

  return { el: card, update, clear };
}

function makeInsightCell(i18nKey: TranslationKey): {
  el: HTMLElement;
  value: HTMLSpanElement;
  polyline: SVGPolylineElement;
} {
  const cell = document.createElement('div');
  cell.className = 'stats-genome__cell';
  const head = document.createElement('div');
  head.className = 'stats-genome__head';
  const titleEl = document.createElement('span');
  titleEl.className = 'stats-genome__title';
  titleEl.setAttribute('data-i18n', i18nKey);
  titleEl.textContent = t(i18nKey);
  const val = document.createElement('span');
  val.className = 'stats-genome__value';
  val.textContent = '—';
  head.appendChild(titleEl);
  head.appendChild(val);
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

  return { el: cell, value: val, polyline };
}

/* ─── Section 4: Stall heatmap — where on the track cars stop ──────── */

type StallMap = {
  el: HTMLElement;
  update(history: GenerationStats[]): void;
  clear(): void;
};

const STALL_BINS = 32;

function buildStallHeatmap(): StallMap {
  const card = document.createElement('div');
  card.className = 'stats-card stats-card--stall';

  const title = document.createElement('h4');
  title.className = 'stats-card__title';
  title.setAttribute('data-i18n', 'stats.stallMap');
  title.textContent = t('stats.stallMap');
  card.appendChild(title);

  const wrap = document.createElement('div');
  wrap.className = 'stats-stall__wrap';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'stats-stall');
  svg.setAttribute('viewBox', `0 0 ${HERO_W} 80`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const bars: SVGRectElement[] = [];
  const slot = HERO_W / STALL_BINS;
  const gap = slot * 0.12;
  for (let i = 0; i < STALL_BINS; i++) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('class', 'stats-stall__bar');
    r.setAttribute('x', String(i * slot + gap / 2));
    r.setAttribute('width', String(slot - gap));
    r.setAttribute('y', '80');
    r.setAttribute('height', '0');
    svg.appendChild(r);
    bars.push(r);
  }

  const baseline = document.createElementNS(SVG_NS, 'line');
  baseline.setAttribute('class', 'stats-stall__baseline');
  baseline.setAttribute('x1', '0');
  baseline.setAttribute('x2', String(HERO_W));
  baseline.setAttribute('y1', '79');
  baseline.setAttribute('y2', '79');
  baseline.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(baseline);

  wrap.appendChild(svg);

  const xStart = makeAxisLabel('stats-stall__axis stats-stall__axis--start');
  xStart.textContent = '0';
  const xEnd = makeAxisLabel('stats-stall__axis stats-stall__axis--end');
  wrap.appendChild(xStart);
  wrap.appendChild(xEnd);

  card.appendChild(wrap);

  function clear(): void {
    for (const b of bars) {
      b.setAttribute('height', '0');
      b.setAttribute('y', '80');
    }
    xEnd.textContent = '';
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    // Aggregate stall positions across the entire windowed history
    // — single-gen samples are bimodal (elites at far end, the rest
    // bunched near spawn) and don't reveal track-section difficulty
    // very well.  Summing across 50-200 gens smooths the noise into
    // a clean "trouble-spot" silhouette.
    const trackLength = history[history.length - 1]?.trackLength ?? 0;
    if (trackLength <= 0) {
      clear();
      return;
    }
    const counts = new Array<number>(STALL_BINS).fill(0);
    for (const h of history) {
      if (h.trackLength <= 0) continue;
      for (const tr of h.travels) {
        const frac = Math.max(0, Math.min(0.999, tr / h.trackLength));
        const bin = Math.min(STALL_BINS - 1, Math.floor(frac * STALL_BINS));
        counts[bin] = (counts[bin] ?? 0) + 1;
      }
    }
    let peak = 1;
    for (const c of counts) if (c > peak) peak = c;
    for (let i = 0; i < STALL_BINS; i++) {
      const count = counts[i] ?? 0;
      const h = (count / peak) * (80 - 2);
      bars[i]!.setAttribute('y', String(80 - h));
      bars[i]!.setAttribute('height', String(h));
    }
    xEnd.textContent = `${trackLength.toFixed(0)}м`;
  }

  return { el: card, update, clear };
}

/* ─── Section 5: Finish-time distribution (speed-mode only) ────────── */

type FinishDist = {
  el: HTMLElement;
  update(history: GenerationStats[]): void;
  clear(): void;
};

const FINISH_DIST_W = 600;
const FINISH_DIST_H = 160;

function buildFinishDistribution(): FinishDist {
  const card = document.createElement('div');
  card.className = 'stats-card stats-card--finish-dist';

  const title = document.createElement('h4');
  title.className = 'stats-card__title';
  title.setAttribute('data-i18n', 'stats.finishDist');
  title.textContent = t('stats.finishDist');
  card.appendChild(title);

  const wrap = document.createElement('div');
  wrap.className = 'stats-finish-dist__wrap';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'stats-finish-dist');
  svg.setAttribute('viewBox', `0 0 ${FINISH_DIST_W} ${FINISH_DIST_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  // Three polylines: min (fastest), median, max (slowest finisher).
  // Filled band between min and max behind them for at-a-glance
  // "spread" reading.
  const band = document.createElementNS(SVG_NS, 'polygon');
  band.setAttribute('class', 'stats-finish-dist__band');
  svg.appendChild(band);
  const minLine = document.createElementNS(SVG_NS, 'polyline');
  minLine.setAttribute('class', 'stats-finish-dist__line stats-finish-dist__line--min');
  minLine.setAttribute('fill', 'none');
  minLine.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(minLine);
  const medLine = document.createElementNS(SVG_NS, 'polyline');
  medLine.setAttribute('class', 'stats-finish-dist__line stats-finish-dist__line--med');
  medLine.setAttribute('fill', 'none');
  medLine.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(medLine);
  const maxLine = document.createElementNS(SVG_NS, 'polyline');
  maxLine.setAttribute('class', 'stats-finish-dist__line stats-finish-dist__line--max');
  maxLine.setAttribute('fill', 'none');
  maxLine.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(maxLine);

  wrap.appendChild(svg);

  const yTop = makeAxisLabel('stats-hero__axis stats-hero__axis--y-top');
  const yBot = makeAxisLabel('stats-hero__axis stats-hero__axis--y-bot');
  wrap.appendChild(yTop);
  wrap.appendChild(yBot);

  card.appendChild(wrap);

  function clear(): void {
    band.setAttribute('points', '');
    minLine.setAttribute('points', '');
    medLine.setAttribute('points', '');
    maxLine.setAttribute('points', '');
    yTop.textContent = '';
    yBot.textContent = '';
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    // For each gen, compute (min, median, max) of the finishers.
    // Generations with zero finishers contribute null and are
    // skipped from the polylines (lines have a gap).
    type Triple = { gen: number; lo: number; med: number; hi: number };
    const points: Triple[] = [];
    for (let i = 0; i < history.length; i++) {
      const h = history[i]!;
      if (h.finishTimes.length === 0) continue;
      const sorted = [...h.finishTimes].sort((a, b) => a - b);
      const lo = sorted[0]!;
      const hi = sorted[sorted.length - 1]!;
      const med = sorted[Math.floor(sorted.length / 2)]!;
      points.push({ gen: i, lo, med, hi });
    }
    if (points.length === 0) {
      clear();
      return;
    }
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const p of points) {
      if (p.lo < yMin) yMin = p.lo;
      if (p.hi > yMax) yMax = p.hi;
    }
    const yRange = yMax - yMin || 1;
    const xDenom = history.length - 1 || 1;
    const project = (gen: number, t: number): [number, number] => [
      (gen / xDenom) * FINISH_DIST_W,
      FINISH_DIST_H - ((t - yMin) / yRange) * FINISH_DIST_H,
    ];

    let minPts = '';
    let medPts = '';
    let maxPts = '';
    let upper = '';
    let lower = '';
    for (const p of points) {
      const [x, ylo] = project(p.gen, p.lo);
      const [, ymed] = project(p.gen, p.med);
      const [, yhi] = project(p.gen, p.hi);
      minPts += `${x.toFixed(1)},${ylo.toFixed(1)} `;
      medPts += `${x.toFixed(1)},${ymed.toFixed(1)} `;
      maxPts += `${x.toFixed(1)},${yhi.toFixed(1)} `;
      upper += `${x.toFixed(1)},${ylo.toFixed(1)} `;
      lower = `${x.toFixed(1)},${yhi.toFixed(1)} ` + lower;
    }
    minLine.setAttribute('points', minPts.trim());
    medLine.setAttribute('points', medPts.trim());
    maxLine.setAttribute('points', maxPts.trim());
    band.setAttribute('points', `${upper.trim()} ${lower.trim()}`);
    yTop.textContent = `${yMin.toFixed(1)}с`;
    yBot.textContent = `${yMax.toFixed(1)}с`;
  }

  return { el: card, update, clear };
}
