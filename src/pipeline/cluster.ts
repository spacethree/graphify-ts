import { KnowledgeGraph } from '../contracts/graph.js'

export type Communities = Record<number, string[]>

function edgeKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000')
}

function connectedComponents(graph: KnowledgeGraph, blockedEdges: Set<string> = new Set()): string[][] {
  const visited = new Set<string>()
  const components: string[][] = []

  for (const nodeId of [...graph.nodeIds()].sort()) {
    if (visited.has(nodeId)) {
      continue
    }

    const stack = [nodeId]
    const component: string[] = []
    visited.add(nodeId)

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) {
        continue
      }
      component.push(current)

      for (const neighbor of graph.incidentNeighbors(current)) {
        if (blockedEdges.has(edgeKey(current, neighbor)) || visited.has(neighbor)) {
          continue
        }
        visited.add(neighbor)
        stack.push(neighbor)
      }
    }

    components.push(component.sort())
  }

  return components
}

function bridgeEdges(graph: KnowledgeGraph): Set<string> {
  const discovery = new Map<string, number>()
  const low = new Map<string, number>()
  const bridges = new Set<string>()
  let time = 0

  const visit = (nodeId: string, parentId: string | null): void => {
    time += 1
    discovery.set(nodeId, time)
    low.set(nodeId, time)

    for (const neighbor of graph.incidentNeighbors(nodeId)) {
      if (neighbor === parentId) {
        continue
      }

      if (!discovery.has(neighbor)) {
        visit(neighbor, nodeId)
        low.set(nodeId, Math.min(low.get(nodeId) ?? Infinity, low.get(neighbor) ?? Infinity))
        if ((low.get(neighbor) ?? Infinity) > (discovery.get(nodeId) ?? Infinity)) {
          bridges.add(edgeKey(nodeId, neighbor))
        }
      } else {
        low.set(nodeId, Math.min(low.get(nodeId) ?? Infinity, discovery.get(neighbor) ?? Infinity))
      }
    }
  }

  for (const nodeId of [...graph.nodeIds()].sort()) {
    if (!discovery.has(nodeId)) {
      visit(nodeId, null)
    }
  }

  return bridges
}

export function cluster(graph: KnowledgeGraph): Communities {
  if (graph.numberOfNodes() === 0) {
    return {}
  }

  if (graph.numberOfEdges() === 0) {
    return Object.fromEntries([...graph.nodeIds()].sort().map((nodeId, index) => [index, [nodeId]]))
  }

  const communities = connectedComponents(graph, bridgeEdges(graph))
  communities.sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!))

  return Object.fromEntries(communities.map((nodes, index) => [index, nodes]))
}

export function cohesionScore(graph: KnowledgeGraph, communityNodes: string[]): number {
  const nodeCount = communityNodes.length
  if (nodeCount <= 1) {
    return 1
  }

  const communitySet = new Set(communityNodes)
  const actualEdges = new Set<string>()
  for (const [source, target] of graph.edgeEntries()) {
    if (communitySet.has(source) && communitySet.has(target)) {
      actualEdges.add(edgeKey(source, target))
    }
  }

  const possibleEdges = (nodeCount * (nodeCount - 1)) / 2
  return possibleEdges > 0 ? Math.round((actualEdges.size / possibleEdges) * 100) / 100 : 0
}

export function scoreAll(graph: KnowledgeGraph, communities: Communities): Record<number, number> {
  return Object.fromEntries(Object.entries(communities).map(([communityId, nodeIds]) => [Number(communityId), cohesionScore(graph, nodeIds)]))
}
