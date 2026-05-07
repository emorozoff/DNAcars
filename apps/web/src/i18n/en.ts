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
  'panel.speedup8': '⏵⏵ ×8 speed',
  'panel.speedup32': '⏵⏵⏵ ×32 (no render)',
  'panel.skipTen': '⏩ +10 gens',
  'panel.skipping': '⏩ skipping…',
  'panel.trackRandom': '🗺 random track',
  'panel.trackFixed': '🗺 fixed track',
  'panel.trackSmooth': '🗺 smooth track',
  'panel.trackExtreme': '🗺 extreme track',
  'panel.chartsToggle': '📊 Stats',
  'panel.hint': 'press space or the button → new population',
  'legend.wheelAir': 'wheel in air',
  'legend.wheelGround': 'wheel on ground',
  // Chart titles (stats dashboard)
  'chart.best': 'Best fitness',
  'chart.mean': 'Mean fitness',
  'chart.median': 'Median fitness',
  'chart.worst': 'Worst fitness',
  'chart.stdev': 'Diversity (σ)',
  'chart.alive': 'Cars that moved',
  'chart.avgVerts': 'Avg chassis verts',
  'chart.avgWheels': 'Avg wheels',
  'chart.avgWheelPower': 'Avg wheel power',
  'chart.avgMotorSpeed': 'Avg motor speed',
  'chart.avgChassisDensity': 'Avg chassis density',
  'chart.avgChassisSize': 'Avg chassis size',
  'chart.duration': 'Generation time',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
