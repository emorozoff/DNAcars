/**
 * Stats panel — a floating, scrollable charts window.
 *
 * The window is a fixed-position overlay (so it can never be clipped
 * by the dock / grid rows) with its own internal scroll.  It holds a
 * stack of chart cards:
 *
 *   - Progress hero — combined "best vs mean" line chart.
 *   - Best finish time — fastest finisher per generation.
 *   - Insights — records-broken / champion-age / finish-rate sparklines.
 *   - Car traits — average-genome sparkline grid.
 *
 * Every card can be collapsed (click its header) and reordered (drag
 * the grip handle).  Both bits of state persist to localStorage.
 * Every chart reacts to the mouse: a hairline + readout follows the
 * cursor and reports the exact value at the hovered generation.
 *
 * The same window is used at every sim speed and in every mode — there
 * is no speed-mode-specific layout.
 *
 * Layout note: axis labels live in HTML (positioned absolutely over
 * the SVG) rather than inside the SVG.  The SVGs use
 * `preserveAspectRatio="none"` so polylines stretch to fill card
 * width; that scaling would distort `<text>` elements, so HTML text
 * (at a fixed CSS font-size) is used instead.
 */

import { t, type TranslationKey } from '../i18n';
import type { GenerationStats } from './collector';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LAYOUT_KEY = 'dnacars.charts.layout';

/* ─── Header window selector ───────────────────────────────────────── */

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
  {
    key: 'avgWheelRadius',
    i18nKey: 'chart.avgWheelRadius',
    format: (v) => `${v.toFixed(2)} m`,
  },
];

/* ─── Layout constants ─────────────────────────────────────────────── */

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
};

/** One chart card's renderable content + its update hooks.  The card
 *  shell (header, collapse, drag) is added by mountCharts. */
type ChartCard = {
  content: HTMLElement;
  update(history: GenerationStats[]): void;
  clear(): void;
};

type CardDef = { id: string; titleKey: TranslationKey; card: ChartCard };

type Layout = { order: string[]; collapsed: string[] };

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Layout>;
      return {
        order: Array.isArray(parsed.order) ? parsed.order.map(String) : [],
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.map(String) : [],
      };
    }
  } catch {
    /* corrupt / unavailable storage — fall through to defaults */
  }
  return { order: [], collapsed: [] };
}

function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* storage full / disabled — layout just won't persist */
  }
}

