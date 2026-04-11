import { KnowledgeGraph } from '../contracts/graph.js'
import { CODE_EXTENSIONS, DOC_EXTENSIONS, IMAGE_EXTENSIONS, PAPER_EXTENSIONS } from './detect.js'
import { cohesionScore, type Communities } from './cluster.js'

export interface GodNode {
  id: string
  label: string
  edges: number
}

export interface SurprisingConnection {
  source: string
  target: string
  source_files: [string, string]
  confidence: string
  confidence_score?: number
  relation: string
  why: string
  note?: string
}

export interface SuggestedQuestion {
  type: string
  question: string | null
  why: string
}

export interface GraphDiffResult {
  new_nodes: Array<{ id: string; label: string }>
  removed_nodes: Array<{ id: string; label: string }>
  new_edges: Array<{ source: string; target: string; relation: string; confidence: string }>
  removed_edges: Array<{ source: string; target: string; relation: string; confidence: string }>
  summary: string
}

function edgeKey(left: string, right: string, relation: string, directed = false): string {
  if (directed) {
    return `${left}\u0000${right}\u0000${relation}`
  }
  return [left, right].sort().join('\u0000') + `\u0000${relation}`
}

function edgePairKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000')
}

function nodeLabel(graph: KnowledgeGraph, nodeId: string): string {
  return String(graph.nodeAttributes(nodeId).label ?? nodeId)
}

function nodeSourceFile(graph: KnowledgeGraph, nodeId: string): string {
  return String(graph.nodeAttributes(nodeId).source_file ?? '')
}

function nodeDegreeMap(graph: KnowledgeGraph): Map<string, number> {
  return new Map(graph.nodeIds().map((nodeId) => [nodeId, graph.degree(nodeId)]))
}

function edgeBetweenness(graph: KnowledgeGraph): Map<string, number> {
  const scores = new Map<string, number>()
  for (const [source, target] of graph.edgeEntries()) {
    scores.set(edgePairKey(source, target), 0)
  }

  for (const sourceNode of graph.nodeIds()) {
    const stack: string[] = []
    const predecessors = new Map<string, string[]>()
    const sigma = new Map<string, number>()
    const distance = new Map<string, number>()

    for (const nodeId of graph.nodeIds()) {
      predecessors.set(nodeId, [])
      sigma.set(nodeId, 0)
      distance.set(nodeId, -1)
    }

    sigma.set(sourceNode, 1)
    distance.set(sourceNode, 0)
    const queue: string[] = [sourceNode]

    while (queue.length > 0) {
      const vertex = queue.shift()
      if (!vertex) {
        continue
      }
      stack.push(vertex)

      for (const neighbor of graph.neighbors(vertex)) {
        if ((distance.get(neighbor) ?? -1) < 0) {
          queue.push(neighbor)
          distance.set(neighbor, (distance.get(vertex) ?? 0) + 1)
        }
        if ((distance.get(neighbor) ?? -1) === (distance.get(vertex) ?? 0) + 1) {
          sigma.set(neighbor, (sigma.get(neighbor) ?? 0) + (sigma.get(vertex) ?? 0))
          predecessors.get(neighbor)?.push(vertex)
        }
      }
    }

    const delta = new Map<string, number>(graph.nodeIds().map((nodeId) => [nodeId, 0]))
    while (stack.length > 0) {
      const vertex = stack.pop()
      if (!vertex) {
        continue
      }
      for (const predecessor of predecessors.get(vertex) ?? []) {
        const contribution = ((sigma.get(predecessor) ?? 0) / (sigma.get(vertex) ?? 1)) * (1 + (delta.get(vertex) ?? 0))
        const key = edgePairKey(predecessor, vertex)
        scores.set(key, (scores.get(key) ?? 0) + contribution)
        delta.set(predecessor, (delta.get(predecessor) ?? 0) + contribution)
      }
    }
  }

  for (const [key, value] of scores.entries()) {
    scores.set(key, value / 2)
  }

  return scores
}

