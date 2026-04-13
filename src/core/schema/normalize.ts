import type { ExtractionData, ExtractionEdge, ExtractionNode, ExtractionSchemaVersion, Hyperedge } from '../../contracts/types.js'
import { builtinCapabilityRegistry } from '../../infrastructure/capabilities.js'
import { detectUrlType } from '../../infrastructure/ingest/url-type.js'
import { isRecord } from '../../shared/guards.js'
import { DEFAULT_EXTRACTION_LAYER, type ExtractionLayer } from '../layers/types.js'
import { createBaselineProvenance, type ExtractionProvenance } from '../provenance/types.js'

const INGEST_PROVENANCE_STAGE = 'ingest'

export interface NormalizedExtractionNode extends ExtractionNode {
  layer: ExtractionLayer
  provenance: ExtractionProvenance[]
}

export interface NormalizedExtractionEdge extends ExtractionEdge {
  layer: ExtractionLayer
  provenance: ExtractionProvenance[]
}

export interface NormalizedHyperedge extends Hyperedge {
  layer: ExtractionLayer
  provenance: ExtractionProvenance[]
}

export interface NormalizedExtractionData extends Omit<ExtractionData, 'schema_version' | 'nodes' | 'edges' | 'hyperedges'> {
  schema_version: ExtractionSchemaVersion
  nodes: NormalizedExtractionNode[]
  edges: NormalizedExtractionEdge[]
  hyperedges: NormalizedHyperedge[]
}

function normalizeSchemaVersion(value: unknown): ExtractionSchemaVersion {
  return value === 2 ? 2 : 1
}

function deepCloneValue<T>(value: T): T {
  return structuredClone(value)
}

function normalizeLayer(value: unknown): ExtractionLayer {
  if (value === 'semantic' || value === 'media' || value === 'base') {
    return value
  }

  return DEFAULT_EXTRACTION_LAYER
}

function normalizeMetadataString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Project flat ingest-frontmatter fields into a structured provenance record.
 *
 * This path is intentionally lenient because normalization may be running over
 * older or hand-authored extraction payloads. Virtual nodes are excluded so
 * synthetic citation/reference records cannot become the provenance seed for a
 * source file during map construction.
 */
