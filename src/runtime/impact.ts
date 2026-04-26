import { KnowledgeGraph } from '../contracts/graph.js'
import { communitiesFromGraph } from './serve.js'

const MAX_IMPACT_DEPTH = 5
const MAX_IMPACT_NODES = 500

export interface ImpactOptions {
  label: string
  depth?: number
  edgeTypes?: string[]
}

export interface ImpactNode {
  label: string
  source_file: string
  node_kind: string
  file_type: string
  community: number | null
  community_label: string | null
  distance: number
  relation: string
}

export interface ImpactResult {
  target: string
  target_file: string
  depth: number
  direct_dependents: ImpactNode[]
  transitive_dependents: ImpactNode[]
  affected_files: string[]
  affected_communities: Array<{ id: number; label: string; node_count: number }>
  top_paths_per_community: Array<{ id: number; label: string; distance: number; path: string[] }>
  total_affected: number
}

function findNodeByLabel(graph: KnowledgeGraph, label: string): string | null {
  const normalizedLabel = label.toLowerCase()

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const nodeLabel = String(attributes.label ?? '').toLowerCase()
    if (nodeLabel === normalizedLabel) {
      return nodeId
    }
  }

  // Prefix match fallback
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const nodeLabel = String(attributes.label ?? '').toLowerCase()
    if (nodeLabel.startsWith(normalizedLabel) || normalizedLabel.startsWith(nodeLabel)) {
      return nodeId
    }
  }

  return null
}

function parseCommunityId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw)
  }
  return null
}

function edgeRelation(graph: KnowledgeGraph, source: string, target: string): string {
  try {
    return String(graph.edgeAttributes(source, target).relation ?? 'related_to')
  } catch {
    try {
      return String(graph.edgeAttributes(target, source).relation ?? 'related_to')
    } catch {
      return 'related_to'
    }
  }
}

function matchesEdgeType(relation: string, edgeTypes: string[] | undefined): boolean {
  if (!edgeTypes || edgeTypes.length === 0) {
    return true
  }
  return edgeTypes.some((type) => relation === type)
}