function nodeBetweenness(graph: KnowledgeGraph): Map<string, number> {
  const nodeIds = graph.nodeIds()
  const scores = new Map(nodeIds.map((nodeId) => [nodeId, 0]))

  for (const sourceNodeId of nodeIds) {
    const stack: string[] = []
    const predecessors = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]))
    const sigma = new Map(nodeIds.map((nodeId) => [nodeId, 0]))
    const distance = new Map(nodeIds.map((nodeId) => [nodeId, -1]))

    sigma.set(sourceNodeId, 1)
    distance.set(sourceNodeId, 0)
    const queue: string[] = [sourceNodeId]

    while (queue.length > 0) {
      const vertex = queue.shift()
      if (!vertex) {
        continue
      }
      stack.push(vertex)

      for (const neighbor of graph.neighbors(vertex)) {
        if ((distance.get(neighbor) ?? -1) < 0) {
          queue.push(neighbor)
          distance.set(neighbor, (distance.get(vertex) ?? 0) + 1)
        }

        if ((distance.get(neighbor) ?? -1) === (distance.get(vertex) ?? 0) + 1) {
          sigma.set(neighbor, (sigma.get(neighbor) ?? 0) + (sigma.get(vertex) ?? 0))
          predecessors.get(neighbor)?.push(vertex)
        }
      }
    }

    const delta = new Map(nodeIds.map((nodeId) => [nodeId, 0]))
    while (stack.length > 0) {
      const vertex = stack.pop()
      if (!vertex) {
        continue
      }

      for (const predecessor of predecessors.get(vertex) ?? []) {
        const contribution = ((sigma.get(predecessor) ?? 0) / (sigma.get(vertex) ?? 1)) * (1 + (delta.get(vertex) ?? 0))
        delta.set(predecessor, (delta.get(predecessor) ?? 0) + contribution)
      }

      if (vertex !== sourceNodeId) {
        scores.set(vertex, (scores.get(vertex) ?? 0) + (delta.get(vertex) ?? 0))
      }
    }
  }

  for (const [nodeId, value] of scores.entries()) {
    scores.set(nodeId, value / 2)
  }

  return scores
}

export function _nodeCommunityMap(communities: Communities): Record<string, number> {
  const mapping: Record<string, number> = {}
  for (const [communityId, nodeIds] of Object.entries(communities)) {
    for (const nodeId of nodeIds) {
      mapping[nodeId] = Number(communityId)
    }
  }
  return mapping
}

export function _isFileNode(graph: KnowledgeGraph, nodeId: string): boolean {
  const attrs = graph.nodeAttributes(nodeId)
  const label = String(attrs.label ?? '')
  if (!label) {
    return false
  }

  const sourceFile = String(attrs.source_file ?? '')
  if (sourceFile) {
    const fileName = sourceFile.split('/').at(-1)
    if (label === fileName) {
      return true
    }
  }

  if (label.startsWith('.') && label.endsWith('()')) {
    return true
  }

  if (label.endsWith('()') && graph.degree(nodeId) <= 1) {
    return true
  }

  return false
}

export function _isConceptNode(graph: KnowledgeGraph, nodeId: string): boolean {
  const sourceFile = nodeSourceFile(graph, nodeId)
  if (!sourceFile) {
    return true
  }
  return !sourceFile.split('/').at(-1)?.includes('.')
}

