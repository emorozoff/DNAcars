import './styles/global.css';
import { applyTranslations, bindLanguageToggle, t } from './i18n';
import { mountScene, type SceneHandle } from './render/scene';
import { createSimClient } from './worker/client';

async function bootstrap(): Promise<void> {
  applyTranslations();

  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${__APP_VERSION__}`;

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
    btnFastForward: document.getElementById('btn-fastforward') as HTMLButtonElement | null,
    btnRestart: document.getElementById('btn-restart') as HTMLButtonElement | null,
    btnArena: document.getElementById('btn-arena') as HTMLButtonElement | null,
  };

  let bestEver = 0;
  let arenaOn = false;

  const sim = createSimClient();

  function startSeed(seed: string): void {
    arenaOn = false;
    syncArenaButton();
    sim.start({ seed });
    bestEver = 0;
    if (ui.bestEver) ui.bestEver.textContent = '—';
    if (ui.bestGen) ui.bestGen.textContent = '—';
    if (ui.lastBest) ui.lastBest.textContent = '—';
    if (ui.generation) ui.generation.textContent = '0';
  }

  function startArena(): void {
    arenaOn = true;
    syncArenaButton();
    sim.startArena({ seed: 'arena' });
    bestEver = 0;
    if (ui.bestEver) ui.bestEver.textContent = '—';
    if (ui.bestGen) ui.bestGen.textContent = '—';
    if (ui.lastBest) ui.lastBest.textContent = '—';
    if (ui.generation) ui.generation.textContent = 'arena';
  }

  function syncArenaButton(): void {
    if (!ui.btnArena) return;
    ui.btnArena.textContent = arenaOn ? t('panel.arena.on') : t('panel.arena');
    ui.btnArena.classList.toggle('btn--primary', arenaOn);
  }

  sim.on('ready', () => {
    startSeed(`dev-${Date.now().toString(36)}`);
  });

  sim.on('started', ({ seed, trackPoints }) => {
    console.info('sim started, seed:', seed);
    scene?.setTrack(trackPoints);
  });

  sim.on('snapshot', (snap) => {
    scene?.setSnapshot(snap);

    let aliveCount = 0;
    let leadTravel = 0;
    for (const c of snap.cars) {
      if (c.alive) aliveCount++;
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
    console.info(
      `gen ${stats.generation} — best ${stats.best.toFixed(1)}m, mean ${stats.mean.toFixed(1)}m`,
    );
  });

  sim.on('error', (msg) => {
    console.error('sim error:', msg);
  });

  // ── Buttons ────────────────────────────────────────────────────────────
  let fast = false;
  ui.btnFastForward?.addEventListener('click', () => {
    fast = !fast;
    sim.setRate(fast ? 8 : 1);
    if (ui.btnFastForward) {
      ui.btnFastForward.textContent = fast ? t('panel.fastforward.on') : t('panel.fastforward');
      ui.btnFastForward.classList.toggle('btn--primary', !fast);
    }
  });

  ui.btnRestart?.addEventListener('click', () => {
    startSeed(`dev-${Date.now().toString(36)}`);
  });

  ui.btnArena?.addEventListener('click', () => {
    if (arenaOn) startSeed(`dev-${Date.now().toString(36)}`);
    else startArena();
  });

  syncArenaButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
