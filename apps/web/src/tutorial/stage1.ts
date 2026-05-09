/**
 * Tutorial Stage 1 — slow-mo guided generation.
 *
 * Seven sequential steps narrating the GA pipeline.  Each step
 * has a heading, body text, optional inline action, and a
 * dedicated SVG illustration.  The illustration is recomputed
 * deterministically from a fixed seed so the same shapes appear
 * every time the player opens the tutorial — easier to follow
 * along.
 *
 * Cars in the SVG are sketched (chassis polygon + wheel circles)
 * to look like the real game's renderer, but are static — no
 * physics, no Pixi.  The "Play simulation" step animates the
 * cars sliding to pre-computed final positions over 1.5 s.
 */

import { applyTranslations, t, $locale, type TranslationKey } from '../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Stage1Handle = {
  next(): void;
  prev(): void;
  isOnFirstStep(): boolean;
  isOnLastStep(): boolean;
  onChange(cb: () => void): void;
  destroy(): void;
};

type StepConfig = {
  /** i18n key for the heading */
  titleKey: TranslationKey;
  /** i18n key for the body text (rendered as a paragraph) */
  bodyKey: TranslationKey;
  /** Build the SVG illustration into the given root */
  visual: (svg: SVGSVGElement, ctx: VisualCtx, animationKey: number) => void;
};

type VisualCtx = {
  cars: TutCar[];
  finalDistances: number[];
  topIndices: number[];
};

type TutCar = {
  /** Chassis polygon points in local space, x/y in [-1, 1] */
  vertices: { x: number; y: number }[];
  /** Wheels in local space, radius in [-1, 1]-ish */
  wheels: { x: number; y: number; r: number }[];
};

/* ─── Deterministic mock population ────────────────────────────── */

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t2 = s;
    t2 = Math.imul(t2 ^ (t2 >>> 15), t2 | 1);
    t2 ^= t2 + Math.imul(t2 ^ (t2 >>> 7), t2 | 61);
    return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a cute car: 5–8 chassis vertices + 1–3 wheels. */
function makeMockCar(rng: () => number): TutCar {
  const n = 5 + Math.floor(rng() * 4);
  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    const r = 0.5 + rng() * 0.45;
    vertices.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  const wheelCount = 1 + Math.floor(rng() * 3);
  const wheels: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < wheelCount; i++) {
    const v = vertices[Math.floor(rng() * vertices.length)]!;
    wheels.push({ x: v.x, y: v.y, r: 0.18 + rng() * 0.4 });
  }
  return { vertices, wheels };
}

const POP = 8;

function makeContext(): VisualCtx {
  const rng = makeRng(0xc0ffee);
  const cars = Array.from({ length: POP }, () => makeMockCar(rng));
  const finalDistances = Array.from({ length: POP }, () => rng() * rng() * 100);
  // Indices of the top-3 by distance, descending.
  const sorted = finalDistances
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d - a.d)
    .map((x) => x.i);
  return { cars, finalDistances, topIndices: sorted.slice(0, 3) };
}

/* ─── SVG drawing helpers ───────────────────────────────────────── */

const VIEW_W = 800;
const VIEW_H = 220;

function svgEl<K extends keyof SVGElementTagNameMap>(
  parent: Element,
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent.appendChild(el);
  return el;
}

function newRootSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return svg;
}

/** Draw a single car centred at (cx, cy), scaled by `scale` px. */
function drawCar(
  parent: Element,
  car: TutCar,
  cx: number,
  cy: number,
  scale: number,
  cls = '',
): SVGGElement {
  const g = svgEl(parent, 'g', { transform: `translate(${cx} ${cy})` });
  if (cls) g.setAttribute('class', `tut-car ${cls}`);
  else g.setAttribute('class', 'tut-car');
  const points = car.vertices.map((v) => `${v.x * scale},${-v.y * scale}`).join(' ');
  svgEl(g, 'polygon', { points, class: 'tut-car__chassis' });
  for (const w of car.wheels) {
    svgEl(g, 'circle', {
      cx: w.x * scale,
      cy: -w.y * scale,
      r: w.r * scale,
      class: 'tut-car__wheel',
    });
  }
  return g;
}

/** Layout 8 cars on a single horizontal row near the top of the canvas. */
function layoutRow(svg: SVGSVGElement, cars: TutCar[], y: number, scale: number): SVGGElement[] {
  const groups: SVGGElement[] = [];
  const slot = VIEW_W / cars.length;
  for (let i = 0; i < cars.length; i++) {
    const cx = slot * (i + 0.5);
    groups.push(drawCar(svg, cars[i]!, cx, y, scale));
  }
  return groups;
}

