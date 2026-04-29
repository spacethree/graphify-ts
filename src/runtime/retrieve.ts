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
const tokenWeightCache = new WeakMap<KnowledgeGraph, Map<string, Map<string, number>>>()

export interface RetrieveOptions {
  question: string
  budget: number
  community?: number
  fileType?: string
}

export interface RetrieveMatchedNode {
  node_id?: string
  label: string
  source_file: string
  line_number: number
  node_kind: string
  framework_boost?: number
  file_type: string
  snippet: string | null
  match_score: number
  relevance_band: 'direct' | 'related' | 'peripheral'
  community: number | null
  community_label: string | null
}

export interface RetrieveRelationship {
  from_id?: string
  from: string
  to_id?: string
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

export interface CompactRetrieveMatchedNode extends Omit<RetrieveMatchedNode, 'community_label' | 'file_type' | 'framework_boost'> {
  file_type?: string
}

export interface CompactRetrieveResult extends Omit<RetrieveResult, 'matched_nodes'> {
  matched_nodes: CompactRetrieveMatchedNode[]
  shared_file_type?: string
}

function matchedNodeId(node: Pick<RetrieveMatchedNode, 'node_id'>): string | null {
  return typeof node.node_id === 'string' && node.node_id.length > 0 ? node.node_id : null
}

function stripRetrieveMatchedNodeIdentity<T extends RetrieveMatchedNode | CompactRetrieveMatchedNode>(node: T): Omit<T, 'node_id'> {
  const { node_id: _nodeId, ...rest } = node
  return rest
}

function stripRetrieveRelationshipIdentity<T extends RetrieveRelationship>(relationship: T): Omit<T, 'from_id' | 'to_id'> {
  const { from_id: _fromId, to_id: _toId, ...rest } = relationship
  return rest
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

export function tokenWeightsForQuestion(graph: KnowledgeGraph, questionTokens: readonly string[]): Map<string, number> {
  const cacheKey = questionTokens.join('\u0000')
  let graphCache = tokenWeightCache.get(graph)
  if (!graphCache) {
    graphCache = new Map()
    tokenWeightCache.set(graph, graphCache)
  }

  const cached = graphCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const weights = buildTokenWeights(graph, questionTokens)
  graphCache.set(cacheKey, weights)
  return weights
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / CHARS_PER_TOKEN))
}

function estimateRetrieveEntryTokens(label: string, sourceFile: string, lineNumber: number, snippet: string | null): number {
  return estimateTokens(`${label} ${sourceFile}:${lineNumber} ${snippet ?? ''}`)
}

