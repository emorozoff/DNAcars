import { describe, expect, it, beforeEach } from 'vitest';
import { $locale, setLocale, t, applyTranslations } from './index';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('returns english by default', () => {
    expect(t('panel.cars')).toBe('Cars');
  });

  it('switches to russian', () => {
    setLocale('ru');
    expect(t('panel.cars')).toBe('Машин');
    expect($locale.get()).toBe('ru');
  });

  it('rewrites DOM nodes with data-i18n', () => {
    document.body.innerHTML = `<span data-i18n="panel.lead"></span>`;
    setLocale('en');
    applyTranslations();
    const el = document.querySelector<HTMLElement>('[data-i18n="panel.lead"]');
    expect(el?.textContent).toBe('Lead');

    setLocale('ru');
    applyTranslations();
    expect(el?.textContent).toBe('Лидер');
  });
});