/* ─── Step 1: random spawn ──────────────────────────────────────── */

function visualRandomSpawn(svg: SVGSVGElement, ctx: VisualCtx): void {
  // Ground line
  svgEl(svg, 'line', {
    x1: 20,
    y1: VIEW_H - 30,
    x2: VIEW_W - 20,
    y2: VIEW_H - 30,
    stroke: '#4a4a55',
    'stroke-width': 1.5,
  });
  layoutRow(svg, ctx.cars, VIEW_H - 80, 24);
}

/* ─── Step 2: simulation playback ───────────────────────────────── */

function visualSimulation(svg: SVGSVGElement, ctx: VisualCtx, animationKey: number): void {
  // Track baseline with a finish-line marker on the right.
  svgEl(svg, 'line', {
    x1: 20,
    y1: VIEW_H - 30,
    x2: VIEW_W - 20,
    y2: VIEW_H - 30,
    stroke: '#4a4a55',
    'stroke-width': 1.5,
  });
  // 8 lanes, one per car.  Initial x = a fixed start zone on the
  // left; final x = a function of fitness, capped by the right
  // edge.  CSS animation drives the slide-out; the unique
  // animation-key ensures restarts when the user clicks "play".
  const startX = 60;
  const maxFinalX = VIEW_W - 60;
  const maxDistance = Math.max(...ctx.finalDistances, 1);
  for (let i = 0; i < ctx.cars.length; i++) {
    const lane = ((i + 0.5) * (VIEW_H - 60)) / ctx.cars.length;
    const targetX = startX + (ctx.finalDistances[i]! / maxDistance) * (maxFinalX - startX);
    const g = drawCar(svg, ctx.cars[i]!, startX, lane + 20, 16);
    g.style.transform = `translate(${startX}px, ${lane + 20}px)`;
    g.style.transition = 'transform 1.4s cubic-bezier(0.2, 0.7, 0.2, 1)';
    // RAF-defer to ensure the initial transform is applied before
    // we change it (or the transition won't fire).
    requestAnimationFrame(() => {
      g.style.transform = `translate(${targetX}px, ${lane + 20}px)`;
    });
    // Fitness label appears at the end position after the slide.
    const label = svgEl(svg, 'text', {
      x: targetX + 28,
      y: lane + 24,
      fill: '#a8ff60',
      'font-family': 'monospace',
      'font-size': 11,
      opacity: 0,
    });
    label.textContent = `${ctx.finalDistances[i]!.toFixed(0)} m`;
    label.style.transition = 'opacity 0.3s ease-out 1.3s';
    requestAnimationFrame(() => {
      label.setAttribute('opacity', '1');
    });
  }
  // Touch animationKey so eslint sees we used it (it's a cue to
  // re-trigger the visual when the user replays the step).
  void animationKey;
}

/* ─── Step 3: selection (top-3 highlight) ───────────────────────── */

function visualSelection(svg: SVGSVGElement, ctx: VisualCtx): void {
  svgEl(svg, 'line', {
    x1: 20,
    y1: VIEW_H - 30,
    x2: VIEW_W - 20,
    y2: VIEW_H - 30,
    stroke: '#4a4a55',
    'stroke-width': 1.5,
  });
  // Sort cars by fitness so the bright ones are visually clustered
  // on the right (winners earn the right side).  This also makes
  // the next step (elite copy) read more naturally — the elite
  // are already where the next-gen line is anchored.
  const order = ctx.finalDistances
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d - a.d)
    .map((x) => x.i);
  const slot = VIEW_W / ctx.cars.length;
  for (let rank = 0; rank < ctx.cars.length; rank++) {
    const carIdx = order[rank]!;
    const cx = slot * (rank + 0.5);
    const top = rank < 3;
    const cls = top ? 'tut-car--top' : 'tut-car--dim';
    drawCar(svg, ctx.cars[carIdx]!, cx, VIEW_H - 80, 24, cls);
  }
}

/* ─── Step 4: elite preservation ────────────────────────────────── */

