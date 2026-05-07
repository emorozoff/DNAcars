const enRaw = {
  'panel.generation': 'Gen',
  'panel.cars': 'Cars',
  'panel.lead': 'Lead',
  'panel.bestEver': 'Best',
  'panel.seed': 'Seed',
  'panel.evolution': 'Evolution',
  'panel.population': 'Population',
  'panel.mutation': 'Mutation',
  'panel.elite': 'Elite',
  'panel.restart': '↻ New population',
  'panel.speedup': '⏵ Realtime',
  'panel.speedupOn': '⏵⏵ ×8 speed',
  'panel.chartsToggle': '📊 Stats',
  'panel.hint': 'press space or the button → new population',
  'legend.wheelAir': 'wheel in air',
  'legend.wheelGround': 'wheel on ground',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
