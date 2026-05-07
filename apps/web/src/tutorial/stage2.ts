/**
 * Tutorial Stage 2 — interactive lineage tree.
 *
 * Runs a small GA (12 cars × 10 generations by default) entirely
 * client-side using a synthetic fitness function — no Rapier, no
 * physics, instant.  The fitness is just a hand-rolled scoring of
 * a genome ("more wheel power good, sane density good, balanced
 * size good") that gives realistic-looking convergence curves.
 *
 * The visualisation is a left-to-right tree:
 *   - x-axis = generation number
 *   - y-axis = slot index in the population (preserved across
 *     generations so elites become straight horizontal lines and
 *     mutated children fan out from their parent's slot)
 *   - node colour = fitness (cool = bad, warm/accent = good)
 *   - lines connect each child to its primary parent (or to its
 *     identical predecessor, for elite copies)
 *
 * Sliders for mutation, elite, and population trigger an instant
 * re-run of the whole 10-generation lineage.
 */

import { applyTranslations, t, $locale, type TranslationKey } from '../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ─── Types ─────────────────────────────────────────────────────── */

type Genome = {
  /** Number of chassis vertices (5..10), informational only here. */
  vertexCount: number;
  /** Average chassis density 0..1. */
  density: number;
  /** Number of wheels 1..4. */
  wheelCount: number;
  /** Average wheel power 0..1. */
  wheelPower: number;
  /** Average wheel radius 0..1. */
  wheelRadius: number;
  /** Motor speed normalised 0..1. */
  motorSpeed: number;
};

type Individual = {
  genome: Genome;
  fitness: number;
  /** Slot in this generation (0..N-1). */
  slot: number;
  /** Slot of the primary parent in the previous generation (null for gen 0). */
  parentSlot: number | null;
  /** True if this individual is an unchanged elite copy of its parent. */
  isElite: boolean;
};

type Generation = Individual[];

export type Stage2Handle = {
  destroy(): void;
};

/* ─── RNG ───────────────────────────────────────────────────────── */

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

/* ─── Synthetic fitness ─────────────────────────────────────────── */

/**
 * Score a genome with a simple math formula that gives sane
 * convergence behaviour without needing physics.  Optimum lies
 * around: motorSpeed=0.65, wheelPower=0.7, wheelRadius=0.55,
 * wheelCount=2-3, density=0.5.  Random genomes score near 0;
 * "well evolved" ones score near 100.
 */
function scoreGenome(g: Genome): number {
  // Wheel propulsion ability: power × radius × count, capped.
  const wheelTerm = Math.min(g.wheelPower * g.wheelRadius * g.wheelCount * 30, 50);
  // Motor speed: gaussian peak around 0.65.
  const motorTerm = 30 * Math.exp(-((g.motorSpeed - 0.65) ** 2) / 0.05);
  // Density: gaussian peak around 0.5 — too light / heavy hurts.
  const densityTerm = 15 * Math.exp(-((g.density - 0.5) ** 2) / 0.1);
  // Vertex count: mild bonus for moderate (6-8), penalty for extremes.
  const vbonus = -Math.abs(g.vertexCount - 7) * 1.2;
  return Math.max(0, wheelTerm + motorTerm + densityTerm + vbonus);
}

/* ─── Random / mutate / crossover ───────────────────────────────── */

function randomGenome(rng: () => number): Genome {
  return {
    vertexCount: 5 + Math.floor(rng() * 6),
    density: rng(),
    wheelCount: 1 + Math.floor(rng() * 4),
    wheelPower: rng(),
    wheelRadius: rng(),
    motorSpeed: rng(),
  };
}

function mutateGenome(g: Genome, rate: number, rng: () => number): Genome {
  const nudge = (v: number, scale: number): number => {
    if (rng() >= rate) return v;
    return Math.max(0, Math.min(1, v + (rng() * 2 - 1) * scale));
  };
  let vertexCount = g.vertexCount;
  if (rng() < rate * 0.15)
    vertexCount = Math.max(5, Math.min(10, vertexCount + (rng() < 0.5 ? -1 : 1)));
  let wheelCount = g.wheelCount;
  if (rng() < rate * 0.15)
    wheelCount = Math.max(1, Math.min(4, wheelCount + (rng() < 0.5 ? -1 : 1)));
  return {
    vertexCount,
    density: nudge(g.density, 0.18),
    wheelCount,
    wheelPower: nudge(g.wheelPower, 0.18),
    wheelRadius: nudge(g.wheelRadius, 0.18),
    motorSpeed: nudge(g.motorSpeed, 0.18),
  };
}

