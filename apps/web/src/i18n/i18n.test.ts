import { describe, expect, it, beforeEach } from 'vitest';
import { $locale, setLocale, t, applyTranslations } from './index';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('returns english by default', () => {
    expect(t('footer.tagline')).toBe('Evolution, in your browser.');
  });

  it('switches to russian', () => {
    setLocale('ru');
    expect(t('footer.tagline')).toBe('Эволюция в твоём браузере.');
    expect($locale.get()).toBe('ru');
  });

  it('rewrites DOM nodes with data-i18n', () => {
    document.body.innerHTML = `<span data-i18n="nav.daily"></span>`;
    setLocale('en');
    applyTranslations();
    const el = document.querySelector<HTMLElement>('[data-i18n="nav.daily"]');
    expect(el?.textContent).toBe('Daily');

    setLocale('ru');
    applyTranslations();
    expect(el?.textContent).toBe('Дейли');
  });
});