function visualElite(svg: SVGSVGElement, ctx: VisualCtx): void {
  // Two horizontal "shelves": Gen N (top) and Gen N+1 (bottom).
  // Top slot 0 (the elite) duplicates straight down to the
  // bottom shelf with an arrow.
  defineArrowhead(svg);
  svgEl(svg, 'text', {
    x: 20,
    y: 30,
    fill: '#8b8b94',
    'font-family': 'monospace',
    'font-size': 11,
  }).textContent = 'gen N';
  svgEl(svg, 'text', {
    x: 20,
    y: VIEW_H - 30,
    fill: '#8b8b94',
    'font-family': 'monospace',
    'font-size': 11,
  }).textContent = 'gen N+1';

  // Source row (gen N): top-3 are bright, others dimmed.
  const order = ctx.topIndices;
  const sourceY = 60;
  const targetY = VIEW_H - 60;
  const slot = VIEW_W / 8;
  for (let i = 0; i < 8; i++) {
    const cx = slot * (i + 0.5);
    const isElite = order.indexOf(i) === 0;
    const cls = order.includes(i) ? 'tut-car--top' : 'tut-car--dim';
    drawCar(svg, ctx.cars[i]!, cx, sourceY, 18, cls);
    if (isElite) {
      // Elite copy lands at slot 0 of the next gen.
      const targetX = slot * 0.5;
      drawCar(svg, ctx.cars[i]!, targetX, targetY, 18, 'tut-car--top');
      svgEl(svg, 'path', {
        d: `M ${cx} ${sourceY + 24} C ${cx} ${(sourceY + targetY) / 2}, ${targetX} ${(sourceY + targetY) / 2}, ${targetX} ${targetY - 24}`,
        class: 'tut-arrow',
      });
    }
  }
}

/* ─── Step 5: crossover ─────────────────────────────────────────── */

function visualCrossover(svg: SVGSVGElement, ctx: VisualCtx): void {
  defineArrowhead(svg);
  // Two parents on the top row, child on the bottom row.  Lines
  // from each parent merge into the child.  Pick the two top
  // parents by fitness, and synthesise a "child" from a mix of
  // their wheels and chassis vertices for the visual.
  const pA = ctx.cars[ctx.topIndices[0]!]!;
  const pB = ctx.cars[ctx.topIndices[1]!]!;
  const child: TutCar = {
    vertices: pA.vertices.map((v, i) =>
      i % 2 === 0 ? v : (pB.vertices[i % pB.vertices.length] ?? v),
    ),
    wheels: [pA.wheels[0] ?? { x: 0, y: 0, r: 0.3 }, pB.wheels[0] ?? { x: 0, y: 0, r: 0.3 }],
  };
  const ax = VIEW_W * 0.25;
  const bx = VIEW_W * 0.75;
  const cx = VIEW_W * 0.5;
  drawCar(svg, pA, ax, 60, 22, 'tut-car--top');
  svgEl(svg, 'text', {
    x: ax,
    y: 24,
    fill: '#a8ff60',
    'font-family': 'monospace',
    'font-size': 11,
    'text-anchor': 'middle',
  }).textContent = 'parent A';
  drawCar(svg, pB, bx, 60, 22, 'tut-car--top');
  svgEl(svg, 'text', {
    x: bx,
    y: 24,
    fill: '#a8ff60',
    'font-family': 'monospace',
    'font-size': 11,
    'text-anchor': 'middle',
  }).textContent = 'parent B';
  drawCar(svg, child, cx, VIEW_H - 60, 24);
  svgEl(svg, 'text', {
    x: cx,
    y: VIEW_H - 18,
    fill: '#e6e6e9',
    'font-family': 'monospace',
    'font-size': 11,
    'text-anchor': 'middle',
  }).textContent = 'child';
  svgEl(svg, 'path', {
    d: `M ${ax} 84 C ${ax} ${VIEW_H * 0.5}, ${cx} ${VIEW_H * 0.5}, ${cx} ${VIEW_H - 84}`,
    class: 'tut-arrow',
  });
  svgEl(svg, 'path', {
    d: `M ${bx} 84 C ${bx} ${VIEW_H * 0.5}, ${cx} ${VIEW_H * 0.5}, ${cx} ${VIEW_H - 84}`,
    class: 'tut-arrow',
  });
}

/* ─── Step 6: mutation ──────────────────────────────────────────── */