function crossoverGenomes(a: Genome, b: Genome, rng: () => number): Genome {
  const pick = <T>(x: T, y: T): T => (rng() < 0.5 ? x : y);
  return {
    vertexCount: pick(a.vertexCount, b.vertexCount),
    density: pick(a.density, b.density),
    wheelCount: pick(a.wheelCount, b.wheelCount),
    wheelPower: pick(a.wheelPower, b.wheelPower),
    wheelRadius: pick(a.wheelRadius, b.wheelRadius),
    motorSpeed: pick(a.motorSpeed, b.motorSpeed),
  };
}

function rouletteSelect<T>(items: readonly T[], weights: readonly number[], rng: () => number): T {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return items[Math.floor(rng() * items.length)]!;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]! > 0 ? weights[i]! : 0;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/* ─── Run a full lineage ────────────────────────────────────────── */

type RunParams = {
  generations: number;
  populationSize: number;
  eliteCount: number;
  mutationRate: number;
  seed: number;
};

function runLineage(params: RunParams): Generation[] {
  const rng = makeRng(params.seed);
  const gens: Generation[] = [];

  // Gen 0: random genomes, no parents.
  const initial: Generation = [];
  for (let i = 0; i < params.populationSize; i++) {
    const g = randomGenome(rng);
    initial.push({
      genome: g,
      fitness: scoreGenome(g),
      slot: i,
      parentSlot: null,
      isElite: false,
    });
  }
  gens.push(initial);

  for (let g = 1; g < params.generations; g++) {
    const prev = gens[g - 1]!;
    // Sort prev by fitness desc — top eliteCount become the elite,
    // and they preserve their slot indices via direct copy.  But to
    // keep the tree visually clean we re-pack elites into the first
    // few slots and leave the rest of the slots for children.
    const ranked = [...prev].sort((a, b) => b.fitness - a.fitness);
    const next: Generation = [];
    const fitnesses = prev.map((p) => p.fitness);
    const pool = prev;

    for (let slot = 0; slot < params.populationSize; slot++) {
      if (slot < params.eliteCount && ranked[slot]) {
        const elite = ranked[slot]!;
        next.push({
          genome: elite.genome,
          fitness: elite.fitness,
          slot,
          parentSlot: elite.slot,
          isElite: true,
        });
      } else {
        const a = rouletteSelect(pool, fitnesses, rng);
        const b = rouletteSelect(pool, fitnesses, rng);
        const child = crossoverGenomes(a.genome, b.genome, rng);
        const mutated = mutateGenome(child, params.mutationRate, rng);
        // "Primary parent" = whichever of A/B has higher fitness;
        // line is drawn from that one to keep the tree readable.
        const primaryParent = a.fitness >= b.fitness ? a : b;
        next.push({
          genome: mutated,
          fitness: scoreGenome(mutated),
          slot,
          parentSlot: primaryParent.slot,
          isElite: false,
        });
      }
    }
    gens.push(next);
  }
  return gens;
}

/* ─── Tree rendering ────────────────────────────────────────────── */

const TREE_VIEW_W = 800;
const TREE_VIEW_H = 240;
const TREE_PAD = 20;

function fitnessColor(f: number, maxF: number): string {
  // 0 = cool muted, max = bright accent.  Stops between greys and
  // the accent green.
  const t = Math.min(1, Math.max(0, f / Math.max(1, maxF)));
  // Linear interpolate H/L in a perceptual-ish space.  Hand-tuned
  // hex stops:
  const stops = [
    { t: 0, h: 0x4a4a55 },
    { t: 0.5, h: 0x7e9b6e },
    { t: 1.0, h: 0xa8ff60 },
  ];
  // Find segment
  let lo = stops[0]!;
  let hi = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i]!.t && t <= stops[i + 1]!.t) {
      lo = stops[i]!;
      hi = stops[i + 1]!;
      break;
    }
  }
  const span = hi.t - lo.t || 1;
  const k = (t - lo.t) / span;
  const lerpC = (a: number, b: number): number => Math.round(a + (b - a) * k);
  const r = lerpC((lo.h >> 16) & 0xff, (hi.h >> 16) & 0xff);
  const gc = lerpC((lo.h >> 8) & 0xff, (hi.h >> 8) & 0xff);
  const b = lerpC(lo.h & 0xff, hi.h & 0xff);
  return `rgb(${r}, ${gc}, ${b})`;
}

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

