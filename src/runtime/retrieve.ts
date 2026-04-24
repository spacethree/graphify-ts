import { existsSync, readFileSync } from 'node:fs'

import { KnowledgeGraph } from '../contracts/graph.js'
import { godNodes, workspaceBridges } from '../pipeline/analyze.js'
import { type Communities } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { communitiesFromGraph } from './serve.js'

const SNIPPET_HALF_WINDOW = 7
const MAX_SNIPPET_LINE_LENGTH = 200

const STOP_WORDS = new Set([
  'how', 'does', 'the', 'is', 'a', 'an', 'in', 'to',
  'of', 'and', 'or', 'what', 'where', 'when', 'why',
  'which', 'this', 'that', 'with', 'for', 'from', 'are',
  'do', 'it', 'be', 'has', 'have', 'was', 'were', 'been',
  'can', 'could', 'would', 'should', 'will', 'may', 'might',
  'not', 'but', 'if', 'then', 'so', 'about', 'up', 'out',
  'on', 'at', 'by', 'into', 'all', 'my', 'its', 'no', 'i',
])

const CHARS_PER_TOKEN = 3

export interface RetrieveOptions {
  question: string
  budget: number
  community?: number
  fileType?: string
  snippetLoader?: (sourceFile: string, lineNumber: number) => string | null
}

export interface RetrieveMatchedNode {
  label: string
  source_file: string
  line_number: number
  node_kind: string
  file_type: string
  snippet: string | null
  match_score: number
  community: number | null
  community_label: string | null
}

export interface RetrieveRelationship {
  from: string
  to: string
  relation: string
}

export interface RetrieveCommunityContext {
  id: number
  label: string
  node_count: number
}

export interface RetrieveResult {
  question: string
  token_count: number
  matched_nodes: RetrieveMatchedNode[]
  relationships: RetrieveRelationship[]
  community_context: RetrieveCommunityContext[]
  graph_signals: {
    god_nodes: string[]
    bridge_nodes: string[]
  }
}

export function tokenizeQuestion(question: string): string[] {
  return question
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-./,:;!?'"()[\]{}]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

export function tokenizeLabel(label: string): string[] {
  return label
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-./,:;!?'"()[\]{}]+/)
    .filter((token) => token.length > 1)
}

export function scoreNode(questionTokens: readonly string[], labelTokens: readonly string[], tokenWeights?: ReadonlyMap<string, number>): number {
  let score = 0
  for (const qt of questionTokens) {
    const weight = tokenWeights?.get(qt) ?? 1
    for (const lt of labelTokens) {
      if (lt.startsWith(qt) || qt.startsWith(lt)) {
        score += weight
      }
    }
  }
  return score
}

function buildTokenWeights(graph: KnowledgeGraph, questionTokens: readonly string[]): Map<string, number> {
  const totalNodes = graph.numberOfNodes()
  if (totalNodes === 0) return new Map()

  const matchCounts = new Map<string, number>()
  for (const qt of questionTokens) {
    matchCounts.set(qt, 0)
  }

  for (const [, attributes] of graph.nodeEntries()) {
    const labelTokens = tokenizeLabel(String(attributes.label ?? ''))
    for (const qt of questionTokens) {
      if (labelTokens.some((lt) => lt.startsWith(qt) || qt.startsWith(lt))) {
        matchCounts.set(qt, (matchCounts.get(qt) ?? 0) + 1)
      }
    }
  }

  const weights = new Map<string, number>()
  for (const [token, count] of matchCounts) {
    weights.set(token, count > 0 ? Math.max(0.1, Math.log(totalNodes / count)) : 1)
  }
  return weights
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / CHARS_PER_TOKEN))
}

