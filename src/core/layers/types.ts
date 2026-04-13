export const EXTRACTION_LAYERS = ['base', 'semantic', 'media'] as const

export type ExtractionLayer = (typeof EXTRACTION_LAYERS)[number]

export const DEFAULT_EXTRACTION_LAYER: ExtractionLayer = 'base'