function tokenCountForMatchedNodes(
  matchedNodes: readonly Pick<RetrieveMatchedNode, 'label' | 'source_file' | 'line_number' | 'snippet'>[],
): number {
  return matchedNodes.reduce(
    (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
    0,
  )
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

interface SeedScoreBreakdown {
  labelExactScore: number
  labelTokenScore: number
  sourcePathScore: number
  communityScore: number
  total: number
}

interface ScoredNode {
  id: string
  label: string
  sourceFile: string
  lineNumber: number
  nodeKind: string
  fileType: string
  community: number | null
  frameworkBoost: number
  exactLabelMatch: boolean
  sourcePathMatch: boolean
  evidenceTier: 0 | 1 | 2
  score: number
  relevanceBand: 'direct' | 'related' | 'peripheral'
}

interface FrameworkQuestionProfile {
  frameworkShaped: boolean
  express: boolean
  redux: boolean
  reactRouter: boolean
  routeIntent: boolean
  middlewareIntent: boolean
  handlerIntent: boolean
  selectorIntent: boolean
  sliceIntent: boolean
  storeIntent: boolean
  renderIntent: boolean
  loaderIntent: boolean
  actionIntent: boolean
}

function normalizeSeedText(value: string): string {
  return tokenizeLabel(value).join('')
}

function evidenceTierForSeedScore(score: SeedScoreBreakdown): 0 | 1 | 2 {
  if (score.labelExactScore > 0 || score.labelTokenScore > 0) {
    return 2
  }
  if (score.sourcePathScore > 0 || score.communityScore > 0) {
    return 1
  }
  return 0
}

function compareScoredNodes(graph: KnowledgeGraph, left: ScoredNode, right: ScoredNode): number {
  return (
    right.evidenceTier - left.evidenceTier ||
    right.frameworkBoost - left.frameworkBoost ||
    right.score - left.score ||
    graph.degree(right.id) - graph.degree(left.id)
  )
}

function scoreSeedCandidate(
  question: string,
  questionTokens: readonly string[],
  label: string,
  sourceFile: string,
  communityLabel: string | null,
  tokenWeights: ReadonlyMap<string, number>,
): SeedScoreBreakdown {
  const labelExactScore = normalizeSeedText(question) !== '' && normalizeSeedText(question) === normalizeSeedText(label) ? 2 : 0
  const labelTokenScore = scoreNode(questionTokens, tokenizeLabel(label), tokenWeights)
  const sourcePathScore = scoreNode(questionTokens, tokenizeLabel(sourceFile), tokenWeights) * 0.25
  const communityScore = communityLabel
    ? Math.min(scoreNode(questionTokens, tokenizeLabel(communityLabel)) * 0.1, 0.2)
    : 0

  return {
    labelExactScore,
    labelTokenScore,
    sourcePathScore,
    communityScore,
    total: labelExactScore + labelTokenScore + sourcePathScore + communityScore,
  }
}

function relationWeight(relation: string): number {
  switch (relation) {
    case 'calls':
    case 'imports_from':
    case 'defines':
    case 'defines_action':
    case 'defines_selector':
      return 1
    case 'contains':
    case 'renders':
      return 1.2
    case 'loads_route':
    case 'submits_route':
    case 'registered_in_store':
    case 'updates_slice':
      return 1
    case 'uses':
    case 'depends_on':
      return 0.7
    default:
      return 0.35
  }
}

function relationBetweenNodes(graph: KnowledgeGraph, source: string, target: string): string {
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

function isPrimaryExpansionRelation(relation: string): boolean {
  return (
    relation === 'calls' ||
    relation === 'imports_from' ||
    relation === 'defines' ||
    relation === 'defines_action' ||
    relation === 'defines_selector' ||
    relation === 'contains' ||
    relation === 'renders' ||
    relation === 'loads_route' ||
    relation === 'submits_route' ||
    relation === 'registered_in_store' ||
    relation === 'updates_slice'
  )
}

function includesAnyToken(tokens: readonly string[], candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tokens.includes(candidate))
}

function buildFrameworkQuestionProfile(question: string, questionTokens: readonly string[]): FrameworkQuestionProfile {
  const uppercaseQuestion = question.toUpperCase()
  const hasHttpVerb = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|USE|ALL)\b/.test(uppercaseQuestion)
  const hasRoutePath = /\/[A-Za-z0-9:_-]*/.test(question)
  const routeIntent = hasHttpVerb || hasRoutePath || includesAnyToken(questionTokens, ['route', 'routes', 'router', 'endpoint', 'endpoints'])
  const explicitExpress = includesAnyToken(questionTokens, ['express'])
  const explicitRedux = includesAnyToken(questionTokens, ['redux', 'toolkit'])
  const mentionsReact = includesAnyToken(questionTokens, ['react'])
  const explicitReactRouter = /\breact(?:\s|-)?router\b/i.test(question)
  const middlewareIntent = includesAnyToken(questionTokens, ['middleware', 'guard'])
  const handlerIntent = includesAnyToken(questionTokens, ['handler', 'handlers', 'controller', 'controllers'])
  const selectorIntent = includesAnyToken(questionTokens, ['selector', 'selectors'])
  const sliceIntent = includesAnyToken(questionTokens, ['slice', 'slices', 'state'])
  const storeIntent = includesAnyToken(questionTokens, ['store', 'stores', 'reducer', 'reducers'])
  const renderIntent = includesAnyToken(questionTokens, ['render', 'renders', 'page', 'pages', 'component', 'components'])
  const loaderIntent = includesAnyToken(questionTokens, ['loader', 'loaders', 'load'])
  const actionIntent = includesAnyToken(questionTokens, ['action', 'actions', 'submit', 'submits', 'dispatch'])
  const express = explicitExpress || hasHttpVerb || middlewareIntent || handlerIntent
  const redux = explicitRedux || selectorIntent || sliceIntent || storeIntent
  const reactRouter = routeIntent && !express && (explicitReactRouter || mentionsReact || renderIntent || loaderIntent || actionIntent)

  return {
    frameworkShaped: express || redux || reactRouter,
    express,
    redux,
    reactRouter,
    routeIntent,
    middlewareIntent,
    handlerIntent,
    selectorIntent,
    sliceIntent,
    storeIntent,
    renderIntent,
    loaderIntent,
    actionIntent,
  }
}

function frameworkBoostForNode(
  profile: FrameworkQuestionProfile,
  nodeKind: string,
  frameworkRole: string,
): number {
  if (!profile.frameworkShaped) {
    return 0
  }

  let boost = 0

  if (profile.express) {
    if (frameworkRole === 'express_route') {
      boost += profile.routeIntent || profile.middlewareIntent || profile.handlerIntent ? 4 : 2.5
    }
    if (frameworkRole === 'express_middleware') {
      boost += profile.middlewareIntent ? 2.5 : 1
    }
    if (frameworkRole === 'express_handler') {
      boost += profile.handlerIntent ? 2.5 : 1.25
    }
    if (frameworkRole === 'express_router' || frameworkRole === 'express_app') {
      boost += profile.routeIntent ? 1.5 : 0.5
    }
  }

  if (profile.redux) {
    if (nodeKind === 'slice' || frameworkRole === 'redux_slice') {
      boost += profile.sliceIntent || profile.selectorIntent ? 3.5 : 2.5
    }
    if (frameworkRole === 'redux_selector') {
      boost += profile.selectorIntent ? 3.5 : 2
    }
    if (nodeKind === 'store' || frameworkRole === 'redux_store') {
      boost += profile.storeIntent || profile.sliceIntent ? 2.25 : 1.5
    }
    if (frameworkRole === 'redux_action' || frameworkRole === 'redux_thunk') {
      boost += profile.actionIntent ? 2 : 0.75
    }
  }

  if (profile.reactRouter) {
    if (frameworkRole === 'react_router_route' || frameworkRole === 'react_router_layout') {
      boost += profile.routeIntent || profile.renderIntent || profile.loaderIntent || profile.actionIntent ? 3.5 : 2
    }
    if (frameworkRole === 'react_router_component') {
      boost += profile.renderIntent ? 2.5 : 1
    }
    if (frameworkRole === 'react_router_loader') {
      boost += profile.loaderIntent ? 2.5 : 1
    }
    if (frameworkRole === 'react_router_action') {
      boost += profile.actionIntent ? 2.5 : 1
    }
    if (frameworkRole === 'react_router') {
      boost += profile.routeIntent ? 1.5 : 0.5
    }
  }

  if (profile.frameworkShaped && boost === 0 && ['function', 'class', 'variable'].includes(nodeKind)) {
    boost -= 0.5
  }

  return boost
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

  // Pre-compute community labels so seed scoring can treat them as secondary evidence.
  const communities = communitiesFromGraph(graph)
  const frameworkProfile = buildFrameworkQuestionProfile(question, questionTokens)
  const communityLabels: Record<number, string> = {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabelsFromGraph(graph),
  }

  // Step 1+2: Score all nodes with explicit seed evidence weights.
  const tokenWeights = tokenWeightsForQuestion(graph, questionTokens)
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
    const sourceFile = String(attributes.source_file ?? '')
    const nodeKind = String(attributes.node_kind ?? '')
    const frameworkRole = String(attributes.framework_role ?? '')
    const score = scoreSeedCandidate(
      question,
      questionTokens,
      label,
      sourceFile,
      community !== null ? (communityLabels[community] ?? null) : null,
      tokenWeights,
    )

    if (score.total > 0) {
      scored.push({
        id,
        label,
        sourceFile,
        lineNumber: typeof attributes.line_number === 'number' ? attributes.line_number : 0,
        nodeKind,
        fileType,
        community,
      frameworkBoost: frameworkBoostForNode(frameworkProfile, nodeKind, frameworkRole),
      exactLabelMatch: score.labelExactScore > 0,
      sourcePathMatch: score.sourcePathScore > 0,
      evidenceTier: evidenceTierForSeedScore(score),
      score: score.total + frameworkBoostForNode(frameworkProfile, nodeKind, frameworkRole),
      relevanceBand: score.labelExactScore > 0 || score.labelTokenScore > 0 ? 'direct' : 'related',
    })
    }
  }

  scored.sort((a, b) => compareScoredNodes(graph, a, b))

  // Step 3: Multi-hop expansion — take top seeds, expand 2 hops with decaying scores
  const seedCount = Math.min(scored.length, 10)
  const hasExactSeedMatch = scored.some((node) => node.exactLabelMatch)
  const seedIds = new Set(scored.slice(0, seedCount).map((node) => node.id))
  const directSeeds = scored
    .filter((node) => node.relevanceBand === 'direct')
    .slice(0, 4)
  const expansionSeedIds = new Set((directSeeds.length > 0 ? directSeeds : scored.slice(0, seedCount)).map((node) => node.id))
  const hopScores = new Map<string, number>()
  const hopDistances = new Map<string, 1 | 2>()
  const hopEvidenceTiers = new Map<string, 0 | 1>()
  const hop1Ids = new Set<string>()

  // Hop 1: direct neighbors inherit a relation-weighted slice of each strong seed's score.
  for (const seed of directSeeds.length > 0 ? directSeeds : scored.slice(0, seedCount)) {
    for (const neighborId of graph.incidentNeighbors(seed.id)) {
      if (!expansionSeedIds.has(neighborId)) {
        const relation = relationBetweenNodes(graph, seed.id, neighborId)
        const hopScore = seed.score * 0.5 * relationWeight(relation)
        const hopEvidenceTier = isPrimaryExpansionRelation(relation) ? 1 : 0
        const existingHopScore = hopScores.get(neighborId) ?? 0
        const existingHopEvidenceTier = hopEvidenceTiers.get(neighborId) ?? 0
        if (hopScore > existingHopScore || (hopScore === existingHopScore && hopEvidenceTier > existingHopEvidenceTier)) {
          hopScores.set(neighborId, hopScore)
          hopDistances.set(neighborId, 1)
          hopEvidenceTiers.set(neighborId, hopEvidenceTier)
        }
        hop1Ids.add(neighborId)
      }
    }
  }

  for (const node of scored) {
    const hopScore = hopScores.get(node.id)
    if (!hopScore) {
      continue
    }

    node.score += hopScore
    const hopEvidenceTier = hopEvidenceTiers.get(node.id) ?? 0
    if (node.sourcePathMatch && hopEvidenceTier > 0) {
      node.evidenceTier = 2
      node.relevanceBand = 'direct'
      node.score += 0.5
      continue
    }

    if (hopEvidenceTier > node.evidenceTier) {
      node.evidenceTier = hopEvidenceTier
      if (node.relevanceBand === 'peripheral') {
        node.relevanceBand = 'related'
      }
    }
  }

  // Hop 2: neighbors-of-neighbors decay again, but keep this pool small and relation-aware.
  if (budget >= 2000 && !hasExactSeedMatch) {
    const hop2Scores = new Map<string, number>()
    for (const hop1Id of hop1Ids) {
      const hop1Score = hopScores.get(hop1Id) ?? 0
      if (hop1Score <= 0) continue
      for (const hop2Id of graph.incidentNeighbors(hop1Id)) {
        if (!seedIds.has(hop2Id) && !hop1Ids.has(hop2Id)) {
          const relation = relationBetweenNodes(graph, hop1Id, hop2Id)
          const hop2Score = hop1Score * 0.5 * relationWeight(relation)
          if (hop2Score > (hop2Scores.get(hop2Id) ?? 0)) {
            hop2Scores.set(hop2Id, hop2Score)
          }
        }
      }
    }

    const maxSecondHopAdds = budget >= 5000 ? 6 : 3
    for (const [hop2Id, hop2Score] of [...hop2Scores.entries()]
      .sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || graph.degree(rightId) - graph.degree(leftId))
      .slice(0, maxSecondHopAdds)) {
      hopScores.set(hop2Id, Math.max(hopScores.get(hop2Id) ?? 0, hop2Score))
      hopDistances.set(hop2Id, 2)
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
      frameworkBoost: 0,
      exactLabelMatch: false,
      sourcePathMatch: false,
      evidenceTier: hopDistances.get(nodeId) === 1 ? (hopEvidenceTiers.get(nodeId) ?? 0) : 0,
      score: hopScore,
      relevanceBand: hopDistances.get(nodeId) === 1 ? 'related' : 'peripheral',
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
  scored.sort((a, b) => compareScoredNodes(graph, a, b))

  // Step 4+5: Read snippets and assemble within budget
  const matchedNodes: RetrieveMatchedNode[] = []
  const includedIds = new Set<string>()
  let tokenCount = 0
  const primaryCandidates = scored.filter((node) => (seedIds.has(node.id) || hopScores.has(node.id)) && node.relevanceBand !== 'peripheral')
  const peripheralCandidates = scored.filter((node) => (seedIds.has(node.id) || hopScores.has(node.id)) && node.relevanceBand === 'peripheral')
  const prioritizedFrameworkCandidates = frameworkProfile.frameworkShaped
    ? primaryCandidates.filter((node) => node.frameworkBoost > 0)
    : []
  const secondaryCandidates = frameworkProfile.frameworkShaped
    ? primaryCandidates.filter((node) => node.frameworkBoost <= 0)
    : primaryCandidates
  const compactFrameworkLimit = frameworkProfile.frameworkShaped && prioritizedFrameworkCandidates.length > 0 ? 5 : Number.POSITIVE_INFINITY
  const reservedSupportingSlots =
    Number.isFinite(compactFrameworkLimit) && secondaryCandidates.length > 0
      ? Math.min(2, secondaryCandidates.length, compactFrameworkLimit - 1)
      : 0
  const prioritizedFrameworkHeadCount = Number.isFinite(compactFrameworkLimit)
    ? Math.max(1, compactFrameworkLimit - reservedSupportingSlots)
    : prioritizedFrameworkCandidates.length
  const inclusionOrder = frameworkProfile.frameworkShaped
    ? [
        ...prioritizedFrameworkCandidates.slice(0, prioritizedFrameworkHeadCount),
        ...secondaryCandidates.slice(0, reservedSupportingSlots),
        ...prioritizedFrameworkCandidates.slice(prioritizedFrameworkHeadCount),
        ...secondaryCandidates.slice(reservedSupportingSlots),
        ...peripheralCandidates,
      ]
    : [...secondaryCandidates, ...peripheralCandidates]

  for (const node of inclusionOrder) {
    const snippet = readSnippet(node.sourceFile, node.lineNumber)
    const nodeTokens = estimateRetrieveEntryTokens(node.label, node.sourceFile, node.lineNumber, snippet)

    if (tokenCount + nodeTokens > budget && matchedNodes.length > 0) {
      break
    }

    matchedNodes.push({
      node_id: node.id,
      label: node.label,
      source_file: node.sourceFile,
      line_number: node.lineNumber,
      node_kind: node.nodeKind,
      framework_boost: node.frameworkBoost,
      file_type: node.fileType,
      snippet,
      match_score: node.score,
      relevance_band: node.relevanceBand,
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
          from_id: source,
          from: String(graph.nodeAttributes(source).label ?? source),
          to_id: target,
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

export function compactRetrieveResult(result: RetrieveResult): CompactRetrieveResult {
  const frameworkProfile = buildFrameworkQuestionProfile(result.question, tokenizeQuestion(result.question))
  const compactFrameworkLimit =
    frameworkProfile.frameworkShaped && result.matched_nodes.some((node) => (node.framework_boost ?? 0) > 0) ? 5 : Number.POSITIVE_INFINITY
  const compactMatchedNodes = Number.isFinite(compactFrameworkLimit)
    ? result.matched_nodes.slice(0, compactFrameworkLimit)
    : result.matched_nodes
  const includedNodeIds = new Set(compactMatchedNodes.map(matchedNodeId).filter((nodeId): nodeId is string => nodeId !== null))
  const includedLabels = new Set(compactMatchedNodes.map((node) => node.label))
  const includedCommunities = new Set(compactMatchedNodes.flatMap((node) => (node.community === null ? [] : [node.community])))
  const sharedFileType =
    compactMatchedNodes.length > 0 && compactMatchedNodes.every((node) => node.file_type === compactMatchedNodes[0]?.file_type)
      ? compactMatchedNodes[0]?.file_type
      : undefined

  return {
    question: result.question,
    token_count: tokenCountForMatchedNodes(compactMatchedNodes),
    matched_nodes: compactMatchedNodes.map(({ community_label: _communityLabel, file_type: fileType, framework_boost: _frameworkBoost, ...node }) => ({
      ...node,
      ...(sharedFileType ? {} : { file_type: fileType }),
    })),
    relationships: result.relationships.filter((edge) => {
      if (includedNodeIds.size > 0 && edge.from_id && edge.to_id) {
        return includedNodeIds.has(edge.from_id) && includedNodeIds.has(edge.to_id)
      }
      return includedLabels.has(edge.from) && includedLabels.has(edge.to)
    }),
    community_context: result.community_context.filter((community) => includedCommunities.has(community.id)),
    graph_signals: {
      god_nodes: result.graph_signals.god_nodes.filter((label) => includedLabels.has(label)),
      bridge_nodes: result.graph_signals.bridge_nodes.filter((label) => includedLabels.has(label)),
    },
    ...(sharedFileType ? { shared_file_type: sharedFileType } : {}),
  }
}

export function compactRetrieveResultForStdio(result: RetrieveResult): RetrieveResult {
  const compactResult = compactRetrieveResult(result)
  const originalNodesById = new Map(
    result.matched_nodes
      .map((node) => [matchedNodeId(node), node] as const)
      .filter(([nodeId]) => nodeId !== null) as Array<[string, RetrieveMatchedNode]>,
  )

  const matchedNodes: RetrieveResult['matched_nodes'] = compactResult.matched_nodes.map((node) => {
    const original = matchedNodeId(node) !== null ? originalNodesById.get(matchedNodeId(node)!) : undefined
    if (original) {
      return stripRetrieveMatchedNodeIdentity(original)
    }

    return {
      label: node.label,
      source_file: node.source_file,
      line_number: node.line_number,
      node_kind: node.node_kind,
      framework_boost: 0,
      file_type: node.file_type ?? compactResult.shared_file_type ?? '',
      snippet: node.snippet,
      match_score: node.match_score,
      relevance_band: node.relevance_band,
      community: node.community,
      community_label: null,
    }
  })

  return {
    question: result.question,
    token_count: compactResult.token_count,
    matched_nodes: matchedNodes,
    relationships: compactResult.relationships.map(stripRetrieveRelationshipIdentity),
    community_context: compactResult.community_context,
    graph_signals: compactResult.graph_signals,
  }
}
