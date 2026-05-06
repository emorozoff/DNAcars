import './styles/global.css';
import { applyTranslations, bindLanguageToggle } from './i18n';
import { mountStage } from './render/stage';

async function bootstrap(): Promise<void> {
  applyTranslations();

  const langBtn = document.getElementById('lang-toggle');
  if (langBtn instanceof HTMLButtonElement) {
    bindLanguageToggle(langBtn);
  }

  const host = document.getElementById('pixi-root');
  if (host instanceof HTMLElement) {
    try {
      await mountStage(host);
    } catch (err) {
      console.error('Failed to mount Pixi stage', err);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
} else {
  void bootstrap();
}