function visualMutation(svg: SVGSVGElement, ctx: VisualCtx): void {
  defineArrowhead(svg);
  // Show the same child (from the crossover step), then a "+
  // mutation" arrow → a slightly perturbed version.
  const pA = ctx.cars[ctx.topIndices[0]!]!;
  const pB = ctx.cars[ctx.topIndices[1]!]!;
  const child: TutCar = {
    vertices: pA.vertices.map((v, i) =>
      i % 2 === 0 ? v : (pB.vertices[i % pB.vertices.length] ?? v),
    ),
    wheels: [pA.wheels[0] ?? { x: 0, y: 0, r: 0.3 }, pB.wheels[0] ?? { x: 0, y: 0, r: 0.3 }],
  };
  const mutated: TutCar = {
    vertices: child.vertices.map((v) => ({
      x: v.x + Math.sin(v.x * 7) * 0.12,
      y: v.y + Math.cos(v.y * 5) * 0.12,
    })),
    wheels: child.wheels.map((w, i) => ({
      x: w.x,
      y: w.y,
      r: w.r + (i === 0 ? 0.12 : -0.05),
    })),
  };
  const lx = VIEW_W * 0.3;
  const rx = VIEW_W * 0.7;
  drawCar(svg, child, lx, VIEW_H * 0.5, 26);
  svgEl(svg, 'text', {
    x: lx,
    y: VIEW_H * 0.5 - 60,
    fill: '#8b8b94',
    'font-family': 'monospace',
    'font-size': 11,
    'text-anchor': 'middle',
  }).textContent = 'before';
  drawCar(svg, mutated, rx, VIEW_H * 0.5, 26, 'tut-car--top');
  svgEl(svg, 'text', {
    x: rx,
    y: VIEW_H * 0.5 - 60,
    fill: '#a8ff60',
    'font-family': 'monospace',
    'font-size': 11,
    'text-anchor': 'middle',
  }).textContent = '+ mutation';
  svgEl(svg, 'path', {
    d: `M ${lx + 40} ${VIEW_H * 0.5} L ${rx - 40} ${VIEW_H * 0.5}`,
    class: 'tut-arrow',
  });
}

/* ─── Step 7: full new generation ───────────────────────────────── */

function visualNewGen(svg: SVGSVGElement, ctx: VisualCtx): void {
  // Two rows: gen N (top, top-3 highlighted), gen N+1 (bottom,
  // 3 elites copies + 5 child mash-ups).
  svgEl(svg, 'text', {
    x: 20,
    y: 30,
    fill: '#8b8b94',
    'font-family': 'monospace',
    'font-size': 11,
  }).textContent = 'gen N';
  svgEl(svg, 'text', {
    x: 20,
    y: VIEW_H - 30,
    fill: '#8b8b94',
    'font-family': 'monospace',
    'font-size': 11,
  }).textContent = 'gen N+1';
  const slot = VIEW_W / 8;
  // Top row: the original 8 cars with top-3 bright.
  for (let i = 0; i < 8; i++) {
    const cls = ctx.topIndices.includes(i) ? 'tut-car--top' : 'tut-car--dim';
    drawCar(svg, ctx.cars[i]!, slot * (i + 0.5), 60, 18, cls);
  }
  // Bottom row: first 3 are elite copies of the top-3, last 5 are
  // crossovers of pairs of top-3.
  for (let i = 0; i < 8; i++) {
    let car: TutCar;
    let cls = '';
    if (i < 3) {
      car = ctx.cars[ctx.topIndices[i]!]!;
      cls = 'tut-car--top';
    } else {
      const pA = ctx.cars[ctx.topIndices[i % 3]!]!;
      const pB = ctx.cars[ctx.topIndices[(i + 1) % 3]!]!;
      car = {
        vertices: pA.vertices.map((v, idx) =>
          idx % 2 === 0 ? v : (pB.vertices[idx % pB.vertices.length] ?? v),
        ),
        wheels: [pA.wheels[0] ?? { x: 0, y: 0, r: 0.3 }],
      };
    }
    drawCar(svg, car, slot * (i + 0.5), VIEW_H - 60, 18, cls);
  }
}

/* ─── Helper: arrowhead marker ──────────────────────────────────── */