function renderTree(host: SVGSVGElement, gens: Generation[]): void {
  host.innerHTML = '';
  if (gens.length === 0) return;
  const cols = gens.length;
  const rows = gens[0]!.length;
  const colStep = (TREE_VIEW_W - 2 * TREE_PAD) / Math.max(1, cols - 1);
  const rowStep = (TREE_VIEW_H - 2 * TREE_PAD) / Math.max(1, rows - 1);
  let maxF = 0;
  for (const gen of gens) for (const ind of gen) if (ind.fitness > maxF) maxF = ind.fitness;

  // Lines first so nodes draw on top.
  for (let g = 1; g < cols; g++) {
    for (const ind of gens[g]!) {
      if (ind.parentSlot === null) continue;
      const x1 = TREE_PAD + (g - 1) * colStep;
      const y1 = TREE_PAD + ind.parentSlot * rowStep;
      const x2 = TREE_PAD + g * colStep;
      const y2 = TREE_PAD + ind.slot * rowStep;
      svgEl(host, 'line', {
        x1,
        y1,
        x2,
        y2,
        class: ind.isElite
          ? 'tutorial-tree__line tutorial-tree__line--elite'
          : 'tutorial-tree__line',
      });
    }
  }

  // Nodes.
  for (let g = 0; g < cols; g++) {
    for (const ind of gens[g]!) {
      const cx = TREE_PAD + g * colStep;
      const cy = TREE_PAD + ind.slot * rowStep;
      svgEl(host, 'circle', {
        cx,
        cy,
        r: 4,
        fill: fitnessColor(ind.fitness, maxF),
        class: 'tutorial-tree__node',
      });
    }
  }
}

/* ─── Stats helpers ─────────────────────────────────────────────── */

function bestOfGen(gen: Generation): number {
  let m = 0;
  for (const ind of gen) if (ind.fitness > m) m = ind.fitness;
  return m;
}

function meanOfGen(gen: Generation): number {
  if (gen.length === 0) return 0;
  let s = 0;
  for (const ind of gen) s += ind.fitness;
  return s / gen.length;
}

function diversityOfGen(gen: Generation): number {
  // Spread of one representative gene (motorSpeed) — quick proxy
  // for "how different are these genomes from each other".
  if (gen.length < 2) return 0;
  let mean = 0;
  for (const ind of gen) mean += ind.genome.motorSpeed;
  mean /= gen.length;
  let v = 0;
  for (const ind of gen) v += (ind.genome.motorSpeed - mean) ** 2;
  return Math.sqrt(v / gen.length);
}

/* ─── Mount ─────────────────────────────────────────────────────── */

