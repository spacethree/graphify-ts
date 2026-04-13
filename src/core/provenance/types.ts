export interface ExtractionProvenance {
  capability_id: string
  stage?: string
  [key: string]: unknown
}

export interface BaselineProvenanceOptions {
  capabilityId?: string
  stage?: string
  sourceFile?: string
  sourceLocation?: string
}

export const LEGACY_NORMALIZATION_CAPABILITY_ID = 'builtin:normalize:legacy-extraction'
export const DEFAULT_NORMALIZATION_STAGE = 'normalize'

export function createBaselineProvenance(options: BaselineProvenanceOptions = {}): ExtractionProvenance {
  const { capabilityId = LEGACY_NORMALIZATION_CAPABILITY_ID, stage = DEFAULT_NORMALIZATION_STAGE, sourceFile, sourceLocation } = options

  return {
    capability_id: capabilityId,
    stage,
    ...(sourceFile ? { source_file: sourceFile } : {}),
    ...(sourceLocation ? { source_location: sourceLocation } : {}),
  }
}
