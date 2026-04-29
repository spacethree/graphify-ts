import type { ExtractionEdge, ExtractionNode } from '../../../contracts/types.js'
import type { ExtractionFragment } from '../dispatch.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const JS_FRAMEWORK_ADAPTERS: readonly JsFrameworkAdapter[] = []
const EXTERNAL_TARGET_RELATIONS = new Set(['imports', 'imports_from'])

function mergeNodeAttributes(existing: ExtractionNode, incoming: ExtractionNode): ExtractionNode {
  return {
    ...existing,
    ...incoming,
    id: existing.id,
  }
}

function mergeNodes(nodes: readonly ExtractionNode[]): ExtractionNode[] {
  const mergedNodes = new Map<string, ExtractionNode>()

  for (const node of nodes) {
    const existingNode = mergedNodes.get(node.id)
    if (existingNode) {
      mergedNodes.set(node.id, mergeNodeAttributes(existingNode, node))
      continue
    }

    mergedNodes.set(node.id, node)
  }

  return [...mergedNodes.values()]
}

function edgeDedupeKey(edge: ExtractionEdge): string {
  return `${edge.source}|${edge.target}|${edge.relation}|${edge.source_location ?? ''}`
}

function edgePairKey(edge: Pick<ExtractionEdge, 'source' | 'target'>): string {
  return [edge.source, edge.target].sort().join('|')
}

function isFrameworkScopedEdge(edge: Pick<ExtractionEdge, 'relation'>): boolean {
  return edge.relation.startsWith('framework_')
}

function dedupeEdges(edges: readonly ExtractionEdge[]): ExtractionEdge[] {
  const seenEdges = new Set<string>()
  const deduped: ExtractionEdge[] = []

  for (const edge of edges) {
    const key = edgeDedupeKey(edge)
    if (seenEdges.has(key)) {
      continue
    }

    seenEdges.add(key)
    deduped.push(edge)
  }

  return deduped
}

function mergeFrameworkEdges(
  baseEdges: readonly ExtractionEdge[],
  frameworkEdges: readonly ExtractionEdge[],
): ExtractionEdge[] {
  const dedupedBaseEdges = dedupeEdges(baseEdges)
  const seenPairs = new Set(dedupedBaseEdges.map((edge) => edgePairKey(edge)))
  const seenFrameworkEdges = new Set<string>()
  const acceptedFrameworkEdges: ExtractionEdge[] = []

  for (const edge of frameworkEdges) {
    const dedupeKey = edgeDedupeKey(edge)
    if (seenFrameworkEdges.has(dedupeKey)) {
      continue
    }

    seenFrameworkEdges.add(dedupeKey)

    const pairKey = edgePairKey(edge)
    if (seenPairs.has(pairKey)) {
      continue
    }

    seenPairs.add(pairKey)
    acceptedFrameworkEdges.push(edge)
  }

  return [...dedupedBaseEdges, ...acceptedFrameworkEdges]
}

function filterJsExtractionEdges(nodes: readonly ExtractionNode[], edges: readonly ExtractionEdge[]): ExtractionEdge[] {
  const validNodeIds = new Set(nodes.map((node) => node.id))

  return edges.filter(
    (edge) =>
      validNodeIds.has(edge.source) &&
      (validNodeIds.has(edge.target) ||
        isFrameworkScopedEdge(edge) ||
        EXTERNAL_TARGET_RELATIONS.has(edge.relation) ||
        (edge.relation === 'renders' && typeof edge.target === 'string' && edge.target.endsWith('__jsx_proxy'))),
  )
}

function mergeFrameworkFragments(baseExtraction: ExtractionFragment, fragments: readonly ExtractionFragment[]): ExtractionFragment {
  const nodes = mergeNodes([...(baseExtraction.nodes ?? []), ...fragments.flatMap((fragment) => fragment.nodes ?? [])])
  const edges = mergeFrameworkEdges(
    baseExtraction.edges ?? [],
    fragments.flatMap((fragment) => fragment.edges ?? []),
  )

  return {
    nodes,
    edges: filterJsExtractionEdges(nodes, edges),
  }
}

export function applyJsFrameworkAdapters(
  baseExtraction: ExtractionFragment,
  context: JsFrameworkContext,
  adapters: readonly JsFrameworkAdapter[] = JS_FRAMEWORK_ADAPTERS,
): ExtractionFragment {
  const matchingAdapters = adapters.filter((adapter) => adapter.matches(context.filePath, context.sourceText))
  if (matchingAdapters.length === 0) {
    return baseExtraction
  }

  return mergeFrameworkFragments(
    baseExtraction,
    matchingAdapters.map((adapter) =>
      adapter.extract({
        ...context,
        baseExtraction,
      }),
    ),
  )
}