export function _fileCategory(path: string): 'code' | 'paper' | 'image' | 'doc' {
  const extension = path.includes('.') ? `.${path.split('.').at(-1)?.toLowerCase() ?? ''}` : ''
  if (CODE_EXTENSIONS.has(extension)) {
    return 'code'
  }
  if (PAPER_EXTENSIONS.has(extension)) {
    return 'paper'
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (DOC_EXTENSIONS.has(extension)) {
    return 'doc'
  }
  return 'doc'
}

function topLevelDir(path: string): string {
  return path.includes('/') ? (path.split('/')[0] ?? path) : path
}

export function _surpriseScore(
  graph: KnowledgeGraph,
  sourceNodeId: string,
  targetNodeId: string,
  edgeData: Record<string, unknown>,
  nodeCommunity: Record<string, number>,
  sourceFile: string,
  targetFile: string,
): [number, string[]] {
  let score = 0
  const reasons: string[] = []

  const confidence = String(edgeData.confidence ?? 'EXTRACTED')
  const confidenceBonus = confidence === 'AMBIGUOUS' ? 3 : confidence === 'INFERRED' ? 2 : 1
  score += confidenceBonus
  if (confidence === 'AMBIGUOUS' || confidence === 'INFERRED') {
    reasons.push(`${confidence.toLowerCase()} connection - not explicitly stated in source`)
  }

  const sourceCategory = _fileCategory(sourceFile)
  const targetCategory = _fileCategory(targetFile)
  if (sourceCategory !== targetCategory) {
    score += 2
    reasons.push(`crosses file types (${sourceCategory} ↔ ${targetCategory})`)
  }

  if (topLevelDir(sourceFile) !== topLevelDir(targetFile)) {
    score += 2
    reasons.push('connects across different repos/directories')
  }

  const sourceCommunity = nodeCommunity[sourceNodeId]
  const targetCommunity = nodeCommunity[targetNodeId]
  if (sourceCommunity !== undefined && targetCommunity !== undefined && sourceCommunity !== targetCommunity) {
    score += 1
    reasons.push('bridges separate communities')
  }

  if (String(edgeData.relation ?? '') === 'semantically_similar_to') {
    score = Math.trunc(score * 1.5)
    reasons.push('semantically similar concepts with no structural link')
  }

  const sourceDegree = graph.degree(sourceNodeId)
  const targetDegree = graph.degree(targetNodeId)
  if (Math.min(sourceDegree, targetDegree) <= 2 && Math.max(sourceDegree, targetDegree) >= 5) {
    score += 1
    const peripheralId = sourceDegree <= 2 ? sourceNodeId : targetNodeId
    const hubId = sourceDegree <= 2 ? targetNodeId : sourceNodeId
    reasons.push(`peripheral node \`${nodeLabel(graph, peripheralId)}\` unexpectedly reaches hub \`${nodeLabel(graph, hubId)}\``)
  }

  return [score, reasons]
}

export function godNodes(graph: KnowledgeGraph, topN = 10): GodNode[] {
  return [...graph.nodeIds()]
    .filter((nodeId) => !_isFileNode(graph, nodeId) && !_isConceptNode(graph, nodeId))
    .sort((left, right) => graph.degree(right) - graph.degree(left) || nodeLabel(graph, left).localeCompare(nodeLabel(graph, right)))
    .slice(0, topN)
    .map((nodeId) => ({
      id: nodeId,
      label: nodeLabel(graph, nodeId),
      edges: graph.degree(nodeId),
    }))
}

function crossFileSurprises(graph: KnowledgeGraph, communities: Communities, topN: number): SurprisingConnection[] {
  const nodeCommunity = _nodeCommunityMap(communities)
  const candidates = graph
    .edgeEntries()
    .map(([sourceNodeId, targetNodeId, edgeData]) => {
      const relation = String(edgeData.relation ?? '')
      if (relation === 'imports' || relation === 'imports_from' || relation === 'contains' || relation === 'method') {
        return null
      }
      if (_isConceptNode(graph, sourceNodeId) || _isConceptNode(graph, targetNodeId)) {
        return null
      }
      if (_isFileNode(graph, sourceNodeId) || _isFileNode(graph, targetNodeId)) {
        return null
      }

      const sourceFile = nodeSourceFile(graph, sourceNodeId)
      const targetFile = nodeSourceFile(graph, targetNodeId)
      if (!sourceFile || !targetFile || sourceFile === targetFile) {
        return null
      }

      const [score, reasons] = _surpriseScore(graph, sourceNodeId, targetNodeId, edgeData, nodeCommunity, sourceFile, targetFile)
      const directedSourceId = typeof edgeData._src === 'string' && graph.hasNode(edgeData._src) ? edgeData._src : sourceNodeId
      const directedTargetId = typeof edgeData._tgt === 'string' && graph.hasNode(edgeData._tgt) ? edgeData._tgt : targetNodeId

      return {
        _score: score,
        connection: {
          source: nodeLabel(graph, directedSourceId),
          target: nodeLabel(graph, directedTargetId),
          source_files: [nodeSourceFile(graph, directedSourceId), nodeSourceFile(graph, directedTargetId)] as [string, string],
          confidence: String(edgeData.confidence ?? 'EXTRACTED'),
          ...(typeof edgeData.confidence_score === 'number' ? { confidence_score: edgeData.confidence_score } : {}),
          relation,
          why: reasons.length > 0 ? reasons.join('; ') : 'cross-file semantic connection',
        } satisfies SurprisingConnection,
      }
    })
    .filter((candidate): candidate is { _score: number; connection: SurprisingConnection } => candidate !== null)

  candidates.sort((left, right) => right._score - left._score)
  return candidates.slice(0, topN).map((candidate) => candidate.connection)
}

function crossCommunitySurprises(graph: KnowledgeGraph, communities: Communities, topN: number): SurprisingConnection[] {
  if (Object.keys(communities).length === 0) {
    const scores = edgeBetweenness(graph)
    return graph
      .edgeEntries()
      .map(([sourceNodeId, targetNodeId, edgeData]) => ({
        score: scores.get(edgePairKey(sourceNodeId, targetNodeId)) ?? 0,
        connection: {
          source: nodeLabel(graph, sourceNodeId),
          target: nodeLabel(graph, targetNodeId),
          source_files: [nodeSourceFile(graph, sourceNodeId), nodeSourceFile(graph, targetNodeId)] as [string, string],
          confidence: String(edgeData.confidence ?? 'EXTRACTED'),
          ...(typeof edgeData.confidence_score === 'number' ? { confidence_score: edgeData.confidence_score } : {}),
          relation: String(edgeData.relation ?? ''),
          why: `bridges graph structure (betweenness=${(scores.get(edgePairKey(sourceNodeId, targetNodeId)) ?? 0).toFixed(3)})`,
          note: `bridges graph structure (betweenness=${(scores.get(edgePairKey(sourceNodeId, targetNodeId)) ?? 0).toFixed(3)})`,
        } satisfies SurprisingConnection,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topN)
      .map((entry) => entry.connection)
  }

  const nodeCommunity = _nodeCommunityMap(communities)
  const order = new Map([
    ['AMBIGUOUS', 0],
    ['INFERRED', 1],
    ['EXTRACTED', 2],
  ])

  const candidates: Array<{ pair: string; priority: number; connection: SurprisingConnection }> = []
  for (const [sourceNodeId, targetNodeId, edgeData] of graph.edgeEntries()) {
    const sourceCommunity = nodeCommunity[sourceNodeId]
    const targetCommunity = nodeCommunity[targetNodeId]
    const relation = String(edgeData.relation ?? '')
    if (sourceCommunity === undefined || targetCommunity === undefined || sourceCommunity === targetCommunity) {
      continue
    }
    if (_isFileNode(graph, sourceNodeId) || _isFileNode(graph, targetNodeId)) {
      continue
    }
    if (relation === 'imports' || relation === 'imports_from' || relation === 'contains' || relation === 'method') {
      continue
    }

    const directedSourceId = typeof edgeData._src === 'string' && graph.hasNode(edgeData._src) ? edgeData._src : sourceNodeId
    const directedTargetId = typeof edgeData._tgt === 'string' && graph.hasNode(edgeData._tgt) ? edgeData._tgt : targetNodeId

    candidates.push({
      pair: [sourceCommunity, targetCommunity].sort((left, right) => left - right).join('\u0000'),
      priority: order.get(String(edgeData.confidence ?? 'EXTRACTED')) ?? 3,
      connection: {
        source: nodeLabel(graph, directedSourceId),
        target: nodeLabel(graph, directedTargetId),
        source_files: [nodeSourceFile(graph, directedSourceId), nodeSourceFile(graph, directedTargetId)],
        confidence: String(edgeData.confidence ?? 'EXTRACTED'),
        ...(typeof edgeData.confidence_score === 'number' ? { confidence_score: edgeData.confidence_score } : {}),
        relation,
        why: `bridges community ${sourceCommunity} → community ${targetCommunity}`,
        note: `bridges community ${sourceCommunity} → community ${targetCommunity}`,
      },
    })
  }

  candidates.sort((left, right) => left.priority - right.priority)

  const seenPairs = new Set<string>()
  const result: SurprisingConnection[] = []
  for (const candidate of candidates) {
    if (seenPairs.has(candidate.pair)) {
      continue
    }
    seenPairs.add(candidate.pair)
    result.push(candidate.connection)
    if (result.length >= topN) {
      break
    }
  }

  return result
}

export function surprisingConnections(graph: KnowledgeGraph, communities: Communities = {}, topN = 5): SurprisingConnection[] {
  const sourceFiles = new Set(
    graph
      .nodeEntries()
      .map(([, attrs]) => String(attrs.source_file ?? ''))
      .filter((sourceFile) => sourceFile.length > 0),
  )

  if (sourceFiles.size > 1) {
    return crossFileSurprises(graph, communities, topN)
  }
  return crossCommunitySurprises(graph, communities, topN)
}

export function suggestQuestions(graph: KnowledgeGraph, communities: Communities, communityLabels: Record<number, string>, topN = 7): SuggestedQuestion[] {
  const questions: SuggestedQuestion[] = []
  const nodeCommunity = _nodeCommunityMap(communities)

  for (const [sourceNodeId, targetNodeId, edgeData] of graph.edgeEntries()) {
    if (String(edgeData.confidence ?? 'EXTRACTED') !== 'AMBIGUOUS') {
      continue
    }

    questions.push({
      type: 'ambiguous_edge',
      question: `What is the exact relationship between \`${nodeLabel(graph, sourceNodeId)}\` and \`${nodeLabel(graph, targetNodeId)}\`?`,
      why: `Edge tagged AMBIGUOUS (relation: ${String(edgeData.relation ?? 'related to')}) - confidence is low.`,
    })
  }

  if (graph.numberOfEdges() > 0) {
    const bridges = [...nodeBetweenness(graph).entries()]
      .filter(([nodeId, score]) => !_isFileNode(graph, nodeId) && !_isConceptNode(graph, nodeId) && score > 0)
      .sort((left, right) => right[1] - left[1] || nodeLabel(graph, left[0]).localeCompare(nodeLabel(graph, right[0])))
      .slice(0, 3)

    for (const [nodeId, score] of bridges) {
      const communityId = nodeCommunity[nodeId]
      const communityName = communityId !== undefined ? (communityLabels[communityId] ?? `Community ${communityId}`) : 'unknown'
      const neighborCommunities = new Set(
        graph
          .neighbors(nodeId)
          .map((neighborId) => nodeCommunity[neighborId])
          .filter((neighborCommunityId): neighborCommunityId is number => neighborCommunityId !== undefined && neighborCommunityId !== communityId),
      )

      if (neighborCommunities.size === 0) {
        continue
      }

      const otherLabels = [...neighborCommunities].map((neighborCommunityId) => communityLabels[neighborCommunityId] ?? `Community ${neighborCommunityId}`)
      questions.push({
        type: 'bridge_node',
        question: `Why does \`${nodeLabel(graph, nodeId)}\` connect \`${communityName}\` to ${otherLabels.map((label) => `\`${label}\``).join(', ')}?`,
        why: `High betweenness centrality (${score.toFixed(3)}) - this node is a cross-community bridge.`,
      })
    }
  }

  const topNodes = [...graph.nodeIds()]
    .filter((nodeId) => !_isFileNode(graph, nodeId) && !_isConceptNode(graph, nodeId))
    .sort((left, right) => graph.degree(right) - graph.degree(left) || nodeLabel(graph, left).localeCompare(nodeLabel(graph, right)))
    .slice(0, 5)

  for (const nodeId of topNodes) {
    const inferred = graph.edgeEntries().filter(([sourceNodeId, targetNodeId, edgeData]) => {
      if (String(edgeData.confidence ?? 'EXTRACTED') !== 'INFERRED') {
        return false
      }
      return sourceNodeId === nodeId || targetNodeId === nodeId
    })

    if (inferred.length < 2) {
      continue
    }

    const otherLabels = inferred.slice(0, 2).map(([sourceNodeId, targetNodeId, edgeData]) => {
      const directedSourceId = typeof edgeData._src === 'string' && graph.hasNode(edgeData._src) ? edgeData._src : sourceNodeId
      const directedTargetId = typeof edgeData._tgt === 'string' && graph.hasNode(edgeData._tgt) ? edgeData._tgt : targetNodeId
      const otherNodeId = directedSourceId === nodeId ? directedTargetId : directedSourceId
      return nodeLabel(graph, otherNodeId)
    })

    questions.push({
      type: 'verify_inferred',
      question: `Are the ${inferred.length} inferred relationships involving \`${nodeLabel(graph, nodeId)}\` (e.g. with \`${otherLabels[0]}\` and \`${otherLabels[1]}\`) actually correct?`,
      why: `\`${nodeLabel(graph, nodeId)}\` has ${inferred.length} INFERRED edges - model-reasoned connections that need verification.`,
    })
  }

  const isolated = graph.nodeIds().filter((nodeId) => graph.degree(nodeId) <= 1 && !_isFileNode(graph, nodeId) && !_isConceptNode(graph, nodeId))
  if (isolated.length > 0) {
    const labels = isolated.slice(0, 3).map((nodeId) => `\`${nodeLabel(graph, nodeId)}\``)
    questions.push({
      type: 'isolated_nodes',
      question: `What connects ${labels.join(', ')} to the rest of the system?`,
      why: `${isolated.length} weakly-connected nodes found - possible documentation gaps or missing edges.`,
    })
  }

  for (const [communityIdRaw, nodeIds] of Object.entries(communities)) {
    const communityId = Number(communityIdRaw)
    const score = cohesionScore(graph, nodeIds)
    if (score >= 0.15 || nodeIds.length < 5) {
      continue
    }

    const label = communityLabels[communityId] ?? `Community ${communityId}`
    questions.push({
      type: 'low_cohesion',
      question: `Should \`${label}\` be split into smaller, more focused modules?`,
      why: `Cohesion score ${score} - nodes in this community are weakly interconnected.`,
    })
  }

  if (questions.length === 0) {
    return [
      {
        type: 'no_signal',
        question: null,
        why: 'Not enough signal to generate questions. This usually means the corpus has no AMBIGUOUS edges, no bridge nodes, no INFERRED relationships, and all communities are tightly cohesive. Add more files or extract richer edges.',
      },
    ]
  }

  return questions.slice(0, topN)
}

export function graphDiff(oldGraph: KnowledgeGraph, newGraph: KnowledgeGraph): GraphDiffResult {
  const oldNodes = new Set(oldGraph.nodeIds())
  const newNodes = new Set(newGraph.nodeIds())

  const newNodesList = [...newNodes].filter((nodeId) => !oldNodes.has(nodeId)).map((nodeId) => ({ id: nodeId, label: nodeLabel(newGraph, nodeId) }))
  const removedNodesList = [...oldNodes].filter((nodeId) => !newNodes.has(nodeId)).map((nodeId) => ({ id: nodeId, label: nodeLabel(oldGraph, nodeId) }))

  const oldEdges = new Set(oldGraph.edgeEntries().map(([source, target, attrs]) => edgeKey(source, target, String(attrs.relation ?? ''), oldGraph.isDirected())))
  const newEdges = new Set(newGraph.edgeEntries().map(([source, target, attrs]) => edgeKey(source, target, String(attrs.relation ?? ''), newGraph.isDirected())))

  const newEdgesList = newGraph
    .edgeEntries()
    .filter(([source, target, attrs]) => !oldEdges.has(edgeKey(source, target, String(attrs.relation ?? ''), newGraph.isDirected())))
    .map(([source, target, attrs]) => ({
      source,
      target,
      relation: String(attrs.relation ?? ''),
      confidence: String(attrs.confidence ?? ''),
    }))
  const removedEdgesList = oldGraph
    .edgeEntries()
    .filter(([source, target, attrs]) => !newEdges.has(edgeKey(source, target, String(attrs.relation ?? ''), oldGraph.isDirected())))
    .map(([source, target, attrs]) => ({
      source,
      target,
      relation: String(attrs.relation ?? ''),
      confidence: String(attrs.confidence ?? ''),
    }))

  const summaryParts: string[] = []
  if (newNodesList.length > 0) {
    summaryParts.push(`${newNodesList.length} new node${newNodesList.length === 1 ? '' : 's'}`)
  }
  if (newEdgesList.length > 0) {
    summaryParts.push(`${newEdgesList.length} new edge${newEdgesList.length === 1 ? '' : 's'}`)
  }
  if (removedNodesList.length > 0) {
    summaryParts.push(`${removedNodesList.length} node${removedNodesList.length === 1 ? '' : 's'} removed`)
  }
  if (removedEdgesList.length > 0) {
    summaryParts.push(`${removedEdgesList.length} edge${removedEdgesList.length === 1 ? '' : 's'} removed`)
  }

  return {
    new_nodes: newNodesList,
    removed_nodes: removedNodesList,
    new_edges: newEdgesList,
    removed_edges: removedEdgesList,
    summary: summaryParts.length > 0 ? summaryParts.join(', ') : 'no changes',
  }
}
