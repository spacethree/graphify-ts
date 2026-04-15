import { builtinCapabilityRegistry } from '../../infrastructure/capabilities.js'
import type { UrlType } from '../../infrastructure/ingest/types.js'
import { detectUrlType } from '../../infrastructure/ingest/url-type.js'

import { createBaselineProvenance, type ExtractionProvenance } from './types.js'

export const INGEST_PROVENANCE_STAGE = 'ingest'
const EXPLICIT_INGEST_URL_TYPES = new Set<UrlType>(['tweet', 'reddit', 'hackernews', 'arxiv', 'github', 'youtube', 'pdf', 'image', 'audio', 'video', 'webpage'])

function isExplicitIngestUrlType(value: string): value is UrlType {
  return EXPLICIT_INGEST_URL_TYPES.has(value as UrlType)
}

/**
 * Normalize a metadata string by trimming whitespace and rejecting non-string or empty values.
 */
export function normalizeMetadataString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Derive structured ingest provenance from flat capture metadata such as `source_url` and `captured_at`.
 *
 * This keeps on-disk frontmatter backward-compatible while allowing extraction and normalization
 * to share one capability-resolution path for ingest provenance.
 */
export function deriveIngestProvenanceFromRecord(record: Record<string, unknown>, options: { allowVirtual?: boolean } = {}): ExtractionProvenance | null {
  if (!options.allowVirtual && record.virtual === true) {
    return null
  }

  const sourceFile = normalizeMetadataString(record.source_file)
  const sourceUrl = normalizeMetadataString(record.source_url)
  if (!sourceFile || !sourceUrl) {
    return null
  }

  const explicitType = normalizeMetadataString(record.type)
  const explicitIngestUrlType = normalizeMetadataString(record.ingest_url_type)

  let urlType: UrlType = 'webpage'
  if (explicitType === 'webpage') {
    urlType = 'webpage'
  } else if (explicitIngestUrlType && isExplicitIngestUrlType(explicitIngestUrlType)) {
    urlType = explicitIngestUrlType
  } else {
    try {
      urlType = detectUrlType(sourceUrl)
    } catch {
      return null
    }
  }

  const capability = builtinCapabilityRegistry.resolveIngestorForUrlType(urlType) ?? builtinCapabilityRegistry.resolveIngestorForUrlType('webpage')
  if (!capability) {
    return null
  }

  const capturedAt = normalizeMetadataString(record.captured_at)
  const author = normalizeMetadataString(record.author)
  const contributor = normalizeMetadataString(record.contributor)

  return {
    ...createBaselineProvenance({
      capabilityId: capability.id,
      stage: INGEST_PROVENANCE_STAGE,
      sourceFile,
    }),
    source_url: sourceUrl,
    ...(capturedAt ? { captured_at: capturedAt } : {}),
    ...(author ? { author } : {}),
    ...(contributor ? { contributor } : {}),
  }
}

function provenanceKey(record: ExtractionProvenance): string {
  return `${String(record.capability_id)}|${String(record.stage ?? '')}|${String(record.source_file ?? '')}|${String(record.source_url ?? '')}|${String(record.captured_at ?? '')}`
}

/**
 * Append derived provenance to an existing provenance list without mutating the input array.
 * Duplicate derived records are skipped by a stable provenance key.
 */
export function appendDerivedProvenance(records: readonly ExtractionProvenance[], derivedProvenance: ExtractionProvenance | null): ExtractionProvenance[] {
  if (!derivedProvenance) {
    return [...records]
  }

  const derivedKey = provenanceKey(derivedProvenance)
  if (records.some((record) => provenanceKey(record) === derivedKey)) {
    return [...records]
  }

  return [...records, { ...derivedProvenance }]
}
