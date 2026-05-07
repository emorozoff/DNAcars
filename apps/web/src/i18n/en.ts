const enRaw = {
  'panel.generation': 'Gen',
  'panel.cars': 'Cars',
  'panel.lead': 'Lead',
  'panel.seed': 'Seed',
  'panel.restart': '↻ New population',
  'panel.hint': 'press space or the button → new population',
  'legend.wheelAir': 'wheel in air',
  'legend.wheelGround': 'wheel on ground',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