export function mountCharts(host: HTMLElement): ChartsHandle {
  let lastHistory: GenerationStats[] = [];
  let windowSize: WindowSize = DEFAULT_WINDOW;
  let visible = !host.hasAttribute('hidden');

  host.classList.add('charts-panel');

  /* ── Header: title · window selector · close ──────────────────── */

  const header = document.createElement('div');
  header.className = 'charts-panel__header';

  const titleEl = document.createElement('h3');
  titleEl.className = 'charts-panel__title';
  titleEl.setAttribute('data-i18n', 'charts.title');
  titleEl.textContent = t('charts.title');

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

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'charts-panel__close';
  closeBtn.setAttribute('aria-label', t('charts.close'));
  closeBtn.setAttribute('data-i18n-title', 'charts.close');
  closeBtn.setAttribute('title', t('charts.close'));
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => setVisible(false));

  header.appendChild(titleEl);
  header.appendChild(seg);
  header.appendChild(closeBtn);
  host.appendChild(header);

  /* ── Scrollable body holding the card stack ───────────────────── */

  const body = document.createElement('div');
  body.className = 'charts-panel__body';
  host.appendChild(body);

  const defs: CardDef[] = [
    { id: 'hero', titleKey: 'stats.progress', card: buildHero() },
    { id: 'speed', titleKey: 'stats.speed', card: buildSpeedChart() },
    { id: 'insights', titleKey: 'stats.insights', card: buildInsights() },
    { id: 'genome', titleKey: 'stats.genome', card: buildGenomeGrid() },
  ];

  const layout = loadLayout();

  /* ── Drag-to-reorder (pointer-based, from the grip handle) ─────── */

  let dragEl: HTMLElement | null = null;

  function persist(): void {
    const cards = [...body.querySelectorAll<HTMLElement>('.chart-card')];
    saveLayout({
      order: cards.map((c) => c.dataset['card'] ?? ''),
      collapsed: cards
        .filter((c) => c.classList.contains('chart-card--collapsed'))
        .map((c) => c.dataset['card'] ?? ''),
    });
  }

  function attachDrag(grip: HTMLElement, section: HTMLElement): void {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragEl = section;
      section.classList.add('chart-card--dragging');
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragEl) return;
      // Find the sibling the cursor is currently over and slot the
      // dragged card before / after it depending on which half.
      for (const c of body.querySelectorAll<HTMLElement>('.chart-card')) {
        if (c === dragEl) continue;
        const r = c.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          const before = e.clientY < r.top + r.height / 2;
          body.insertBefore(dragEl, before ? c : c.nextSibling);
          break;
        }
      }
    });
    const end = (e: PointerEvent): void => {
      if (!dragEl) return;
      dragEl.classList.remove('chart-card--dragging');
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      dragEl = null;
      persist();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /* ── Wrap each card in a collapsible / draggable shell ─────────── */

  type Mounted = { id: string; el: HTMLElement; card: ChartCard };
  const mounted: Mounted[] = defs.map((def) => {
    const section = document.createElement('section');
    section.className = 'chart-card';
    section.dataset['card'] = def.id;

    const head = document.createElement('header');
    head.className = 'chart-card__head';

    const grip = document.createElement('span');
    grip.className = 'chart-card__grip';
    grip.setAttribute('aria-hidden', 'true');

    const cardTitle = document.createElement('h4');
    cardTitle.className = 'chart-card__title';
    cardTitle.setAttribute('data-i18n', def.titleKey);
    cardTitle.textContent = t(def.titleKey);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chart-card__toggle';
    toggle.setAttribute('aria-label', t('charts.collapse'));
    toggle.setAttribute('data-i18n-title', 'charts.collapse');
    toggle.setAttribute('title', t('charts.collapse'));
    toggle.textContent = '▾';

    head.appendChild(grip);
    head.appendChild(cardTitle);
    head.appendChild(toggle);

    const cardBody = document.createElement('div');
    cardBody.className = 'chart-card__body';
    cardBody.appendChild(def.card.content);

    section.appendChild(head);
    section.appendChild(cardBody);

    // Click anywhere on the header (except the grip — that's the drag
    // handle) toggles the card collapsed.  A click that lands on the
    // grip after a drag is dispatched to the grip itself (pointer
    // capture), so the guard reliably ignores drag-end clicks.
    head.addEventListener('click', (e) => {
      if (e.target === grip) return;
      section.classList.toggle('chart-card--collapsed');
      persist();
    });

    if (layout.collapsed.includes(def.id)) {
      section.classList.add('chart-card--collapsed');
    }

    attachDrag(grip, section);

    return { id: def.id, el: section, card: def.card };
  });

  // Apply the saved order: known ids first in their stored order, then
  // any cards the saved layout didn't mention (e.g. a newly added
  // chart) appended at the end.
  const ordered: Mounted[] = [
    ...layout.order
      .map((id) => mounted.find((m) => m.id === id))
      .filter((m): m is Mounted => m !== undefined),
    ...mounted.filter((m) => !layout.order.includes(m.id)),
  ];
  for (const m of ordered) body.appendChild(m.el);

  /* ── Render dispatch ──────────────────────────────────────────── */

  function applyWindow(history: GenerationStats[]): GenerationStats[] {
    if (windowSize === null || history.length <= windowSize) return history;
    return history.slice(history.length - windowSize);
  }

  function drawAll(): void {
    if (lastHistory.length === 0) {
      for (const m of mounted) m.card.clear();
      return;
    }
    const slice = applyWindow(lastHistory);
    for (const m of mounted) m.card.update(slice);
  }

  function setVisible(v: boolean): void {
    visible = v;
    if (v) host.removeAttribute('hidden');
    else host.setAttribute('hidden', '');
  }

  updateSegmentedActive();
  drawAll();

  return {
    update(history): void {
      lastHistory = history;
      drawAll();
    },
    setVisible,
    isVisible(): boolean {
      return visible;
    },
  };
}

/* ─── Hover overlay shared by the big line charts ──────────────────── */

function tooltipRow(className: string, text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  return div;
}

/* ─── Card 1: Progress hero ────────────────────────────────────────── */

