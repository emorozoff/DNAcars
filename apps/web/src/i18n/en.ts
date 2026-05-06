const enRaw = {
  'nav.freerun': 'Free Run',
  'nav.daily': 'Daily',
  'panel.title': 'Generation',
  'panel.hint': 'Setup in progress…',
  'panel.generation': 'Generation',
  'panel.gen': 'Gen',
  'panel.alive': 'Alive',
  'panel.lead': 'Lead',
  'panel.records': 'Records',
  'panel.bestEver': 'Best ever',
  'panel.bestGen': 'Best gen',
  'panel.lastBest': 'Last best',
  'footer.tagline': 'Evolution, in your browser.',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