function defineArrowhead(svg: SVGSVGElement): void {
  if (svg.querySelector('#tut-arrowhead')) return;
  const defs = svgEl(svg, 'defs');
  const marker = svgEl(defs, 'marker', {
    id: 'tut-arrowhead',
    viewBox: '0 0 8 8',
    refX: 7,
    refY: 4,
    markerWidth: 7,
    markerHeight: 7,
    orient: 'auto',
  });
  svgEl(marker, 'path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: '#a8ff60' });
}

/* ─── Step list ─────────────────────────────────────────────────── */

const STEPS: StepConfig[] = [
  {
    titleKey: 'tutorial.s1.step1.title',
    bodyKey: 'tutorial.s1.step1.body',
    visual: visualRandomSpawn,
  },
  {
    titleKey: 'tutorial.s1.step2.title',
    bodyKey: 'tutorial.s1.step2.body',
    visual: visualSimulation,
  },
  {
    titleKey: 'tutorial.s1.step3.title',
    bodyKey: 'tutorial.s1.step3.body',
    visual: visualSelection,
  },
  { titleKey: 'tutorial.s1.step4.title', bodyKey: 'tutorial.s1.step4.body', visual: visualElite },
  {
    titleKey: 'tutorial.s1.step5.title',
    bodyKey: 'tutorial.s1.step5.body',
    visual: visualCrossover,
  },
  {
    titleKey: 'tutorial.s1.step6.title',
    bodyKey: 'tutorial.s1.step6.body',
    visual: visualMutation,
  },
  { titleKey: 'tutorial.s1.step7.title', bodyKey: 'tutorial.s1.step7.body', visual: visualNewGen },
];

/* ─── Public mount ──────────────────────────────────────────────── */

export type Stage1MountOptions = {
  onStepChange?: (info: { step: number; total: number }) => void;
  onAdvance?: () => void;
  onPrev?: () => void;
};

export function mountStage1(host: HTMLElement, opts: Stage1MountOptions = {}): Stage1Handle {
  let stepIdx = 0;
  let animationKey = 0;
  const ctx = makeContext();
  const changeListeners: (() => void)[] = [];

  const heading = document.createElement('h3');
  heading.className = 'tutorial-step__heading';
  const body = document.createElement('p');
  body.className = 'tutorial-step__body';
  const visualWrap = document.createElement('div');
  visualWrap.className = 'tutorial-step__visual';
  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.className = 'tutorial-step__action';
  actionBtn.hidden = true;
  actionBtn.addEventListener('click', () => {
    // Replay the current step's visual (only the simulation step
    // uses this — the others have static art).
    animationKey++;
    renderVisual();
  });

  host.appendChild(heading);
  host.appendChild(body);
  host.appendChild(visualWrap);
  host.appendChild(actionBtn);

  function renderVisual(): void {
    visualWrap.innerHTML = '';
    const svg = newRootSvg();
    visualWrap.appendChild(svg);
    STEPS[stepIdx]!.visual(svg, ctx, animationKey);
  }

  function render(): void {
    const cfg = STEPS[stepIdx]!;
    heading.setAttribute('data-i18n', cfg.titleKey);
    heading.textContent = t(cfg.titleKey);
    body.setAttribute('data-i18n', cfg.bodyKey);
    body.textContent = t(cfg.bodyKey);
    // Step 2 (simulation playback) shows the replay button.
    const isSim = cfg.visual === visualSimulation;
    actionBtn.hidden = !isSim;
    if (isSim) {
      actionBtn.setAttribute('data-i18n', 'tutorial.s1.step2.action');
      actionBtn.textContent = t('tutorial.s1.step2.action');
    }
    renderVisual();
    opts.onStepChange?.({ step: stepIdx + 1, total: STEPS.length });
    for (const cb of changeListeners) cb();
  }

  const off = $locale.subscribe(() => {
    if (host.isConnected) {
      heading.textContent = t(STEPS[stepIdx]!.titleKey);
      body.textContent = t(STEPS[stepIdx]!.bodyKey);
      if (!actionBtn.hidden) actionBtn.textContent = t('tutorial.s1.step2.action');
    }
  });

  render();
  applyTranslations(host);

  return {
    next(): void {
      if (stepIdx < STEPS.length - 1) {
        stepIdx++;
        animationKey++;
        render();
      } else {
        opts.onAdvance?.();
      }
    },
    prev(): void {
      if (stepIdx > 0) {
        stepIdx--;
        animationKey++;
        render();
      } else {
        opts.onPrev?.();
      }
    },
    isOnFirstStep(): boolean {
      return stepIdx === 0;
    },
    isOnLastStep(): boolean {
      return stepIdx === STEPS.length - 1;
    },
    onChange(cb): void {
      changeListeners.push(cb);
    },
    destroy(): void {
      off();
      changeListeners.length = 0;
      host.innerHTML = '';
    },
  };
}