function readSnippet(sourceFile: string, lineNumber: number): string | null {
  if (!sourceFile || lineNumber <= 0) {
    return null
  }

  try {
    if (!existsSync(sourceFile)) {
      return null
    }

    const content = readFileSync(sourceFile, 'utf8')
    const lines = content.split(/\r?\n/)
    const zeroIndex = lineNumber - 1
    const start = Math.max(0, zeroIndex - SNIPPET_HALF_WINDOW)
    const end = Math.min(lines.length, zeroIndex + SNIPPET_HALF_WINDOW + 1)

    return lines
      .slice(start, end)
      .map((line) => (line.length > MAX_SNIPPET_LINE_LENGTH ? `${line.slice(0, MAX_SNIPPET_LINE_LENGTH)}...` : line))
      .join('\n')
  } catch {
    return null
  }
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

function storedCommunityLabelsFromGraph(graph: KnowledgeGraph): Record<number, string> {
  const rawLabels = graph.graph.community_labels
  if (!rawLabels || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(rawLabels as Record<string, unknown>)
      .map(([key, value]) => [Number(key), typeof value === 'string' ? value.trim() : ''] as const)
      .filter(([id, label]) => Number.isInteger(id) && id >= 0 && label.length > 0),
  )
}

interface ScoredNode {
  id: string
  label: string
  sourceFile: string
  lineNumber: number
  nodeKind: string
  fileType: string
  community: number | null
  score: number
}

export function retrieveContext(graph: KnowledgeGraph, options: RetrieveOptions): RetrieveResult {
  const { question, budget } = options
  const questionTokens = tokenizeQuestion(question)

  if (questionTokens.length === 0) {
    return {
      question,
      token_count: 0,
      matched_nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    }
  }

  // Pre-compute community label scores so nodes in matching communities get a boost
  const communities = communitiesFromGraph(graph)
  const communityLabels: Record<number, string> = {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabelsFromGraph(graph),
  }
  const communityBoost = new Map<number, number>()
  for (const [idStr, label] of Object.entries(communityLabels)) {
    const id = Number(idStr)
    const communityTokens = tokenizeLabel(label)
    const score = scoreNode(questionTokens, communityTokens)
    if (score > 0) {
      communityBoost.set(id, Math.min(score * 0.1, 0.3))
    }
  }

  // Step 1+2: Score all nodes with TF-IDF-weighted tokens + community boost
  const tokenWeights = buildTokenWeights(graph, questionTokens)
  const scored: ScoredNode[] = []
  for (const [id, attributes] of graph.nodeEntries()) {
    const community = parseCommunityId(attributes.community)
    if (options.community !== undefined && community !== options.community) {
      continue
    }

    const fileType = String(attributes.file_type ?? '').trim().toLowerCase()
    if (options.fileType && fileType !== options.fileType.trim().toLowerCase()) {
      continue
    }

    const label = String(attributes.label ?? '')
    const labelTokens = tokenizeLabel(label)
    const sourceFile = String(attributes.source_file ?? '')
    const sourceTokens = tokenizeLabel(sourceFile)
    const labelScore = scoreNode(questionTokens, labelTokens, tokenWeights)
    const sourceScore = scoreNode(questionTokens, sourceTokens, tokenWeights) * 0.5
    const comBoost = community !== null ? (communityBoost.get(community) ?? 0) : 0
    const totalScore = labelScore + sourceScore + comBoost

    if (totalScore > 0) {
      scored.push({
        id,
        label,
        sourceFile,
        lineNumber: typeof attributes.line_number === 'number' ? attributes.line_number : 0,
        nodeKind: String(attributes.node_kind ?? ''),
        fileType,
        community,
        score: totalScore,
      })
    }
  }

  scored.sort((a, b) => b.score - a.score || graph.degree(b.id) - graph.degree(a.id))

  // Step 3: Multi-hop expansion — take top seeds, expand 2 hops with decaying scores
  const seedCount = Math.min(scored.length, 10)
  const seedIds = new Set(scored.slice(0, seedCount).map((node) => node.id))
  const hopScores = new Map<string, number>()

  // Hop 1: direct neighbors get 0.5x of best seed score
  const bestSeedScore = scored.length > 0 ? scored[0]?.score ?? 0 : 0
  for (const seedId of seedIds) {
    for (const neighborId of graph.neighbors(seedId)) {
      if (!seedIds.has(neighborId)) {
        hopScores.set(neighborId, Math.max(hopScores.get(neighborId) ?? 0, bestSeedScore * 0.5))
      }
    }
  }

  // Hop 2: neighbors-of-neighbors get 0.25x (skip if budget is tight)
  if (budget >= 2000) {
    const hop1Ids = new Set(hopScores.keys())
    for (const hop1Id of hop1Ids) {
      for (const hop2Id of graph.neighbors(hop1Id)) {
        if (!seedIds.has(hop2Id) && !hop1Ids.has(hop2Id)) {
          hopScores.set(hop2Id, Math.max(hopScores.get(hop2Id) ?? 0, bestSeedScore * 0.25))
        }
      }
    }
  }

  // Add expanded nodes not already scored
  for (const [nodeId, hopScore] of hopScores) {
    if (scored.some((s) => s.id === nodeId)) {
      continue
    }

    const attributes = graph.nodeAttributes(nodeId)
    const community = parseCommunityId(attributes.community)
    if (options.community !== undefined && community !== options.community) {
      continue
    }

    const fileType = String(attributes.file_type ?? '').trim().toLowerCase()
    if (options.fileType && fileType !== options.fileType.trim().toLowerCase()) {
      continue
    }

    scored.push({
      id: nodeId,
      label: String(attributes.label ?? ''),
      sourceFile: String(attributes.source_file ?? ''),
      lineNumber: typeof attributes.line_number === 'number' ? attributes.line_number : 0,
      nodeKind: String(attributes.node_kind ?? ''),
      fileType,
      community,
      score: hopScore,
    })
  }

  // Apply structural signal boosts before final sort
  const godNodeList = new Set(godNodes(graph, 20).map((entry) => entry.id))
  const bridgeNodeList = new Set(workspaceBridges(graph, communities, {}, 20).map((entry) => entry.id))
  const topSeed = scored.length > 0 ? scored[0] : undefined
  const seedCommunity = topSeed?.community

  for (const node of scored) {
    if (node.score === 0) continue
    if (bridgeNodeList.has(node.id)) node.score += 0.3
    if (godNodeList.has(node.id)) node.score -= 0.2
    if (seedCommunity !== undefined && node.community === seedCommunity && node.community !== -1) node.score += 0.1
  }

  // Re-sort: seeds first by score, then neighbors by degree
  scored.sort((a, b) => b.score - a.score || graph.degree(b.id) - graph.degree(a.id))

  // Step 4+5: Read snippets and assemble within budget
  const matchedNodes: RetrieveMatchedNode[] = []
  const includedIds = new Set<string>()
  let tokenCount = 0

  for (const node of scored) {
    if (!seedIds.has(node.id) && !hopScores.has(node.id)) {
      continue
    }

    const snippet = options.snippetLoader
      ? options.snippetLoader(node.sourceFile, node.lineNumber)
      : readSnippet(node.sourceFile, node.lineNumber)
    const nodeText = `${node.label} ${node.sourceFile}:${node.lineNumber} ${snippet ?? ''}`
    const nodeTokens = estimateTokens(nodeText)

    if (tokenCount + nodeTokens > budget && matchedNodes.length > 0) {
      break
    }

    matchedNodes.push({
      label: node.label,
      source_file: node.sourceFile,
      line_number: node.lineNumber,
      node_kind: node.nodeKind,
      file_type: node.fileType,
      snippet,
      match_score: node.score,
      community: node.community,
      community_label: node.community !== null ? (communityLabels[node.community] ?? null) : null,
    })

    includedIds.add(node.id)
    tokenCount += nodeTokens
  }

  // Collect relationships between included nodes
  const relationships: RetrieveRelationship[] = []
  for (const [source, target, attributes] of graph.edgeEntries()) {
    if (includedIds.has(source) && includedIds.has(target)) {
      relationships.push({
        from: String(graph.nodeAttributes(source).label ?? source),
        to: String(graph.nodeAttributes(target).label ?? target),
        relation: String(attributes.relation ?? 'related_to'),
      })
    }
  }

  // Community context for included nodes
  const communityIds = new Set<number>()
  for (const node of matchedNodes) {
    if (node.community !== null) {
      communityIds.add(node.community)
    }
  }

  const communityContext: RetrieveCommunityContext[] = [...communityIds]
    .map((id) => ({
      id,
      label: communityLabels[id] ?? `Community ${id}`,
      node_count: (communities[id] ?? []).length,
    }))
    .sort((a, b) => b.node_count - a.node_count)

  // Graph signals: god nodes and bridge nodes among results
  const godNodeLabels = new Set(godNodes(graph, 20).map((node) => node.label))
  const bridgeNodeLabels = new Set(
    workspaceBridges(graph, communities, communityLabels).map((bridge) => bridge.label),
  )

  const includedLabels = new Set(matchedNodes.map((node) => node.label))

  return {
    question,
    token_count: tokenCount,
    matched_nodes: matchedNodes,
    relationships,
    community_context: communityContext,
    graph_signals: {
      god_nodes: [...includedLabels].filter((label) => godNodeLabels.has(label)),
      bridge_nodes: [...includedLabels].filter((label) => bridgeNodeLabels.has(label)),
    },
  }
}
