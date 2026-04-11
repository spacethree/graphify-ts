import { KnowledgeGraph } from '../contracts/graph.js'
import type { ExtractionData } from '../contracts/types.js'
import { validateExtraction } from '../contracts/extraction.js'
import { isRecord } from '../shared/guards.js'

type CombinedExtraction = {
  nodes: ExtractionData['nodes']
  edges: ExtractionData['edges']
  hyperedges: NonNullable<ExtractionData['hyperedges']>
  input_tokens: number
  output_tokens: number
}

export interface BuildGraphOptions {
  directed?: boolean
}

export function buildFromJson(extraction: unknown, options: BuildGraphOptions = {}): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: options.directed === true })
  if (!isRecord(extraction)) {
    return graph
  }

  const errors = validateExtraction(extraction)
  const nonDanglingErrors = errors.filter((error) => !error.includes('does not match any node id'))

  if (nonDanglingErrors.length > 0) {
    console.warn(`[graphify-ts] Extraction warning (${nonDanglingErrors.length} issues): ${nonDanglingErrors[0]}`)
  }

  const nodes = Array.isArray(extraction.nodes) ? extraction.nodes.filter(isRecord) : []
  for (const node of nodes) {
    const { id, ...attributes } = node
    if (typeof id === 'string') {
      graph.addNode(id, attributes)
    }
  }

  const nodeIds = new Set(graph.nodeIds())
  const edges = Array.isArray(extraction.edges) ? extraction.edges.filter(isRecord) : []
  for (const edge of edges) {
    const source = typeof edge.source === 'string' ? edge.source : null
    const target = typeof edge.target === 'string' ? edge.target : null
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      continue
    }

    const { source: _source, target: _target, ...attributes } = edge
    graph.addEdge(source, target, {
      ...attributes,
      _src: source,
      _tgt: target,
    })
  }

  const hyperedges = Array.isArray(extraction.hyperedges) ? extraction.hyperedges : []
  if (hyperedges.length > 0) {
    graph.graph.hyperedges = hyperedges
  }
  graph.graph.directed = graph.isDirected()

  return graph
}

export function build(extractions: ExtractionData[], options: BuildGraphOptions = {}): KnowledgeGraph {
  const combined: CombinedExtraction = {
    nodes: [],
    edges: [],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  }

  for (const extraction of extractions) {
    combined.nodes.push(...extraction.nodes)
    combined.edges.push(...extraction.edges)
    combined.hyperedges.push(...(extraction.hyperedges ?? []))
    combined.input_tokens += typeof extraction.input_tokens === 'number' ? extraction.input_tokens : 0
    combined.output_tokens += typeof extraction.output_tokens === 'number' ? extraction.output_tokens : 0
  }

  return buildFromJson(combined, options)
}