function deriveIngestProvenance(record: Record<string, unknown>): ExtractionProvenance | null {
  if (record.virtual === true) {
    return null
  }

  const sourceFile = normalizeMetadataString(record.source_file)
  const sourceUrl = normalizeMetadataString(record.source_url)
  if (!sourceFile || !sourceUrl) {
    return null
  }

  let urlType: ReturnType<typeof detectUrlType>
  try {
    urlType = detectUrlType(sourceUrl)
  } catch {
    return null
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

function buildIngestProvenanceBySourceFile(nodes: unknown): Map<string, ExtractionProvenance> {
  const records = Array.isArray(nodes) ? nodes.filter(isRecord) : []
  const provenanceBySourceFile = new Map<string, ExtractionProvenance>()

  for (const node of records) {
    const sourceFile = normalizeMetadataString(node.source_file)
    if (!sourceFile || provenanceBySourceFile.has(sourceFile)) {
      continue
    }

    const ingestProvenance = deriveIngestProvenance(node)
    if (ingestProvenance) {
      provenanceBySourceFile.set(sourceFile, ingestProvenance)
    }
  }

  return provenanceBySourceFile
}

function provenanceKey(record: ExtractionProvenance): string {
  return `${String(record.capability_id)}|${String(record.stage ?? '')}|${String(record.source_file ?? '')}|${String(record.source_url ?? '')}|${String(record.captured_at ?? '')}`
}

function appendDerivedProvenance(records: ExtractionProvenance[], derivedProvenance: ExtractionProvenance | null): ExtractionProvenance[] {
  if (!derivedProvenance) {
    return records
  }

  const derivedKey = provenanceKey(derivedProvenance)
  if (records.some((record) => provenanceKey(record) === derivedKey)) {
    return records
  }

  return [...records, deepCloneValue(derivedProvenance)]
}

function normalizeProvenance(
  value: unknown,
  sourceFile: unknown,
  sourceLocation?: unknown,
  derivedProvenance: ExtractionProvenance | null = null,
): ExtractionProvenance[] {
  if (Array.isArray(value)) {
    const records = value.filter(isRecord).map((record) => deepCloneValue(record as ExtractionProvenance))
    if (records.length > 0) {
      return appendDerivedProvenance(records, derivedProvenance)
    }
  }

  return appendDerivedProvenance(
    [
      createBaselineProvenance({
        ...(typeof sourceFile === 'string' ? { sourceFile } : {}),
        ...(typeof sourceLocation === 'string' ? { sourceLocation } : {}),
      }),
    ],
    derivedProvenance,
  )
}

function normalizeNode(node: ExtractionNode, ingestProvenanceBySourceFile: ReadonlyMap<string, ExtractionProvenance>): NormalizedExtractionNode {
  const clonedNode = deepCloneValue(node)
  const derivedProvenance = typeof clonedNode.source_file === 'string' ? (ingestProvenanceBySourceFile.get(clonedNode.source_file) ?? null) : null

  return {
    ...clonedNode,
    layer: normalizeLayer(clonedNode.layer),
    provenance: normalizeProvenance(clonedNode.provenance, clonedNode.source_file, clonedNode.source_location, derivedProvenance),
  }
}

function normalizeEdge(edge: ExtractionEdge, ingestProvenanceBySourceFile: ReadonlyMap<string, ExtractionProvenance>): NormalizedExtractionEdge {
  const clonedEdge = deepCloneValue(edge)
  const derivedProvenance = typeof clonedEdge.source_file === 'string' ? (ingestProvenanceBySourceFile.get(clonedEdge.source_file) ?? null) : null

  return {
    ...clonedEdge,
    layer: normalizeLayer(clonedEdge.layer),
    provenance: normalizeProvenance(clonedEdge.provenance, clonedEdge.source_file, clonedEdge.source_location, derivedProvenance),
  }
}

function normalizeHyperedge(hyperedge: Hyperedge, ingestProvenanceBySourceFile: ReadonlyMap<string, ExtractionProvenance>): NormalizedHyperedge {
  const clonedHyperedge = deepCloneValue(hyperedge)
  const derivedProvenance = typeof clonedHyperedge.source_file === 'string' ? (ingestProvenanceBySourceFile.get(clonedHyperedge.source_file) ?? null) : null

  return {
    ...clonedHyperedge,
    nodes: Array.isArray(clonedHyperedge.nodes) ? [...clonedHyperedge.nodes] : [],
    layer: normalizeLayer(clonedHyperedge.layer),
    provenance: normalizeProvenance(clonedHyperedge.provenance, clonedHyperedge.source_file, undefined, derivedProvenance),
  }
}

export function normalizeExtractionData(extraction: unknown): NormalizedExtractionData {
  if (!isRecord(extraction)) {
    return {
      schema_version: 1,
      nodes: [],
      edges: [],
      hyperedges: [],
    }
  }

  const clonedExtraction = deepCloneValue(extraction)
  const ingestProvenanceBySourceFile = buildIngestProvenanceBySourceFile(clonedExtraction.nodes)

  const nodes = Array.isArray(clonedExtraction.nodes)
    ? clonedExtraction.nodes.filter(isRecord).map((node) => normalizeNode(node as ExtractionNode, ingestProvenanceBySourceFile))
    : []
  const edges = Array.isArray(clonedExtraction.edges)
    ? clonedExtraction.edges.filter(isRecord).map((edge) => normalizeEdge(edge as ExtractionEdge, ingestProvenanceBySourceFile))
    : []
  const hyperedges = Array.isArray(clonedExtraction.hyperedges)
    ? clonedExtraction.hyperedges.filter(isRecord).map((hyperedge) => normalizeHyperedge(hyperedge as Hyperedge, ingestProvenanceBySourceFile))
    : []

  return {
    ...clonedExtraction,
    schema_version: normalizeSchemaVersion(clonedExtraction.schema_version),
    nodes,
    edges,
    hyperedges,
  }
}