export function mountStage2(host: HTMLElement): Stage2Handle {
  // Subtitle.
  const subtitle = document.createElement('p');
  subtitle.className = 'tutorial-step__body';
  subtitle.setAttribute('data-i18n', 'tutorial.s2.subtitle');
  subtitle.textContent = t('tutorial.s2.subtitle');
  host.appendChild(subtitle);

  // Layout: left = tree + controls; right = stats + hints.
  const wrap = document.createElement('div');
  wrap.className = 'tutorial-stage2';
  host.appendChild(wrap);

  const left = document.createElement('div');
  wrap.appendChild(left);

  const treeEl = document.createElement('div');
  treeEl.className = 'tutorial-tree';
  const treeSvg = document.createElementNS(SVG_NS, 'svg');
  treeSvg.setAttribute('viewBox', `0 0 ${TREE_VIEW_W} ${TREE_VIEW_H}`);
  treeSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  treeEl.appendChild(treeSvg);
  left.appendChild(treeEl);

  const controls = document.createElement('div');
  controls.className = 'tutorial-controls';
  left.appendChild(controls);

  const params: RunParams = {
    generations: 10,
    populationSize: 12,
    eliteCount: 2,
    mutationRate: 0.15,
    seed: 0xdecade,
  };

  function makeSlider(
    labelKey: TranslationKey,
    min: number,
    max: number,
    step: number,
    initial: number,
    formatVal: (v: number) => string,
    apply: (v: number) => void,
  ): { el: HTMLElement; refresh: () => void } {
    const row = document.createElement('label');
    row.className = 'ctrl';
    const label = document.createElement('span');
    label.className = 'ctrl__label';
    label.setAttribute('data-i18n', labelKey);
    label.textContent = t(labelKey);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'ctrl__slider';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    const value = document.createElement('span');
    value.className = 'ctrl__value';
    value.textContent = formatVal(initial);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      value.textContent = formatVal(v);
      apply(v);
      rerun();
    });
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(value);
    return {
      el: row,
      refresh(): void {
        label.textContent = t(labelKey);
      },
    };
  }

  const mutSlider = makeSlider(
    'tutorial.s2.mutation',
    0,
    100,
    1,
    Math.round(params.mutationRate * 100),
    (v) => `${v}%`,
    (v) => {
      params.mutationRate = v / 100;
    },
  );
  const eliteSlider = makeSlider(
    'tutorial.s2.elite',
    0,
    6,
    1,
    params.eliteCount,
    (v) => String(v),
    (v) => {
      params.eliteCount = v;
    },
  );
  const popSlider = makeSlider(
    'tutorial.s2.population',
    6,
    24,
    2,
    params.populationSize,
    (v) => String(v),
    (v) => {
      params.populationSize = v;
    },
  );
  controls.appendChild(mutSlider.el);
  controls.appendChild(eliteSlider.el);
  controls.appendChild(popSlider.el);

  const note = document.createElement('p');
  note.className = 'tutorial-note';
  note.setAttribute('data-i18n', 'tutorial.s2.note');
  note.textContent = t('tutorial.s2.note');
  controls.appendChild(note);

  // Right column.
  const right = document.createElement('div');
  wrap.appendChild(right);

  const stats = document.createElement('div');
  stats.className = 'tutorial-stats';
  right.appendChild(stats);

  function makeStatRow(labelKey: TranslationKey): { el: HTMLElement; valueEl: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'tutorial-stats__row';
    const label = document.createElement('span');
    label.className = 'tutorial-stats__label';
    label.setAttribute('data-i18n', labelKey);
    label.textContent = t(labelKey);
    const value = document.createElement('span');
    value.className = 'tutorial-stats__value';
    value.textContent = '—';
    row.appendChild(label);
    row.appendChild(value);
    return { el: row, valueEl: value };
  }

  const bestRow = makeStatRow('tutorial.s2.bestLabel');
  const meanRow = makeStatRow('tutorial.s2.meanLabel');
  const divRow = makeStatRow('tutorial.s2.diversityLabel');
  stats.appendChild(bestRow.el);
  stats.appendChild(meanRow.el);
  stats.appendChild(divRow.el);

  const hint = document.createElement('div');
  hint.className = 'tutorial-hint';
  right.appendChild(hint);

  function pickHintKey(): TranslationKey {
    if (params.mutationRate >= 0.5) return 'tutorial.s2.hintHighMutation';
    if (params.mutationRate <= 0.05) return 'tutorial.s2.hintLowMutation';
    if (params.eliteCount >= 4) return 'tutorial.s2.hintHighElite';
    return 'tutorial.s2.hintBalanced';
  }

  function rerun(): void {
    const gens = runLineage(params);
    renderTree(treeSvg, gens);
    const finalGen = gens[gens.length - 1]!;
    bestRow.valueEl.textContent = bestOfGen(finalGen).toFixed(1);
    meanRow.valueEl.textContent = meanOfGen(finalGen).toFixed(1);
    divRow.valueEl.textContent = diversityOfGen(finalGen).toFixed(2);
    const key = pickHintKey();
    hint.setAttribute('data-i18n', key);
    hint.textContent = t(key);
  }

  rerun();
  applyTranslations(host);

  // Locale change → re-translate slider labels + hint key.
  const off = $locale.subscribe(() => {
    if (!host.isConnected) return;
    mutSlider.refresh();
    eliteSlider.refresh();
    popSlider.refresh();
    const key = pickHintKey();
    hint.setAttribute('data-i18n', key);
    hint.textContent = t(key);
    applyTranslations(host);
  });

  return {
    destroy(): void {
      off();
      host.innerHTML = '';
    },
  };
}
