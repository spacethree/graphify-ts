import type { ExtractionEdge, ExtractionNode } from '../../../contracts/types.js'
import type { ExtractionFragment } from '../dispatch.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const JS_FRAMEWORK_ADAPTERS: readonly JsFrameworkAdapter[] = []
const EXTERNAL_TARGET_RELATIONS = new Set(['imports', 'imports_from'])

function dedupeNodes(nodes: readonly ExtractionNode[]): ExtractionNode[] {
  const seenIds = new Set<string>()
  const deduped: ExtractionNode[] = []

  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      continue
    }

    seenIds.add(node.id)
    deduped.push(node)
  }

  return deduped
}

function dedupeEdges(edges: readonly ExtractionEdge[]): ExtractionEdge[] {
  const seenEdges = new Set<string>()
  const deduped: ExtractionEdge[] = []

  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.relation}|${edge.source_location ?? ''}`
    if (seenEdges.has(key)) {
      continue
    }

    seenEdges.add(key)
    deduped.push(edge)
  }

  return deduped
}

function filterJsExtractionEdges(nodes: readonly ExtractionNode[], edges: readonly ExtractionEdge[]): ExtractionEdge[] {
  const validNodeIds = new Set(nodes.map((node) => node.id))

  return edges.filter(
    (edge) =>
      validNodeIds.has(edge.source) &&
      (validNodeIds.has(edge.target) ||
        EXTERNAL_TARGET_RELATIONS.has(edge.relation) ||
        (edge.relation === 'renders' && typeof edge.target === 'string' && edge.target.endsWith('__jsx_proxy'))),
  )
}

function mergeFrameworkFragments(baseExtraction: ExtractionFragment, fragments: readonly ExtractionFragment[]): ExtractionFragment {
  const nodes = dedupeNodes([...(baseExtraction.nodes ?? []), ...fragments.flatMap((fragment) => fragment.nodes ?? [])])
  const edges = dedupeEdges([...(baseExtraction.edges ?? []), ...fragments.flatMap((fragment) => fragment.edges ?? [])])

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
