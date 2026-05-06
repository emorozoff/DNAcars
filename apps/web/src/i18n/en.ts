const enRaw = {
  'panel.run': 'Run',
  'panel.cars': 'Cars',
  'panel.lead': 'Lead',
  'panel.seed': 'Seed',
  'panel.restart': '↻ New shapes',
  'panel.hint':
    'Press space (or the button) to reseed the track and respawn a new batch of random shapes.',
  'footer.tagline': 'Evolution, in your browser.',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
