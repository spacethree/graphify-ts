import type { ExtractionData, ExtractionEdge, ExtractionNode, ExtractionSchemaVersion, Hyperedge } from '../../contracts/types.js'
import { isRecord } from '../../shared/guards.js'
import { DEFAULT_EXTRACTION_LAYER, type ExtractionLayer } from '../layers/types.js'
import { appendDerivedProvenance, deriveIngestProvenanceFromRecord, normalizeMetadataString } from '../provenance/ingest.js'
import { createBaselineProvenance, type ExtractionProvenance } from '../provenance/types.js'

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

function buildIngestProvenanceBySourceFile(nodes: unknown): Map<string, ExtractionProvenance> {
  const records = Array.isArray(nodes) ? nodes.filter(isRecord) : []
  const provenanceBySourceFile = new Map<string, ExtractionProvenance>()

  for (const node of records) {
    const sourceFile = normalizeMetadataString(node.source_file)
    if (!sourceFile || provenanceBySourceFile.has(sourceFile)) {
      continue
    }

    const ingestProvenance = deriveIngestProvenanceFromRecord(node)
    if (ingestProvenance) {
      provenanceBySourceFile.set(sourceFile, ingestProvenance)
    }
  }

  return provenanceBySourceFile
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
