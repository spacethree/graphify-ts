import { readFileSync, statSync } from 'node:fs'

import { buildFromJson } from '../pipeline/build.js'
import type { Communities } from '../pipeline/cluster.js'
import { isRecord } from '../shared/guards.js'
import { sanitizeLabel, validateGraphPath } from '../shared/security.js'
import { KnowledgeGraph } from '../contracts/graph.js'

const MAX_GRAPH_BYTES = 100 * 1024 * 1024
const MAX_TRAVERSAL_DEPTH = 6

export function loadGraph(graphPath: string): KnowledgeGraph {
  const safePath = validateGraphPath(graphPath)
  if (statSync(safePath).size > MAX_GRAPH_BYTES) {
    throw new Error(`Graph file too large: ${safePath}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(safePath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`graph.json is corrupted (${error.message}). Re-run graphify to rebuild.`)
    }
    throw error
  }

  if (!isRecord(parsed)) {
    return new KnowledgeGraph()
  }

  const extraction = {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.links) ? parsed.links : Array.isArray(parsed.edges) ? parsed.edges : [],
    hyperedges: Array.isArray(parsed.hyperedges) ? parsed.hyperedges : [],
  }

  return buildFromJson(extraction)
}

export function communitiesFromGraph(graph: KnowledgeGraph): Communities {
  const buckets = new Map<number, string[]>()

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const community = attributes.community
    if (typeof community === 'number' && Number.isFinite(community)) {
      const nodes = buckets.get(community) ?? []
      nodes.push(nodeId)
      buckets.set(community, nodes)
      continue
    }
    if (typeof community === 'string' && community.trim() !== '' && !Number.isNaN(Number(community))) {
      const communityId = Number(community)
      const nodes = buckets.get(communityId) ?? []
      nodes.push(nodeId)
      buckets.set(communityId, nodes)
    }
  }

  return Object.fromEntries([...buckets.entries()].map(([communityId, nodes]) => [communityId, [...nodes]]))
}

export function scoreNodes(graph: KnowledgeGraph, terms: string[]): Array<[number, string]> {
  const normalizedTerms = terms.map((term) => term.toLowerCase()).filter((term) => term.length > 0)
  if (normalizedTerms.length === 0) {
    return []
  }

  return graph
    .nodeEntries()
    .map(([nodeId, attributes]) => {
      const label = String(attributes.label ?? '').toLowerCase()
      const source = String(attributes.source_file ?? '').toLowerCase()
      const score = normalizedTerms.reduce((total, term) => total + (label.includes(term) ? 1 : 0) + (source.includes(term) ? 0.5 : 0), 0)
      return [score, nodeId] as [number, string]
    })
    .filter(([score]) => score > 0)
    .sort((left, right) => right[0] - left[0] || left[1].localeCompare(right[1]))
}

export function bfs(graph: KnowledgeGraph, startNodes: string[], depth: number): { visited: Set<string>; edges: Array<[string, string]> } {
  if (depth < 0) {
    throw new Error('depth must be non-negative')
  }

  const seeds = startNodes.filter((nodeId) => graph.hasNode(nodeId))
  const visited = new Set(seeds)
  let frontier = new Set(seeds)
  const edges: Array<[string, string]> = []

  for (let level = 0; level < depth; level += 1) {
    const nextFrontier = new Set<string>()
    for (const nodeId of frontier) {
      for (const neighbor of graph.neighbors(nodeId)) {
        if (visited.has(neighbor)) {
          continue
        }
        nextFrontier.add(neighbor)
        edges.push([nodeId, neighbor])
      }
    }
    for (const nodeId of nextFrontier) {
      visited.add(nodeId)
    }
    frontier = nextFrontier
  }

  return { visited, edges }
}

export function dfs(graph: KnowledgeGraph, startNodes: string[], depth: number): { visited: Set<string>; edges: Array<[string, string]> } {
  if (depth < 0) {
    throw new Error('depth must be non-negative')
  }

  const visited = new Set<string>()
  const edges: Array<[string, string]> = []
  const stack: Array<[string, number]> = [...startNodes]
    .filter((nodeId) => graph.hasNode(nodeId))
    .reverse()
    .map((nodeId) => [nodeId, 0])

  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) {
      continue
    }

    const [nodeId, currentDepth] = entry
    if (visited.has(nodeId) || currentDepth > depth) {
      continue
    }

    visited.add(nodeId)
    for (const neighbor of graph.neighbors(nodeId)) {
      if (visited.has(neighbor)) {
        continue
      }
      stack.push([neighbor, currentDepth + 1])
      edges.push([nodeId, neighbor])
    }
  }

  return { visited, edges }
}

export function subgraphToText(graph: KnowledgeGraph, nodes: Set<string>, edges: Array<[string, string]>, tokenBudget = 2000): string {
  if (tokenBudget <= 0) {
    throw new Error('tokenBudget must be positive')
  }

  const charBudget = tokenBudget * 3
  const lines: string[] = []

  const sortedNodes = [...nodes].filter((nodeId) => graph.hasNode(nodeId)).sort((left, right) => graph.degree(right) - graph.degree(left) || left.localeCompare(right))
  for (const nodeId of sortedNodes) {
    const attributes = graph.nodeAttributes(nodeId)
    lines.push(
      `NODE ${sanitizeLabel(String(attributes.label ?? nodeId))} [src=${String(attributes.source_file ?? '')} loc=${String(attributes.source_location ?? '')} community=${String(attributes.community ?? '')}]`,
    )
  }

  for (const [source, target] of edges) {
    if (!nodes.has(source) || !nodes.has(target)) {
      continue
    }
    if (!graph.hasNode(source) || !graph.hasNode(target)) {
      continue
    }

    const attributes = graph.edgeAttributes(source, target)
    lines.push(
      `EDGE ${sanitizeLabel(String(graph.nodeAttributes(source).label ?? source))} --${String(attributes.relation ?? '')} [${String(attributes.confidence ?? '')}]--> ${sanitizeLabel(String(graph.nodeAttributes(target).label ?? target))}`,
    )
  }

  const output = lines.join('\n')
  if (output.length > charBudget) {
    return `${output.slice(0, charBudget)}\n... (truncated to ~${tokenBudget} token budget)`
  }
  return output
}

function findNodeIds(graph: KnowledgeGraph, label: string): string[] {
  const term = label.toLowerCase()
  return graph
    .nodeEntries()
    .filter(([nodeId, attributes]) => {
      const nodeLabel = String(attributes.label ?? '').toLowerCase()
      return nodeLabel.includes(term) || nodeId.toLowerCase() === term
    })
    .map(([nodeId]) => nodeId)
}

export function queryGraph(graph: KnowledgeGraph, question: string, options: { mode?: 'bfs' | 'dfs'; depth?: number; tokenBudget?: number } = {}): string {
  const mode = options.mode ?? 'bfs'
  const depth = Math.min(Math.max(options.depth ?? 2, 0), MAX_TRAVERSAL_DEPTH)
  const tokenBudget = options.tokenBudget ?? 2000
  const terms = question
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2)
  const startNodes = scoreNodes(graph, terms)
    .slice(0, 5)
    .map(([, nodeId]) => nodeId)

  if (startNodes.length === 0) {
    return 'No matching nodes found.'
  }

  const traversal = mode === 'dfs' ? dfs(graph, startNodes, depth) : bfs(graph, startNodes, depth)
  const startLabels = startNodes.map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId))
  return `Traversal: ${mode.toUpperCase()} depth=${depth} | Start: ${JSON.stringify(startLabels)} | ${traversal.visited.size} nodes found\n\n${subgraphToText(graph, traversal.visited, traversal.edges, tokenBudget)}`
}

export function getNode(graph: KnowledgeGraph, label: string): string {
  const match = findNodeIds(graph, label)[0]
  if (!match) {
    return `No node matching '${label.toLowerCase()}' found.`
  }

  const attributes = graph.nodeAttributes(match)
  return [
    `Node: ${String(attributes.label ?? match)}`,
    `  ID: ${match}`,
    `  Source: ${String(attributes.source_file ?? '')} ${String(attributes.source_location ?? '')}`.trimEnd(),
    `  Type: ${String(attributes.file_type ?? '')}`,
    `  Community: ${String(attributes.community ?? '')}`,
    `  Degree: ${graph.degree(match)}`,
  ].join('\n')
}

export function getNeighbors(graph: KnowledgeGraph, label: string, relationFilter = ''): string {
  const match = findNodeIds(graph, label)[0]
  if (!match) {
    return `No node matching '${label.toLowerCase()}' found.`
  }

  const normalizedFilter = relationFilter.toLowerCase()
  const lines = [`Neighbors of ${String(graph.nodeAttributes(match).label ?? match)}:`]
  for (const neighbor of graph.neighbors(match)) {
    const edgeAttributes = graph.edgeAttributes(match, neighbor)
    const relation = String(edgeAttributes.relation ?? '')
    if (normalizedFilter && !relation.toLowerCase().includes(normalizedFilter)) {
      continue
    }
    lines.push(`  --> ${String(graph.nodeAttributes(neighbor).label ?? neighbor)} [${relation}] [${String(edgeAttributes.confidence ?? '')}]`)
  }
  return lines.join('\n')
}

export function getCommunity(graph: KnowledgeGraph, communities: Communities, communityId: number): string {
  const nodes = communities[communityId] ?? []
  if (nodes.length === 0) {
    return `Community ${communityId} not found.`
  }

  const lines = [`Community ${communityId} (${nodes.length} nodes):`]
  for (const nodeId of nodes) {
    const attributes = graph.nodeAttributes(nodeId)
    lines.push(`  ${String(attributes.label ?? nodeId)} [${String(attributes.source_file ?? '')}]`)
  }
  return lines.join('\n')
}

export function graphStats(graph: KnowledgeGraph, communities: Communities = communitiesFromGraph(graph)): string {
  const confidences = graph.edgeEntries().map(([, , attributes]) => String(attributes.confidence ?? 'EXTRACTED'))
  const total = confidences.length || 1
  return [
    `Nodes: ${graph.numberOfNodes()}`,
    `Edges: ${graph.numberOfEdges()}`,
    `Communities: ${Object.keys(communities).length}`,
    `EXTRACTED: ${Math.round((confidences.filter((confidence) => confidence === 'EXTRACTED').length / total) * 100)}%`,
    `INFERRED: ${Math.round((confidences.filter((confidence) => confidence === 'INFERRED').length / total) * 100)}%`,
    `AMBIGUOUS: ${Math.round((confidences.filter((confidence) => confidence === 'AMBIGUOUS').length / total) * 100)}%`,
  ].join('\n')
}

function shortestPathNodeIds(graph: KnowledgeGraph, sourceNodeId: string, targetNodeId: string, maxDepth: number): string[] | null {
  if (sourceNodeId === targetNodeId) {
    return [sourceNodeId]
  }

  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: sourceNodeId, depth: 0 }]
  const previous = new Map<string, string>()
  const visited = new Set<string>([sourceNodeId])

  while (queue.length > 0) {
    const entry = queue.shift()
    if (!entry) {
      continue
    }

    const { nodeId, depth } = entry
    if (depth >= maxDepth) {
      continue
    }

    for (const neighbor of graph.neighbors(nodeId)) {
      if (visited.has(neighbor)) {
        continue
      }
      visited.add(neighbor)
      previous.set(neighbor, nodeId)
      if (neighbor === targetNodeId) {
        const path = [targetNodeId]
        let cursor = targetNodeId
        while (previous.has(cursor)) {
          const prior = previous.get(cursor)
          if (!prior) {
            break
          }
          path.unshift(prior)
          cursor = prior
        }
        return path
      }
      queue.push({ nodeId: neighbor, depth: depth + 1 })
    }
  }

  return null
}

export function shortestPath(graph: KnowledgeGraph, source: string, target: string, maxHops = 8): string {
  if (maxHops <= 0) {
    throw new Error('maxHops must be positive')
  }

  const sourceMatch = scoreNodes(
    graph,
    source
      .split(/\s+/)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length > 0),
  )[0]
  const targetMatch = scoreNodes(
    graph,
    target
      .split(/\s+/)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length > 0),
  )[0]

  if (!sourceMatch) {
    return `No node matching source '${source}' found.`
  }
  if (!targetMatch) {
    return `No node matching target '${target}' found.`
  }

  const path = shortestPathNodeIds(graph, sourceMatch[1], targetMatch[1], maxHops)
  if (!path) {
    return `No path found within max_hops=${maxHops} between '${String(graph.nodeAttributes(sourceMatch[1]).label ?? sourceMatch[1])}' and '${String(graph.nodeAttributes(targetMatch[1]).label ?? targetMatch[1])}'.`
  }

  const hops = path.length - 1

  const firstNodeId = path[0]
  if (!firstNodeId) {
    return `No path found between '${String(graph.nodeAttributes(sourceMatch[1]).label ?? sourceMatch[1])}' and '${String(graph.nodeAttributes(targetMatch[1]).label ?? targetMatch[1])}'.`
  }

  const segments = [String(graph.nodeAttributes(firstNodeId).label ?? firstNodeId)]
  for (let index = 0; index < path.length - 1; index += 1) {
    const sourceNodeId = path[index]
    const targetNodeId = path[index + 1]
    if (!sourceNodeId || !targetNodeId) {
      continue
    }
    const edgeAttributes = graph.edgeAttributes(sourceNodeId, targetNodeId)
    const confidence = String(edgeAttributes.confidence ?? '')
    segments.push(
      `--${String(edgeAttributes.relation ?? '')}${confidence ? ` [${confidence}]` : ''}--> ${String(graph.nodeAttributes(targetNodeId).label ?? targetNodeId)}`,
    )
  }

  return `Shortest path (${hops} hops):\n  ${segments.join(' ')}`
}
