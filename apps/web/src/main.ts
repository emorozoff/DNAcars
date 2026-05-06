import './styles/global.css';
import { applyTranslations, bindLanguageToggle } from './i18n';
import { mountScene, type SceneHandle } from './render/scene';
import { createSimClient } from './worker/client';
import { randomGenome } from './sim/genome';
import { makeRng } from './sim/prng';

const POPULATION = 12;

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

  const sim = createSimClient();

  sim.on('ready', () => {
    const seed = `dev-${Date.now().toString(36)}`;
    const rng = makeRng(seed);
    const genomes = Array.from({ length: POPULATION }, () => randomGenome(rng));
    sim.start({ seed, genomes });
  });

  sim.on('started', ({ trackPoints }) => {
    scene?.setTrack(trackPoints);
  });

  sim.on('snapshot', (snap) => {
    scene?.setSnapshot(snap);
  });

  sim.on('done', () => {
    // Week 1 stops at one round.  GA-driven respawn lands in week 2.
    console.info('round complete');
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
