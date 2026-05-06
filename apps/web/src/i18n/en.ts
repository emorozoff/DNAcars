const enRaw = {
  'panel.run': 'Run',
  'panel.generation': 'Gen',
  'panel.cars': 'Cars',
  'panel.lead': 'Lead',
  'panel.seed': 'Seed',
  'panel.restart': '↻ New population',
  'panel.hint':
    'Each generation runs until every car has stalled.  Press space to start a new run from scratch.',
  'footer.tagline': 'Evolution, in your browser.',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
