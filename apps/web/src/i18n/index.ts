import { atom } from 'nanostores';
import { en, type Dictionary, type TranslationKey } from './en';
import { ru } from './ru';

export type { TranslationKey };

export type Locale = 'en' | 'ru';

const dictionaries: Record<Locale, Dictionary> = { en, ru };

const STORAGE_KEY = 'dnacars.locale';

function detectInitial(): Locale {
  if (typeof window === 'undefined') return 'en';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'ru') return stored;
  const lang = window.navigator.language.toLowerCase();
  return lang.startsWith('ru') ? 'ru' : 'en';
}

export const $locale = atom<Locale>(detectInitial());

export function setLocale(locale: Locale): void {
  $locale.set(locale);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }
}

export function t(key: TranslationKey): string {
  return dictionaries[$locale.get()][key];
}

export function applyTranslations(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>('[data-i18n]');
  nodes.forEach((node) => {
    const key = node.dataset['i18n'] as TranslationKey | undefined;
    if (key && key in dictionaries.en) {
      node.textContent = t(key);
    }
  });
  // Same idea for `title="..."` (tooltips): elements that need a
  // localised tooltip carry `data-i18n-title="key"` and we copy
  // the translated string into the title attribute.  Keeps the
  // tooltip in sync with the language toggle.
  const titled = root.querySelectorAll<HTMLElement>('[data-i18n-title]');
  titled.forEach((node) => {
    const key = node.dataset['i18nTitle'] as TranslationKey | undefined;
    if (key && key in dictionaries.en) {
      node.setAttribute('title', t(key));
    }
  });
}

export function bindLanguageToggle(button: HTMLButtonElement): void {
  const update = (): void => {
    const next = $locale.get() === 'en' ? 'EN' : 'RU';
    button.textContent = next;
  };
  update();
  $locale.subscribe(() => {
    update();
    applyTranslations();
  });
  button.addEventListener('click', () => {
    setLocale($locale.get() === 'en' ? 'ru' : 'en');
  });
}