function buildHero(): ChartCard {
  const content = document.createElement('div');
  content.className = 'stats-hero';

  const valueRow = document.createElement('div');
  valueRow.className = 'stats-hero__values';
  const bestVal = makeBigStat('stats.progressBest', '#a8ff60');
  const meanVal = makeBigStat('stats.progressMean');
  valueRow.appendChild(bestVal.el);
  valueRow.appendChild(meanVal.el);
  content.appendChild(valueRow);

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

  const meanLine = makePolyline(
    'stats-hero__line stats-hero__line--mean',
    'var(--color-fg-muted)',
    1.4,
  );
  svg.appendChild(meanLine);
  const bestLine = makePolyline('stats-hero__line stats-hero__line--best', '#a8ff60', 2);
  svg.appendChild(bestLine);
  wrap.appendChild(svg);

  const yMaxLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--y-top');
  const yMinLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--y-bot');
  const genLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--x-end');
  wrap.appendChild(yMaxLabel);
  wrap.appendChild(yMinLabel);
  wrap.appendChild(genLabel);

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
    positionTooltip(tooltip, e.clientX - rect.left, rect.width);
  });
  wrap.addEventListener('mouseleave', () => {
    hairline.hidden = true;
    tooltip.hidden = true;
  });

  content.appendChild(wrap);

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

    let max = 0;
    for (const h of history) if (h.best > max) max = h.best;
    if (max < 1) max = 1;

    const denom = Math.max(1, history.length - 1);
    let bestPts = '';
    let meanPts = '';
    for (let i = 0; i < history.length; i++) {
      const x = (i / denom) * HERO_W;
      bestPts += `${x.toFixed(1)},${(HERO_H - (history[i]!.best / max) * HERO_H).toFixed(1)} `;
      meanPts += `${x.toFixed(1)},${(HERO_H - (history[i]!.mean / max) * HERO_H).toFixed(1)} `;
    }
    bestLine.setAttribute('points', bestPts.trim());
    meanLine.setAttribute('points', meanPts.trim());

    yMaxLabel.textContent = `${max.toFixed(0)}м`;
    yMinLabel.textContent = '0';
    genLabel.textContent = genRangeLabel(history);
    currentSlice = history;
  }

  return { content, update, clear };
}

/* ─── Card 2: Best finish time per generation ──────────────────────── */

function buildSpeedChart(): ChartCard {
  const content = document.createElement('div');
  content.className = 'stats-hero';

  const valueRow = document.createElement('div');
  valueRow.className = 'stats-hero__values';
  const bestVal = makeBigStat('stats.speedBest', '#a8ff60');
  valueRow.appendChild(bestVal.el);
  content.appendChild(valueRow);

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

  // One polyline per contiguous run of finished gens; gens with no
  // finisher split the line so the chart shows gaps.
  const linesGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(linesGroup);
  wrap.appendChild(svg);

  const yMaxLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--y-top');
  const yMinLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--y-bot');
  const genLabel = makeAxisLabel('stats-hero__axis stats-hero__axis--x-end');
  wrap.appendChild(yMaxLabel);
  wrap.appendChild(yMinLabel);
  wrap.appendChild(genLabel);

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
    const valueRowEl =
      gen.bestFinishTime !== null
        ? tooltipRow(
            'stats-hero__tooltip-row stats-hero__tooltip-row--best',
            `${t('stats.speedBest')} · ${gen.bestFinishTime.toFixed(2)} s`,
          )
        : tooltipRow('stats-hero__tooltip-row', '—');
    tooltip.replaceChildren(
      tooltipRow('stats-hero__tooltip-gen', `пок. #${gen.generation}`),
      valueRowEl,
    );
    positionTooltip(tooltip, e.clientX - rect.left, rect.width);
  });
  wrap.addEventListener('mouseleave', () => {
    hairline.hidden = true;
    tooltip.hidden = true;
  });

  content.appendChild(wrap);

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

    let latestWithFinish: GenerationStats | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.bestFinishTime !== null) {
        latestWithFinish = history[i]!;
        break;
      }
    }
    bestVal.value.textContent =
      latestWithFinish !== null ? `${latestWithFinish.bestFinishTime!.toFixed(2)} s` : '—';

    let maxT = 0;
    for (const h of history) {
      if (h.bestFinishTime !== null && h.bestFinishTime > maxT) maxT = h.bestFinishTime;
    }
    if (maxT < 1) maxT = 1;

    const denom = Math.max(1, history.length - 1);
    let pts = '';
    let pointsInSegment = 0;
    const flush = (): void => {
      if (pointsInSegment > 0) {
        const line = makePolyline('stats-hero__line stats-hero__line--best', '#a8ff60', 2);
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
    genLabel.textContent = genRangeLabel(history);
    currentSlice = history;
  }

  return { content, update, clear };
}

/* ─── Card 3: Insights — records / champion age / finish rate ──────── */

/** Walk history and produce per-gen "cumulative record-breaks" +
 *  "consecutive gens without a record-break" series. */