export function analyzeImpact(
  graph: KnowledgeGraph,
  communityLabels: Record<number, string>,
  options: ImpactOptions,
): ImpactResult {
  const maxDepth = Math.min(options.depth ?? 3, MAX_IMPACT_DEPTH)
  const targetNodeId = findNodeByLabel(graph, options.label)

  if (!targetNodeId) {
    return {
      target: options.label,
      target_file: '',
      depth: maxDepth,
      direct_dependents: [],
      transitive_dependents: [],
      affected_files: [],
      affected_communities: [],
      top_paths_per_community: [],
      total_affected: 0,
    }
  }

  const targetAttributes = graph.nodeAttributes(targetNodeId)
  const communities = communitiesFromGraph(graph)

  // BFS to find all dependents at each distance
  const visited = new Map<string, number>() // nodeId -> distance
  const queue: Array<{ nodeId: string; distance: number; path: string[] }> = [{ nodeId: targetNodeId, distance: 0, path: [targetNodeId] }]
  visited.set(targetNodeId, 0)

  const directDependents: ImpactNode[] = []
  const transitiveDependents: ImpactNode[] = []
  const discoveredDependents: Array<{ nodeId: string; path: string[]; node: ImpactNode }> = []

  while (queue.length > 0 && visited.size < MAX_IMPACT_NODES) {
    const current = queue.shift()
    if (!current || current.distance >= maxDepth) {
      continue
    }

    const dependents = graph.predecessors(current.nodeId)
    for (const dependentId of dependents) {
      if (visited.has(dependentId)) {
        continue
      }

      const relation = edgeRelation(graph, dependentId, current.nodeId)
      if (!matchesEdgeType(relation, options.edgeTypes)) {
        continue
      }

      const distance = current.distance + 1
      const path = [...current.path, dependentId]
      visited.set(dependentId, distance)

      const attributes = graph.nodeAttributes(dependentId)
      const community = parseCommunityId(attributes.community)
      const node: ImpactNode = {
        label: String(attributes.label ?? dependentId),
        source_file: String(attributes.source_file ?? ''),
        node_kind: String(attributes.node_kind ?? ''),
        file_type: String(attributes.file_type ?? ''),
        community,
        community_label: community !== null ? (communityLabels[community] ?? null) : null,
        distance,
        relation,
      }

      if (distance === 1) {
        directDependents.push(node)
      } else {
        transitiveDependents.push(node)
      }

      discoveredDependents.push({ nodeId: dependentId, path, node })
      queue.push({ nodeId: dependentId, distance, path })
    }
  }

  // Affected files (deduplicated)
  const fileSet = new Set<string>()
  for (const discovered of discoveredDependents) {
    if (discovered.node.source_file) {
      fileSet.add(discovered.node.source_file)
    }
  }

  // Affected communities (deduplicated with counts)
  const communityMap = new Map<number, number>()
  const topPathsByCommunity = new Map<number, { distance: number; path: string[] }>()
  for (const discovered of discoveredDependents) {
    const { node, path } = discovered
    if (node.community !== null) {
      communityMap.set(node.community, (communityMap.get(node.community) ?? 0) + 1)

      const labeledPath = path.map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId))
      const existing = topPathsByCommunity.get(node.community)
      const shouldReplace =
        !existing ||
        node.distance < existing.distance ||
        (node.distance === existing.distance && labeledPath.join('\u0000') < existing.path.join('\u0000'))

      if (shouldReplace) {
        topPathsByCommunity.set(node.community, { distance: node.distance, path: labeledPath })
      }
    }
  }

  const affectedCommunities = [...communityMap.entries()]
    .map(([id, count]) => ({
      id,
      label: communityLabels[id] ?? `Community ${id}`,
      node_count: count,
    }))
    .sort((a, b) => b.node_count - a.node_count)

  const topPathsPerCommunity = [...topPathsByCommunity.entries()]
    .map(([id, value]) => ({
      id,
      label: communityLabels[id] ?? `Community ${id}`,
      distance: value.distance,
      path: value.path,
    }))
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))

  return {
    target: String(targetAttributes.label ?? targetNodeId),
    target_file: String(targetAttributes.source_file ?? ''),
    depth: maxDepth,
    direct_dependents: directDependents.sort((a, b) => a.label.localeCompare(b.label)),
    transitive_dependents: transitiveDependents.sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label)),
    affected_files: [...fileSet].sort(),
    affected_communities: affectedCommunities,
    top_paths_per_community: topPathsPerCommunity,
    total_affected: directDependents.length + transitiveDependents.length,
  }
}

export function callChains(
  graph: KnowledgeGraph,
  source: string,
  target: string,
  maxHops = 8,
  edgeTypes: string[] = ['calls', 'imports_from'],
): string[][] {
  const sourceNodeId = findNodeByLabel(graph, source)
  const targetNodeId = findNodeByLabel(graph, target)

  if (!sourceNodeId || !targetNodeId) {
    return []
  }

  const chains: string[][] = []
  const maxChains = 10

  const dfs = (current: string, path: string[], visited: Set<string>): void => {
    if (chains.length >= maxChains) {
      return
    }
    if (path.length > maxHops + 1) {
      return
    }

    if (current === targetNodeId && path.length > 1) {
      chains.push(path.map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId)))
      return
    }

    for (const neighbor of graph.neighbors(current)) {
      if (visited.has(neighbor)) {
        continue
      }

      const relation = edgeRelation(graph, current, neighbor)
      if (!matchesEdgeType(relation, edgeTypes)) {
        continue
      }

      visited.add(neighbor)
      dfs(neighbor, [...path, neighbor], visited)
      visited.delete(neighbor)
    }
  }

  const visited = new Set<string>([sourceNodeId])
  dfs(sourceNodeId, [sourceNodeId], visited)

  return chains.sort((a, b) => a.length - b.length)
}
