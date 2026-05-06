import './styles/global.css';
import { applyTranslations, bindLanguageToggle } from './i18n';
import { mountScene, type SceneHandle } from './render/scene';
import { createSimClient } from './worker/client';

async function bootstrap(): Promise<void> {
  applyTranslations();

  const langBtn = document.getElementById('lang-toggle');
  if (langBtn instanceof HTMLButtonElement) {
    bindLanguageToggle(langBtn);
  }

  const host = document.getElementById('pixi-root');
  if (!(host instanceof HTMLElement)) return;

  let scene: SceneHandle | null = null;
  try {
    scene = await mountScene(host);
  } catch (err) {
    console.error('Failed to mount Pixi scene', err);
    return;
  }

  const stat = (id: string): HTMLElement | null => document.getElementById(id);
  const fmtMeters = (m: number): string => `${m.toFixed(1)} m`;

  const ui = {
    generation: stat('stat-generation'),
    alive: stat('stat-alive'),
    lead: stat('stat-lead'),
    bestEver: stat('stat-best-ever'),
    bestGen: stat('stat-best-gen'),
    lastBest: stat('stat-last-best'),
  };

  let bestEver = 0;
  let bestGen = 0;

  const sim = createSimClient();

  sim.on('ready', () => {
    const seed = `dev-${Date.now().toString(36)}`;
    sim.start({ seed });
  });

  sim.on('started', ({ seed }) => {
    console.info('sim started, seed:', seed);
    if (ui.generation) ui.generation.textContent = '0';
  });

  sim.on('snapshot', (snap) => {
    scene?.setSnapshot(snap);

    const aliveCount = snap.cars.filter((c) => c.alive).length;
    let leadTravel = 0;
    for (const c of snap.cars) {
      if (c.travel > leadTravel) leadTravel = c.travel;
    }

    if (ui.alive) ui.alive.textContent = `${aliveCount} / ${snap.cars.length}`;
    if (ui.lead) ui.lead.textContent = fmtMeters(leadTravel);
  });

  sim.on('generation', ({ stats }) => {
    if (stats.best > bestEver) {
      bestEver = stats.best;
      if (ui.bestGen) ui.bestGen.textContent = String(stats.generation);
    }
    if (ui.bestEver) ui.bestEver.textContent = fmtMeters(bestEver);
    if (ui.lastBest) ui.lastBest.textContent = fmtMeters(stats.best);
    if (ui.generation) ui.generation.textContent = String(stats.generation + 1);
    bestGen = stats.best;
    void bestGen;
    console.info(
      `gen ${stats.generation} — best ${stats.best.toFixed(1)}m, mean ${stats.mean.toFixed(1)}m`,
    );
  });

  sim.on('error', (msg) => {
    console.error('sim error:', msg);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
