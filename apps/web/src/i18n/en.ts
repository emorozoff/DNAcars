const enRaw = {
  'panel.generation': 'Generation',
  'panel.cars': 'Population',
  'panel.lead': 'Leader',
  'panel.bestEver': 'Record',
  'panel.eliteSolo': 'Elite (solo)',
  'panel.seed': 'Track seed',
  'panel.seedSection': 'Track seed',
  'panel.seedCopyHint': 'Click to copy',
  'panel.seedCopied': 'Copied!',
  'panel.seedApply': 'Apply',
  'panel.seedHistoryEmpty': 'No saved seeds yet',
  'panel.evolution': 'Evolution',
  'panel.population': 'Size',
  'panel.mutation': 'Mutation',
  'panel.elite': 'Elite',
  'panel.trackTuning': 'Track',
  'panel.trackLength': 'Length',
  'panel.difficulty': 'Difficulty',
  'panel.walls': 'Walls',
  'panel.ceilings': 'Ceilings',
  'panel.cliffs': 'Cliffs',
  'panel.slick': 'Slick',
  'panel.restart': 'New population',
  'panel.restartConfirm': 'Start a new population?  This wipes every gene of the current run.',
  'panel.confirmYes': 'Confirm',
  'panel.confirmNo': 'Cancel',
  'panel.pause': 'Pause',
  'panel.resume': 'Resume',
  'panel.cameraLeader': 'Follow leader',
  'panel.speedLabel': 'Speed',
  'panel.trackLabel': 'Track preset',
  'panel.trackShortRandom': 'Random',
  'panel.trackShortFixed': 'Fixed',
  'panel.chartsToggle': 'Stats',
  'panel.chartWindow': 'Last',
  'panel.chartWindowAll': 'All',
  'panel.headlessBanner': 'Render off · ×32 speed',
  'panel.hint': 'Space — pause   ·   button — new population',
  'panel.tutorialOpen': 'Tutorial',
  'ribbon.gen': 'GENERATION',
  'ribbon.lead': 'LEADER',
  'ribbon.best': 'BEST',
  'ribbon.alive': 'ALIVE',
  'ribbon.seed': 'SEED',
  'ribbon.throughput': 'SPEED',
  'panel.fastForward': 'Fast-forward',
  'panel.speedMode': 'Speed mode',
  'panel.speedModeHint':
    'Race against the clock — the elite slot goes to the fastest finisher. With it off, distance travelled wins.',
  'stats.speed': 'Best finish time',
  'stats.speedBest': 'Fastest',
  'panel.pureMutation': 'Pure mutation',
  'panel.pureMutationHint':
    'Only the top car passes on its genes; everyone else is a mutated copy of it. No crossover, no fitness-roulette — simpler model, but risks premature convergence.',
  'panel.strictDeterminism': 'Strict determinism',
  'panel.strictDeterminismHint':
    'Same seed → bit-identical run, every time. Costs ≈2× CPU because every car gets its own physics world.',
  'panel.strictDeterminismWarning':
    'Every car gets its own physics world. Same seed → bit-identical run.\n\nBut ≈2× CPU load. If this is unfamiliar — only enable on a powerful computer, otherwise leave it off.\n\nThe current run will be reset.',
  'tutorial.close': 'Close',
  'tutorial.next': 'Next',
  'tutorial.back': 'Back',
  'tutorial.toStage2': 'On to interactive part',
  'tutorial.finishCloseTutorial': 'Done',
  'tutorial.stageOf': 'Stage {0} of {1}',
  // ── Stage 1 — guided generation ───────────────────────────────
  'tutorial.s1.title': 'How evolution works in DNAcars',
  'tutorial.s1.step1.title': 'Random start',
  'tutorial.s1.step1.body':
    'Generation 0 is pure noise: random chassis shapes, random wheel sizes, random motors. Most cars will not even leave the spawn pad. That is fine — the algorithm only needs *some* movement to grade them on.',
  'tutorial.s1.step2.title': 'Try them on a track',
  'tutorial.s1.step2.body':
    'Each car is dropped on the same track and full throttle is held. Distance travelled before it stalls = its fitness. Click play to watch.',
  'tutorial.s1.step2.action': 'Play simulation',
  'tutorial.s1.step3.title': 'Selection',
  'tutorial.s1.step3.body':
    'The cars that travelled furthest are highlighted. They will be the parents of the next generation. The further a car drove, the higher its chance to be picked as a parent.',
  'tutorial.s1.step4.title': 'Elite preservation',
  'tutorial.s1.step4.body':
    'The top performers are *copied unchanged* into the next generation — no mutation, no mixing. This guarantees the best result never goes backward across runs. By default, 2-3 elite cars are kept.',
  'tutorial.s1.step5.title': 'Crossover',
  'tutorial.s1.step5.body':
    'For the rest of the new population: pick two parents (weighted by fitness), and for each gene roll a coin to decide which parent the child inherits it from. The child gets a mix of both — half mom, half dad, gene by gene.',
  'tutorial.s1.step6.title': 'Mutation',
  'tutorial.s1.step6.body':
    'Each child genome then gets a small random nudge on a few of its genes. Without this step, the gene pool would freeze and evolution would stall. The mutation slider in the main game controls how strong the nudges are.',
  'tutorial.s1.step7.title': 'And that is one generation',
  'tutorial.s1.step7.body':
    'Elite copies + crossover children + mutations = the new population. Run them on the same (or new) track, score them, and repeat. After 10-20 generations the cars start looking purposeful.',
  // ── Stage 2 — interactive tree ────────────────────────────────
  'tutorial.s2.title': 'Play with the parameters',
  'tutorial.s2.subtitle':
    'Run a 10-generation lineage with 12 cars per gen.  Drag the sliders to see how the family tree shape and the fitness curve change.',
  'tutorial.s2.run': 'Run 10 generations',
  'tutorial.s2.mutation': 'Mutation',
  'tutorial.s2.elite': 'Elite',
  'tutorial.s2.population': 'Population',
  'tutorial.s2.gen': 'Gen',
  'tutorial.s2.bestLabel': 'Best',
  'tutorial.s2.meanLabel': 'Mean',
  'tutorial.s2.diversityLabel': 'Diversity',
  'tutorial.s2.note':
    'For instant feedback this stage uses a simplified fitness model — the real game scores cars by physics simulation.',
  'tutorial.s2.hintHighMutation':
    'Mutation is so high the children barely resemble their parents. Good genes get drowned in noise — fitness wanders.',
  'tutorial.s2.hintLowMutation':
    'Mutation is too low — the population freezes around its starting shape. Without exploration, evolution stalls.',
  'tutorial.s2.hintBalanced':
    'Balanced mutation — fast convergence with enough wiggle to discover new tricks.',
  'tutorial.s2.hintHighElite':
    'High elite count protects the best cars but starves the gene pool of fresh blood. Watch how the mean catches up to best very quickly.',
  'legend.wheelAir': 'Wheel in air',
  'legend.wheelGround': 'Wheel on ground',
  // Chart titles (stats dashboard)
  'chart.best': 'Best distance',
  'chart.mean': 'Mean distance',
  'chart.stdev': 'Diversity',
  'chart.alive': 'Cars that moved',
  'chart.avgVerts': 'Chassis corners',
  'chart.avgWheels': 'Wheels',
  'chart.avgWheelPower': 'Wheel power',
  'chart.avgMotorSpeed': 'Motor speed',
  'chart.avgChassisDensity': 'Chassis density',
  'chart.avgChassisSize': 'Chassis size',
  'chart.cumRecords': 'Records broken',
  'chart.eliteAge': 'Champion age',
  // Stats panel sections (v1.15 redesign)
  'stats.progress': 'Evolution progress',
  'stats.progressBest': 'Best',
  'stats.progressMean': 'Mean',
  'stats.genome': 'Car traits',
  'stats.insights': 'Run insights',
  'stats.stallMap': 'Where cars stall along the track',
  'stats.finishDist': 'Finish-time spread (min · median · max)',
  'stats.empty': 'Run a generation to see stats',
} as const;

export type TranslationKey = keyof typeof enRaw;
export type Dictionary = Record<TranslationKey, string>;

export const en: Dictionary = enRaw;