function deriveInsightSeries(history: GenerationStats[]): {
  cumRecords: number[];
  eliteAge: number[];
} {
  const cumRecords: number[] = [];
  const eliteAge: number[] = [];
  let runningMax = -Infinity;
  let breaks = 0;
  let age = 0;
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

function buildInsights(): ChartCard {
  const content = document.createElement('div');
  content.className = 'stats-insights__grid';

  const cumCell = makeSparkCell('chart.cumRecords', (v) => String(Math.round(v)));
  const ageCell = makeSparkCell('chart.eliteAge', (v) => String(Math.round(v)));
  const finishCell = makeSparkCell('chart.finishRate', (v) => `${v.toFixed(0)}%`);
  content.appendChild(cumCell.el);
  content.appendChild(ageCell.el);
  content.appendChild(finishCell.el);

  function clear(): void {
    cumCell.clear();
    ageCell.clear();
    finishCell.clear();
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    const gens = history.map((h) => h.generation);
    const { cumRecords, eliteAge } = deriveInsightSeries(history);
    cumCell.render(cumRecords, gens);
    ageCell.render(eliteAge, gens);
    finishCell.render(
      history.map((h) => h.finishRate),
      gens,
    );
  }

  return { content, update, clear };
}

/* ─── Card 4: Car-traits sparkline grid ────────────────────────────── */

function buildGenomeGrid(): ChartCard {
  const content = document.createElement('div');
  content.className = 'stats-genome__grid';

  const cells = GENOME_DEFS.map((def) => {
    const cell = makeSparkCell(def.i18nKey, def.format);
    content.appendChild(cell.el);
    return { cell, def };
  });

  function clear(): void {
    for (const c of cells) c.cell.clear();
  }

  function update(history: GenerationStats[]): void {
    if (history.length === 0) {
      clear();
      return;
    }
    const gens = history.map((h) => h.generation);
    for (const { cell, def } of cells) {
      cell.render(
        history.map((h) => h[def.key] as number),
        gens,
      );
    }
  }

  return { content, update, clear };
}

/* ─── Sparkline cell with built-in hover readout ───────────────────── */

type SparkCell = {
  el: HTMLElement;
  /** Plot `values`; `gens[i]` is the generation number for point i. */
  render(values: number[], gens: number[]): void;
  clear(): void;
};

function makeSparkCell(i18nKey: TranslationKey, format: (v: number) => string): SparkCell {
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

  const sparkwrap = document.createElement('div');
  sparkwrap.className = 'stats-genome__sparkwrap';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'stats-genome__spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const polyline = makePolyline('', 'var(--color-fg-muted)', 1.4);
  svg.appendChild(polyline);
  sparkwrap.appendChild(svg);

  const hairline = document.createElement('div');
  hairline.className = 'stats-genome__hairline';
  hairline.hidden = true;
  sparkwrap.appendChild(hairline);

  cell.appendChild(sparkwrap);

  let series: number[] = [];
  let gens: number[] = [];
  let latestText = '—';

  sparkwrap.addEventListener('mousemove', (e) => {
    if (series.length === 0) return;
    const rect = sparkwrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (series.length - 1));
    const xPct = series.length > 1 ? (idx / (series.length - 1)) * 100 : 50;
    hairline.style.left = `${xPct}%`;
    hairline.hidden = false;
    val.classList.add('stats-genome__value--hover');
    val.textContent = `#${gens[idx] ?? idx} · ${format(series[idx] ?? 0)}`;
  });
  sparkwrap.addEventListener('mouseleave', () => {
    hairline.hidden = true;
    val.classList.remove('stats-genome__value--hover');
    val.textContent = latestText;
  });

  function clear(): void {
    series = [];
    gens = [];
    latestText = '—';
    val.textContent = '—';
    val.classList.remove('stats-genome__value--hover');
    polyline.setAttribute('points', '');
    hairline.hidden = true;
  }

  function render(values: number[], genNumbers: number[]): void {
    series = values;
    gens = genNumbers;
    renderSparkline(polyline, values);
    latestText = values.length > 0 ? format(values[values.length - 1]!) : '—';
    if (hairline.hidden) val.textContent = latestText;
  }

  return { el: cell, render, clear };
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

/* ─── Small DOM helpers ────────────────────────────────────────────── */

function makePolyline(className: string, stroke: string, width: number): SVGPolylineElement {
  const line = document.createElementNS(SVG_NS, 'polyline');
  if (className) line.setAttribute('class', className);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-width', String(width));
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  return line;
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

function genRangeLabel(history: GenerationStats[]): string {
  const firstGen = history[0]!.generation;
  const lastGen = history[history.length - 1]!.generation;
  return firstGen === lastGen ? `пок. ${lastGen}` : `пок. ${firstGen}–${lastGen}`;
}

/** Place a tooltip near the cursor, clamped so it can't escape the
 *  chart wrap's left / right edge. */
function positionTooltip(tooltip: HTMLElement, cursorX: number, wrapWidth: number): void {
  const tooltipW = tooltip.offsetWidth || 160;
  let leftPx = cursorX + 14;
  if (leftPx + tooltipW > wrapWidth - 4) leftPx = cursorX - 14 - tooltipW;
  if (leftPx < 4) leftPx = 4;
  tooltip.style.left = `${leftPx}px`;
}
