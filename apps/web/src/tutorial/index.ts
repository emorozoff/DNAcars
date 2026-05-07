/**
 * Interactive tutorial — two stages.
 *
 *   Stage 1 — slow-mo guided generation.  7 narrated steps that
 *             walk through random spawn → simulation → selection
 *             → elite preservation → crossover → mutation → next
 *             generation.  Static SVG illustrations at each step
 *             (no live physics — the tutorial is teaching the
 *             *concepts*, not stress-testing Rapier).
 *
 *   Stage 2 — interactive lineage tree.  10 generations × 12 cars
 *             evolved with a synthetic fitness function (pure JS,
 *             instant); rendered as a node-and-line tree where
 *             children are positioned at their primary parent's
 *             slot.  Sliders for mutation / elite / population
 *             trigger a live re-run.
 *
 * Both stages share a common modal shell with header, body, and
 * footer (back / next / close).
 */

import { applyTranslations, t, $locale } from '../i18n';
import { mountStage1 } from './stage1';
import { mountStage2 } from './stage2';

export type TutorialHandle = {
  open(): void;
  close(): void;
  isOpen(): boolean;
};

type StageKey = 'stage1' | 'stage2';
const STAGES: StageKey[] = ['stage1', 'stage2'];

export function mountTutorial(host: HTMLElement): TutorialHandle {
  // Single re-rendered panel — switching stages tears down the
  // current stage's body content and remounts the next stage's
  // body into the same panel.  Saves us from juggling two
  // simultaneous Pixi worlds / stage state.
  let currentStage: StageKey = 'stage1';
  let stageCleanup: (() => void) | null = null;

  const panel = document.createElement('div');
  panel.className = 'tutorial__panel';

  const head = document.createElement('div');
  head.className = 'tutorial__head';
  const title = document.createElement('h2');
  title.className = 'tutorial__title';
  const stepLabel = document.createElement('span');
  stepLabel.className = 'tutorial__step-label';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tutorial__close';
  closeBtn.setAttribute('aria-label', 'Close tutorial');
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', () => close());
  head.appendChild(title);
  head.appendChild(stepLabel);
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const body = document.createElement('div');
  body.className = 'tutorial__body';
  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'tutorial__foot';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn btn--primary';
  foot.appendChild(backBtn);
  foot.appendChild(nextBtn);
  panel.appendChild(foot);

  host.appendChild(panel);

  // Stage 1 reports its current step back so the header label can
  // update ("Step 3 of 7").  Stage 2 has no inner steps.
  let onStage1StepChange: ((info: { step: number; total: number }) => void) | null = (info) =>
    updateStepLabel(`${info.step} / ${info.total}`);

  function updateStepLabel(extra?: string): void {
    const stageIdx = STAGES.indexOf(currentStage);
    const base = t('tutorial.stageOf')
      .replace('{0}', String(stageIdx + 1))
      .replace('{1}', String(STAGES.length));
    stepLabel.textContent = extra ? `${base} · ${extra}` : base;
  }

  function showStage(key: StageKey): void {
    if (stageCleanup) {
      stageCleanup();
      stageCleanup = null;
    }
    body.innerHTML = '';
    currentStage = key;
    if (key === 'stage1') {
      title.textContent = t('tutorial.s1.title');
      onStage1StepChange = (info) => updateStepLabel(`${info.step} / ${info.total}`);
      const handle = mountStage1(body, {
        onStepChange: (info) => onStage1StepChange?.(info),
        onAdvance: () => {
          // Advance is the same as clicking Next — but Stage 1
          // controls Next from inside (it has its own action
          // gating), so this just calls our footer transitions.
          goNext();
        },
        onPrev: () => {
          // First step of stage 1 → close.  Otherwise stage 1
          // moves back internally.
        },
      });
      stageCleanup = handle.destroy;
      // Footer wiring for Stage 1:
      //   Back   = handle.prev()  (handle disables itself at step 0)
      //   Next   = handle.next()  (advances or jumps to stage 2 at the end)
      backBtn.textContent = t('tutorial.back');
      nextBtn.textContent = t('tutorial.next');
      backBtn.onclick = () => handle.prev();
      nextBtn.onclick = () => {
        if (handle.isOnLastStep()) {
          showStage('stage2');
        } else {
          handle.next();
        }
      };
      const refreshButtons = (): void => {
        backBtn.disabled = handle.isOnFirstStep();
        nextBtn.textContent = handle.isOnLastStep() ? t('tutorial.toStage2') : t('tutorial.next');
      };
      handle.onChange(refreshButtons);
      refreshButtons();
    } else {
      title.textContent = t('tutorial.s2.title');
      onStage1StepChange = null;
      updateStepLabel();
      const handle = mountStage2(body);
      stageCleanup = handle.destroy;
      backBtn.disabled = false;
      backBtn.textContent = t('tutorial.back');
      nextBtn.textContent = t('tutorial.finishCloseTutorial');
      backBtn.onclick = () => showStage('stage1');
      nextBtn.onclick = () => close();
    }
    applyTranslations(panel);
  }

  function goNext(): void {
    /* unused but kept for symmetry with onAdvance hook */
  }

  function open(): void {
    if (!host.hasAttribute('hidden')) return;
    host.removeAttribute('hidden');
    showStage('stage1');
  }

  function close(): void {
    if (host.hasAttribute('hidden')) return;
    host.setAttribute('hidden', '');
    if (stageCleanup) {
      stageCleanup();
      stageCleanup = null;
    }
  }

  function isOpen(): boolean {
    return !host.hasAttribute('hidden');
  }

  // Esc to close (registered globally; the harness should still
  // forward Esc to its own UI when the tutorial is shut).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  // Click the dim background to close (but not when the click
  // started inside the panel — preventDefault on mousedown would
  // break input focus, so we just check target identity).
  host.addEventListener('click', (e) => {
    if (e.target === host) close();
  });

  // Locale changes re-translate the panel and any title text.
  $locale.subscribe(() => {
    if (!isOpen()) return;
    title.textContent = currentStage === 'stage1' ? t('tutorial.s1.title') : t('tutorial.s2.title');
    updateStepLabel();
    applyTranslations(panel);
  });

  return { open, close, isOpen };
}
