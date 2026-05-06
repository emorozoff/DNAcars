const enRaw = {
  'nav.freerun': 'Free Run',
  'nav.daily': 'Daily',
  'panel.title': 'Generation',
  'panel.hint': 'Setup in progress…',
  'footer.tagline': 'Evolution, in your browser.',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
