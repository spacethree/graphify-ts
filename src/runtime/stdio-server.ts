import { createInterface } from 'node:readline'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { godNodes, suggestQuestions } from '../pipeline/analyze.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { diffGraphs } from './diff.js'
import { freshnessAnnotations, resourceFreshnessMetadata } from './freshness.js'
import { MCP_PROMPTS, MCP_TOOLS, type McpPromptDefinition } from './stdio/definitions.js'
import { retrieveContext } from './retrieve.js'
import {
  communitiesFromGraph,
  getCommunity,
  getNeighbors,
  getNode,
  godNodesSummary,
  graphStats,
  loadGraph,
  queryGraph,
  semanticAnomaliesSummary,
  shortestPath,
} from './serve.js'
import { validateGraphPath } from '../shared/security.js'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_SERVER_ERROR = -32000
const MCP_PROTOCOL_VERSION = '2025-11-25'
const MCP_SERVER_NAME = 'graphify-ts'
const MCP_SERVER_TITLE = 'Graphify TS'
const MCP_SERVER_VERSION = '0.1.0'
const MAX_STDIO_LINE_BYTES = 1_000_000
const MAX_STDIO_TEXT_LENGTH = 512
const MAX_STDIO_TOKEN_BUDGET = 100_000
const MAX_STDIO_DEPTH = 20
const MAX_STDIO_HOPS = 20
const MAX_STDIO_RESOURCE_BYTES = 5_000_000
const MAX_STDIO_DIFF_ITEMS = 100
const MAX_RESOURCE_SUBSCRIPTIONS = 16
const graphCache = new Map<string, { mtimeMs: number; graph: ReturnType<typeof loadGraph> }>()
const promptContextCache = new Map<string, { mtimeMs: number; context: PromptContext }>()
const MAX_COMPLETION_VALUES = 25
const MAX_LOG_NOTIFICATION_CHARS = 10_000

type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'

interface StdioSessionState {
  logLevel: McpLogLevel
  subscribedResourceUris?: Set<string>
  resourceVersions?: Map<string, string>
  resourceListSignature?: string | null
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

const DEFAULT_STDIO_LOG_LEVEL: McpLogLevel = 'info'
const LOG_LEVEL_PRIORITY: Record<McpLogLevel, number> = {
  debug: 10,
  info: 20,
  notice: 30,
  warning: 40,
  error: 50,
  critical: 60,
  alert: 70,
  emergency: 80,
}

function createSessionState(): StdioSessionState {
  return {
    logLevel: DEFAULT_STDIO_LOG_LEVEL,
    subscribedResourceUris: new Set<string>(),
    resourceVersions: new Map<string, string>(),
    resourceListSignature: null,
  }
}

interface StdioRequest {
  id?: string | number | null
  method?: unknown
  params?: unknown
}

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

interface McpResourceDefinition {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  filePath: string
  annotations?: Record<string, number | string>
}

interface PromptContext {
  graph: ReturnType<typeof loadGraph>
  communities: ReturnType<typeof communitiesFromGraph>
  communityLabels: Record<number, string>
  nodeCommunity: Record<string, number>
  topCommunities: Array<{ communityId: number; label: string; size: number }>
  topGodNodes: Array<{ label: string; edges: number }>
  suggestedQuestions: string[]
}

export interface ServeGraphStdioOptions {
  graphPath: string
  input?: Readable
  output?: Writable
  errorOutput?: Writable
  logger?: {
    log(message?: string): void
    error(message?: string): void
  }
}

function ok(id: string | number | null, result: unknown): StdioResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: string | number | null, code: number, message: string): StdioResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
}

function notification(method: string, params?: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
  }
}

function ensureSubscribedResourceUris(state: StdioSessionState): Set<string> {
  if (!state.subscribedResourceUris) {
    state.subscribedResourceUris = new Set<string>()
  }

  return state.subscribedResourceUris
}

function ensureResourceVersions(state: StdioSessionState): Map<string, string> {
  if (!state.resourceVersions) {
    state.resourceVersions = new Map<string, string>()
  }

  return state.resourceVersions
}

function requestId(request: StdioRequest): string | number | null {
  return typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null
}

function stringParam(params: unknown, key: string): string | null {
  if (!params || typeof params !== 'object' || !(key in params)) {
    return null
  }
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length <= MAX_STDIO_TEXT_LENGTH ? value : null
}

function stringParamAlias(params: unknown, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringParam(params, key)
    if (value !== null) {
      return value
    }
  }

  return null
}

function numberParam(params: unknown, key: string, options: { min?: number; max?: number } = {}): number | null {
  if (!params || typeof params !== 'object' || !(key in params)) {
    return null
  }
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (options.min !== undefined && value < options.min) {
    return null
  }
  if (options.max !== undefined && value > options.max) {
    return null
  }
  return value
}

function numberParamAlias(params: unknown, keys: readonly string[], options: { min?: number; max?: number } = {}): number | null {
  for (const key of keys) {
    const value = numberParam(params, key, options)
    if (value !== null) {
      return value
    }
  }

  return null
}

function integerLikeParamAlias(params: unknown, keys: readonly string[], options: { min?: number; max?: number } = {}): number | null {
  for (const key of keys) {
    if (!params || typeof params !== 'object' || !(key in params)) {
      continue
    }

    const rawValue = (params as Record<string, unknown>)[key]
    const numericValue = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim()) ? Number(rawValue.trim()) : null

    if (numericValue === null || !Number.isFinite(numericValue)) {
      continue
    }
    if (options.min !== undefined && numericValue < options.min) {
      continue
    }
    if (options.max !== undefined && numericValue > options.max) {
      continue
    }
    return numericValue
  }

  return null
}

function recordParam(params: unknown, key: string): Record<string, unknown> | null {
  if (!params || typeof params !== 'object' || !(key in params)) {
    return null
  }
  const value = (params as Record<string, unknown>)[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function hasParam(params: unknown, key: string): boolean {
  return Boolean(params && typeof params === 'object' && key in params)
}

function hasParamAlias(params: unknown, keys: readonly string[]): boolean {
  return keys.some((key) => hasParam(params, key))
}

function parseRankBy(value: string | null): 'relevance' | 'degree' | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized) {
    return null
  }
  if (normalized === 'relevance' || normalized === 'degree') {
    return normalized
  }
  return null
}

function queryOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; queryOptions?: Record<string, unknown> } {
  const mode = stringParam(params, 'mode') === 'dfs' ? 'dfs' : 'bfs'
  const depth = numberParam(params, 'depth', { min: 0, max: MAX_STDIO_DEPTH })
  const tokenBudget = numberParamAlias(params, ['token_budget', 'tokenBudget'], { min: 1, max: MAX_STDIO_TOKEN_BUDGET })
  const rawRankBy = stringParamAlias(params, ['rank_by', 'rankBy'])
  const rankBy = parseRankBy(rawRankBy)
  if (hasParamAlias(params, ['rank_by', 'rankBy']) && rankBy === null) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, 'rank_by must be one of relevance, degree'),
    }
  }

  const community = numberParamAlias(params, ['community_id', 'communityId'], { min: 0 })
  if (hasParamAlias(params, ['community_id', 'communityId']) && community === null) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, 'community_id must be a non-negative number'),
    }
  }

  const fileType = stringParamAlias(params, ['file_type', 'fileType'])
  const filters = {
    ...(community !== null ? { community } : {}),
    ...(fileType ? { fileType } : {}),
  }

  return {
    queryOptions: {
      mode,
      ...(depth !== null ? { depth } : {}),
      ...(tokenBudget !== null ? { tokenBudget } : {}),
      ...(rankBy ? { rankBy } : {}),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    },
  }
}

function graphDiffOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; baselineGraphPath?: string; limit?: number } {
  const baselineGraphPath = stringParamAlias(params, ['baseline_graph_path', 'baselineGraphPath'])
  if (!baselineGraphPath) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, `baseline_graph_path requires a string parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`),
    }
  }

  const limit = numberParamAlias(params, ['limit'], { min: 1, max: MAX_STDIO_DIFF_ITEMS })
  if (hasParam(params, 'limit') && limit === null) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, `limit must be a number between 1 and ${MAX_STDIO_DIFF_ITEMS}`),
    }
  }

  return { baselineGraphPath, ...(limit !== null ? { limit } : {}) }
}

function shouldEmitLog(level: McpLogLevel, currentLevel: McpLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel]
}

function parseLogLevel(value: string | null): McpLogLevel | null {
  switch (value) {
    case 'debug':
    case 'info':
    case 'notice':
    case 'warning':
    case 'error':
    case 'critical':
    case 'alert':
    case 'emergency':
      return value
    default:
      return null
  }
}

function emitLogNotification(output: Writable, state: StdioSessionState, level: McpLogLevel, data: unknown, logger = MCP_SERVER_NAME): void {
  if (!shouldEmitLog(level, state.logLevel)) {
    return
  }

  let payloadData: unknown
  try {
    const serialized = JSON.stringify(data)
    payloadData = serialized.length <= MAX_LOG_NOTIFICATION_CHARS ? data : `${serialized.slice(0, MAX_LOG_NOTIFICATION_CHARS)}... [truncated]`
  } catch {
    payloadData = String(data).slice(0, MAX_LOG_NOTIFICATION_CHARS)
  }

  try {
    output.write(
      `${JSON.stringify(
        notification('notifications/message', {
          level,
          logger,
          data: payloadData,
        }),
      )}\n`,
    )
  } catch {
    // Ignore broken pipe / closed stream cases; the client has already gone away.
  }
}

function textToolResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  }
}

function loadGraphCached(graphPath: string): ReturnType<typeof loadGraph> {
  const safeGraphPath = validateGraphPath(graphPath)
  const currentMtime = statSync(safeGraphPath).mtimeMs
  const cached = graphCache.get(safeGraphPath)
  if (cached && cached.mtimeMs === currentMtime) {
    return cached.graph
  }

  const graph = loadGraph(safeGraphPath)
  graphCache.set(safeGraphPath, { mtimeMs: currentMtime, graph })
  return graph
}

function sanitizePromptValue(value: string | null, fallback: string): string {
  if (!value) {
    return fallback
  }

  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized.length > 0 ? sanitized : fallback
}

function resourceUri(name: string): string {
  return `graphify://artifact/${name}`
}

function resourcesForGraph(graphPath: string): McpResourceDefinition[] {
  const safeGraphPath = validateGraphPath(graphPath)
  const outputDir = dirname(safeGraphPath)
  const candidates: McpResourceDefinition[] = [
    {
      uri: resourceUri('graph.json'),
      name: 'graph.json',
      title: 'Graph JSON',
      description: 'GraphRAG-ready graph export with nodes, links, and hyperedges.',
      mimeType: 'application/json',
      filePath: safeGraphPath,
    },
    {
      uri: resourceUri('GRAPH_REPORT.md'),
      name: 'GRAPH_REPORT.md',
      title: 'Graph Report',
      description: 'Markdown report summarizing the generated graph.',
      mimeType: 'text/markdown',
      filePath: join(outputDir, 'GRAPH_REPORT.md'),
    },
    {
      uri: resourceUri('graph.html'),
      name: 'graph.html',
      title: 'Interactive Graph Explorer',
      description: 'Interactive HTML graph explorer generated by graphify-ts.',
      mimeType: 'text/html',
      filePath: join(outputDir, 'graph.html'),
    },
  ]

  return candidates
    .filter((resource) => existsSync(resource.filePath))
    .map((resource) => ({
      ...resource,
      annotations: freshnessAnnotations(resourceFreshnessMetadata(safeGraphPath, resource.filePath)),
    }))
}

function resourceListSignature(resources: readonly McpResourceDefinition[]): string {
  return resources
    .map((resource) => resource.uri)
    .sort()
    .join('|')
}

function resourceVersion(resource: McpResourceDefinition): string {
  const graphVersion = String(resource.annotations?.graph_version ?? '')
  const modifiedAt = String(resource.annotations?.resource_modified_ms ?? '')
  return `${graphVersion}:${modifiedAt}`
}

function emitJsonRpcNotification(output: Writable, message: JsonRpcNotification): void {
  try {
    output.write(`${JSON.stringify(message)}\n`)
  } catch {
    // Ignore closed stream cases.
  }
}

function emitResourceNotifications(output: Writable, graphPath: string, state: StdioSessionState): void {
  const resources = resourcesForGraph(graphPath)
  const nextListSignature = resourceListSignature(resources)
  if (state.resourceListSignature !== null && state.resourceListSignature !== nextListSignature) {
    emitJsonRpcNotification(output, notification('notifications/resources/list_changed'))
  }
  state.resourceListSignature = nextListSignature

  const subscribedUris = ensureSubscribedResourceUris(state)
  if (subscribedUris.size === 0) {
    return
  }

  const versions = ensureResourceVersions(state)
  const resourcesByUri = new Map(resources.map((resource) => [resource.uri, resource]))
  for (const uri of [...subscribedUris].sort()) {
    const resource = resourcesByUri.get(uri)
    if (!resource) {
      versions.delete(uri)
      continue
    }

    const nextVersion = resourceVersion(resource)
    const previousVersion = versions.get(uri)
    if (previousVersion !== undefined && previousVersion !== nextVersion) {
      emitJsonRpcNotification(output, notification('notifications/resources/updated', { uri }))
    }

    versions.set(uri, nextVersion)
  }
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function readStoredCommunityLabels(graphPath: string): Record<number, string> {
  const safeGraphPath = validateGraphPath(graphPath)

  try {
    const parsed = JSON.parse(readFileSync(safeGraphPath, 'utf8')) as { community_labels?: unknown }
    const rawLabels = parsed.community_labels
    if (!rawLabels || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
      return {}
    }

    const labels = new Map<number, string>()
    for (const [communityIdRaw, labelRaw] of Object.entries(rawLabels as Record<string, unknown>)) {
      const communityId = Number(communityIdRaw)
      const label = typeof labelRaw === 'string' ? labelRaw.trim() : ''
      if (Number.isInteger(communityId) && communityId >= 0 && label.length > 0) {
        labels.set(communityId, label)
      }
    }

    return Object.fromEntries(labels.entries())
  } catch {
    return {}
  }
}

function nodeCommunityMap(communities: ReturnType<typeof communitiesFromGraph>): Record<string, number> {
  const mapping: Record<string, number> = {}

  for (const [communityIdRaw, nodeIds] of Object.entries(communities)) {
    const communityId = Number(communityIdRaw)
    for (const nodeId of nodeIds) {
      mapping[nodeId] = communityId
    }
  }

  return mapping
}

function loadPromptContext(graphPath: string): PromptContext {
  const safeGraphPath = validateGraphPath(graphPath)
  const currentMtime = statSync(safeGraphPath).mtimeMs
  const cached = promptContextCache.get(safeGraphPath)
  if (cached && cached.mtimeMs === currentMtime) {
    return cached.context
  }

  const graph = loadGraphCached(safeGraphPath)
  const communities = communitiesFromGraph(graph)
  const storedLabels = readStoredCommunityLabels(safeGraphPath)
  const communityLabels = {
    ...buildCommunityLabels(graph, communities),
    ...storedLabels,
  }
  const topCommunities = Object.entries(communities)
    .map(([communityIdRaw, nodeIds]) => {
      const communityId = Number(communityIdRaw)
      return {
        communityId,
        label: communityLabels[communityId] ?? `Community ${communityId}`,
        size: nodeIds.length,
      }
    })
    .sort((left, right) => right.size - left.size || left.label.localeCompare(right.label))
    .slice(0, 3)

  const context: PromptContext = {
    graph,
    communities,
    communityLabels,
    nodeCommunity: nodeCommunityMap(communities),
    topCommunities,
    topGodNodes: godNodes(graph, 5).map((node) => ({ label: node.label, edges: node.edges })),
    suggestedQuestions: suggestQuestions(graph, communities, communityLabels, 3)
      .map((item) => item.question)
      .filter((question): question is string => Boolean(question)),
  }

  promptContextCache.set(safeGraphPath, { mtimeMs: currentMtime, context })
  return context
}

function formatTopCommunitySummary(context: PromptContext): string {
  if (context.topCommunities.length === 0) {
    return 'No named communities detected.'
  }

  return context.topCommunities.map((community) => `${community.label} (#${community.communityId}, ${formatCount(community.size, 'node')})`).join('; ')
}

function formatGodNodeSummary(context: PromptContext): string {
  if (context.topGodNodes.length === 0) {
    return 'No non-file god nodes detected.'
  }

  return context.topGodNodes.map((node) => `${node.label} (${node.edges} edges)`).join(', ')
}

function formatSuggestedQuestionLines(context: PromptContext): string {
  if (context.suggestedQuestions.length === 0) {
    return '- No high-signal graph questions detected.'
  }

  return context.suggestedQuestions.map((question) => `- ${question}`).join('\n')
}

function graphSnapshotLines(context: PromptContext): string[] {
  return [
    `Graph snapshot: ${formatCount(context.graph.numberOfNodes(), 'node')}, ${formatCount(context.graph.numberOfEdges(), 'edge')}, ${formatCount(Object.keys(context.communities).length, 'community')}.`,
    `Top communities: ${formatTopCommunitySummary(context)}`,
    `God nodes: ${formatGodNodeSummary(context)}`,
  ]
}

function promptDefinitionsForGraph(graphPath: string): McpPromptDefinition[] {
  const context = loadPromptContext(graphPath)
  const exampleLabels = context.topGodNodes.slice(0, 3).map((node) => node.label)
  const exampleCommunities = context.topCommunities.slice(0, 2).map((community) => `${community.label} (#${community.communityId})`)

  return MCP_PROMPTS.map((prompt) => {
    switch (prompt.name) {
      case 'graph_query_prompt':
        return {
          ...prompt,
          description: `Ask a question using graph evidence only. Current graph: ${formatCount(context.graph.numberOfNodes(), 'node')} across ${formatCount(Object.keys(context.communities).length, 'community')}.`,
        }
      case 'graph_path_prompt':
        return {
          ...prompt,
          description: exampleLabels.length > 0 ? `Explain the shortest path between two graph concepts such as ${exampleLabels.join(', ')}.` : prompt.description,
        }
      case 'graph_explain_prompt':
        return {
          ...prompt,
          description: exampleLabels.length > 0 ? `Explain one node and its neighborhood. Try labels like ${exampleLabels.join(', ')}.` : prompt.description,
        }
      case 'graph_community_summary_prompt':
        return {
          ...prompt,
          description: exampleCommunities.length > 0 ? `Summarize a detected community such as ${exampleCommunities.join(' or ')}.` : prompt.description,
        }
      default:
        return prompt
    }
  })
}

function communityMemberLabels(context: PromptContext, communityId: number): string[] {
  return [...(context.communities[communityId] ?? [])]
    .sort(
      (left, right) =>
        context.graph.degree(right) - context.graph.degree(left) ||
        String(context.graph.nodeAttributes(left).label ?? left).localeCompare(String(context.graph.nodeAttributes(right).label ?? right)),
    )
    .map((nodeId) => String(context.graph.nodeAttributes(nodeId).label ?? nodeId))
}

function communityBridgeLines(context: PromptContext, communityId: number): string[] {
  const nodeIds = context.communities[communityId] ?? []
  const nodeSet = new Set(nodeIds)
  const lines = new Set<string>()

  for (const nodeId of nodeIds) {
    for (const neighborId of context.graph.neighbors(nodeId)) {
      if (nodeSet.has(neighborId)) {
        continue
      }

      const sourceLabel = String(context.graph.nodeAttributes(nodeId).label ?? nodeId)
      const targetLabel = String(context.graph.nodeAttributes(neighborId).label ?? neighborId)
      const targetCommunityId = context.nodeCommunity[neighborId]
      const targetCommunityLabel =
        targetCommunityId === undefined ? 'outside named communities' : (context.communityLabels[targetCommunityId] ?? `Community ${targetCommunityId}`)
      lines.add(`${sourceLabel} -> ${targetLabel} (${targetCommunityLabel})`)
      if (lines.size >= 4) {
        return [...lines]
      }
    }
  }

  return [...lines]
}

function handleResourceRead(id: string | number | null, graphPath: string, params: unknown): StdioResponse {
  const uri = stringParam(params, 'uri')
  if (!uri) {
    return failure(id, JSONRPC_INVALID_PARAMS, `resources/read requires a string uri parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const resource = resourcesForGraph(graphPath).find((entry) => entry.uri === uri)
  if (!resource) {
    return failure(id, JSONRPC_INVALID_PARAMS, `Unknown resource: ${uri}`)
  }

  if (statSync(resource.filePath).size > MAX_STDIO_RESOURCE_BYTES) {
    return failure(id, JSONRPC_SERVER_ERROR, `Resource too large to read over stdio: ${resource.name}`)
  }

  return ok(id, {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: readFileSync(resource.filePath, 'utf8'),
        annotations: resource.annotations,
      },
    ],
  })
}

function handleResourceSubscribe(id: string | number | null, graphPath: string, params: unknown, sessionState: StdioSessionState): StdioResponse {
  const uri = stringParam(params, 'uri')
  if (!uri) {
    return failure(id, JSONRPC_INVALID_PARAMS, `resources/subscribe requires a string uri parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const resource = resourcesForGraph(graphPath).find((entry) => entry.uri === uri)
  if (!resource) {
    return failure(id, JSONRPC_INVALID_PARAMS, `Unknown resource: ${uri}`)
  }

  const subscribedUris = ensureSubscribedResourceUris(sessionState)
  if (!subscribedUris.has(uri) && subscribedUris.size >= MAX_RESOURCE_SUBSCRIPTIONS) {
    return failure(id, JSONRPC_INVALID_PARAMS, `Subscription limit exceeded (${MAX_RESOURCE_SUBSCRIPTIONS})`)
  }

  subscribedUris.add(uri)
  ensureResourceVersions(sessionState).set(uri, resourceVersion(resource))
  sessionState.resourceListSignature = resourceListSignature(resourcesForGraph(graphPath))
  return ok(id, {})
}

function handleResourceUnsubscribe(id: string | number | null, params: unknown, sessionState: StdioSessionState): StdioResponse {
  const uri = stringParam(params, 'uri')
  if (!uri) {
    return failure(id, JSONRPC_INVALID_PARAMS, `resources/unsubscribe requires a string uri parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  ensureSubscribedResourceUris(sessionState).delete(uri)
  ensureResourceVersions(sessionState).delete(uri)
  return ok(id, {})
}

function handlePromptGet(id: string | number | null, graphPath: string, params: unknown): StdioResponse {
  const promptName = stringParam(params, 'name')
  if (!promptName) {
    return failure(id, JSONRPC_INVALID_PARAMS, `prompts/get requires a string name parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const promptArguments = recordParam(params, 'arguments') ?? {}
  const context = loadPromptContext(graphPath)
  const snapshot = graphSnapshotLines(context).join('\n')
  const suggestedQuestionsText = formatSuggestedQuestionLines(context)

  switch (promptName) {
    case 'graph_query_prompt': {
      const question = sanitizePromptValue(stringParam(promptArguments, 'question'), '<question>')
      const mode = sanitizePromptValue(stringParam(promptArguments, 'mode'), 'bfs')
      return ok(id, {
        description: 'Ask and answer a question using graph evidence only.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${snapshot}\nSuggested follow-up questions:\n${suggestedQuestionsText}\n\nUse graph evidence only to answer this question: ${question}\nPreferred traversal mode: ${mode}. Cite the strongest nodes/edges you relied on and stay explicit about uncertainty.`,
            },
          },
        ],
      })
    }
    case 'graph_path_prompt': {
      const source = sanitizePromptValue(stringParam(promptArguments, 'source'), '<source>')
      const target = sanitizePromptValue(stringParam(promptArguments, 'target'), '<target>')
      return ok(id, {
        description: 'Explain the shortest path between two graph concepts.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${snapshot}\n\nFind the shortest path between ${source} and ${target}. Then explain each hop in plain language and call out the relation/confidence of each edge. Mention any community boundaries the path crosses.`,
            },
          },
        ],
      })
    }
    case 'graph_explain_prompt': {
      const label = sanitizePromptValue(stringParam(promptArguments, 'label'), '<label>')
      const relation = sanitizePromptValue(stringParam(promptArguments, 'relation'), '')
      return ok(id, {
        description: 'Explain a node and summarize its neighborhood.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${snapshot}\nSuggested follow-up questions:\n${suggestedQuestionsText}\n\nExplain the graph node ${label}${relation ? ` with neighbor relation filter ${relation}` : ''}. Summarize what it is, where it comes from, and why its neighborhood matters.`,
            },
          },
        ],
      })
    }
    case 'graph_community_summary_prompt': {
      const communityId = integerLikeParamAlias(promptArguments, ['community_id', 'communityId'], { min: 0 })
      if (communityId === null) {
        return failure(id, JSONRPC_INVALID_PARAMS, 'graph_community_summary_prompt requires a numeric community_id parameter >= 0')
      }

      const members = communityMemberLabels(context, communityId)
      if (members.length === 0) {
        return failure(id, JSONRPC_INVALID_PARAMS, `Unknown community: ${communityId}`)
      }

      const communityLabel = context.communityLabels[communityId] ?? `Community ${communityId}`
      const bridges = communityBridgeLines(context, communityId)
      const relatedQuestions = context.suggestedQuestions.filter(
        (question) => question.includes(`\`${communityLabel}\``) || members.some((member) => question.includes(`\`${member}\``)),
      )

      return ok(id, {
        description: 'Summarize one community, its key nodes, and its boundaries.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                snapshot,
                `Community focus: ${communityLabel} (#${communityId}) with ${formatCount(members.length, 'node')}.`,
                `Key nodes: ${members.slice(0, 8).join(', ')}`,
                `Cross-community bridges: ${bridges.length > 0 ? bridges.join('; ') : 'No obvious cross-community bridges detected.'}`,
                'Related questions:',
                relatedQuestions.length > 0 ? relatedQuestions.map((question) => `- ${question}`).join('\n') : '- No community-specific follow-up questions detected.',
                '',
                `Summarize community #${communityId} (${communityLabel}) using graph evidence only. Explain its likely responsibility, the important files or concepts inside it, and the boundaries or bridges it has to the rest of the graph.`,
              ].join('\n'),
            },
          },
        ],
      })
    }
    default:
      return failure(id, JSONRPC_INVALID_PARAMS, `Unknown prompt: ${promptName}`)
  }
}

function completionValuesForPrefix(values: Iterable<string>, prefix: string): string[] {
  const normalizedPrefix = prefix.trim().toLowerCase()
  const matches: string[] = []
  const seen = new Set<string>()
  const scanLimit = MAX_COMPLETION_VALUES * 4

  for (const rawValue of values) {
    const value = rawValue.trim()
    if (!value) {
      continue
    }

    const normalizedValue = value.toLowerCase()
    if (seen.has(normalizedValue)) {
      continue
    }
    if (normalizedPrefix.length > 0 && !normalizedValue.startsWith(normalizedPrefix)) {
      continue
    }

    seen.add(normalizedValue)
    matches.push(value)
    if (matches.length >= scanLimit) {
      break
    }
  }

  return matches.sort((left, right) => left.localeCompare(right)).slice(0, MAX_COMPLETION_VALUES)
}

function graphNodeLabels(graph: ReturnType<typeof loadGraph>): string[] {
  return graph
    .nodeEntries()
    .map(([, attributes]) => String(attributes.label ?? '').trim())
    .filter(Boolean)
}

function graphRelations(graph: ReturnType<typeof loadGraph>): string[] {
  return graph
    .edgeEntries()
    .map(([, , attributes]) => String(attributes.relation ?? '').trim())
    .filter(Boolean)
}

function handleCompletion(id: string | number | null, graphPath: string, params: unknown): StdioResponse {
  const ref = recordParam(params, 'ref')
  const argument = recordParam(params, 'argument')
  if (!ref || !argument) {
    return failure(id, JSONRPC_INVALID_PARAMS, 'completion/complete requires ref and argument objects')
  }

  const refType = stringParam(ref, 'type')
  const refName = stringParamAlias(ref, ['name', 'id'])
  const argumentName = stringParam(argument, 'name')
  const argumentValue = stringParam(argument, 'value') ?? ''
  if (!refType || !refName || !argumentName) {
    return failure(id, JSONRPC_INVALID_PARAMS, 'completion/complete requires string ref.type, ref.name, and argument.name values')
  }
  if (refType !== 'ref/prompt' && refType !== 'prompt') {
    return failure(id, JSONRPC_INVALID_PARAMS, `Unsupported completion ref type: ${refType}`)
  }

  const context = loadPromptContext(graphPath)
  const graph = context.graph
  let values: string[]
  switch (refName) {
    case 'graph_query_prompt':
      if (argumentName !== 'mode') {
        return failure(id, JSONRPC_INVALID_PARAMS, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(['bfs', 'dfs'], argumentValue)
      break
    case 'graph_path_prompt':
      if (argumentName !== 'source' && argumentName !== 'target') {
        return failure(id, JSONRPC_INVALID_PARAMS, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(graphNodeLabels(graph), argumentValue)
      break
    case 'graph_explain_prompt':
      if (argumentName === 'label') {
        values = completionValuesForPrefix(graphNodeLabels(graph), argumentValue)
        break
      }
      if (argumentName === 'relation') {
        values = completionValuesForPrefix(graphRelations(graph), argumentValue)
        break
      }
      return failure(id, JSONRPC_INVALID_PARAMS, `Unsupported completion argument for ${refName}: ${argumentName}`)
    case 'graph_community_summary_prompt':
      if (argumentName !== 'community_id') {
        return failure(id, JSONRPC_INVALID_PARAMS, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(
        Object.keys(context.communities)
          .map(Number)
          .sort((left, right) => left - right)
          .map(String),
        argumentValue,
      )
      break
    default:
      return failure(id, JSONRPC_INVALID_PARAMS, `Unknown completion reference: ${refName}`)
  }

  return ok(id, {
    completion: {
      values,
      total: values.length,
      hasMore: false,
    },
  })
}

function handleDirectQuery(graphPath: string, id: string | number | null, params: unknown): StdioResponse {
  const graph = loadGraphCached(graphPath)
  const question = stringParam(params, 'question')
  if (!question) {
    return failure(id, JSONRPC_INVALID_PARAMS, `query requires a string question parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const { failureResponse, queryOptions } = queryOptionsFromParams(id, params)
  if (failureResponse) {
    return failureResponse
  }

  return ok(id, queryGraph(graph, question, queryOptions))
}

function handleGraphDiff(id: string | number | null, currentGraphPath: string, params: unknown): StdioResponse {
  const options = graphDiffOptionsFromParams(id, params)
  if (options.failureResponse) {
    return options.failureResponse
  }

  try {
    const baselineGraph = loadGraphCached(options.baselineGraphPath ?? currentGraphPath)
    const currentGraph = loadGraphCached(currentGraphPath)
    return ok(id, diffGraphs(baselineGraph, currentGraph, { ...(options.limit !== undefined ? { limit: options.limit } : {}) }))
  } catch (error) {
    return failure(id, JSONRPC_SERVER_ERROR, error instanceof Error ? error.message : 'Graph diff failed')
  }
}

function handleToolCall(id: string | number | null, graphPath: string, params: unknown): StdioResponse {
  const toolName = stringParam(params, 'name')
  if (!toolName) {
    return failure(id, JSONRPC_INVALID_PARAMS, `tools/call requires a string name parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const toolArguments = recordParam(params, 'arguments') ?? {}
  const graph = loadGraphCached(graphPath)

  switch (toolName) {
    case 'query_graph': {
      const question = stringParam(toolArguments, 'question')
      if (!question) {
        return failure(id, JSONRPC_INVALID_PARAMS, `query_graph requires a string question parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }

      const { failureResponse, queryOptions } = queryOptionsFromParams(id, toolArguments)
      if (failureResponse) {
        return failureResponse
      }

      return ok(id, textToolResult(queryGraph(graph, question, queryOptions)))
    }
    case 'get_node': {
      const label = stringParam(toolArguments, 'label')
      if (!label) {
        return failure(id, JSONRPC_INVALID_PARAMS, `get_node requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      return ok(id, textToolResult(getNode(graph, label)))
    }
    case 'graph_diff': {
      const diffResponse = handleGraphDiff(id, graphPath, toolArguments)
      return 'error' in diffResponse && diffResponse.error ? diffResponse : ok(id, textToolResult(String(diffResponse.result ?? '')))
    }
    case 'semantic_anomalies':
      return ok(id, textToolResult(semanticAnomaliesSummary(graphPath, numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 5)))
    case 'get_neighbors': {
      const label = stringParam(toolArguments, 'label')
      if (!label) {
        return failure(id, JSONRPC_INVALID_PARAMS, `get_neighbors requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      return ok(id, textToolResult(getNeighbors(graph, label, stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? '')))
    }
    case 'shortest_path': {
      const source = stringParam(toolArguments, 'source')
      const target = stringParam(toolArguments, 'target')
      if (!source || !target) {
        return failure(id, JSONRPC_INVALID_PARAMS, `shortest_path requires string source and target parameters <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      return ok(id, textToolResult(shortestPath(graph, source, target, numberParamAlias(toolArguments, ['max_hops', 'maxHops'], { min: 1, max: MAX_STDIO_HOPS }) ?? 8)))
    }
    case 'explain_node': {
      const label = stringParam(toolArguments, 'label')
      if (!label) {
        return failure(id, JSONRPC_INVALID_PARAMS, `explain_node requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      const relation = stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? ''
      return ok(id, textToolResult(`${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`))
    }
    case 'graph_stats':
      return ok(id, textToolResult(graphStats(graph)))
    case 'god_nodes':
      return ok(id, textToolResult(godNodesSummary(graph, numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 10)))
    case 'get_community': {
      const communityId = numberParamAlias(toolArguments, ['community_id', 'communityId'], { min: 0 })
      if (communityId === null) {
        return failure(id, JSONRPC_INVALID_PARAMS, 'get_community requires a numeric community_id parameter >= 0')
      }
      return ok(id, textToolResult(getCommunity(graph, communitiesFromGraph(graph), communityId)))
    }
    case 'retrieve': {
      const question = stringParam(toolArguments, 'question')
      if (!question) {
        return failure(id, JSONRPC_INVALID_PARAMS, `retrieve requires a string question parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      const retrieveBudget = numberParamAlias(toolArguments, ['budget'], { min: 1, max: MAX_STDIO_TOKEN_BUDGET })
      if (retrieveBudget === null) {
        return failure(id, JSONRPC_INVALID_PARAMS, `retrieve requires a numeric budget parameter between 1 and ${MAX_STDIO_TOKEN_BUDGET}`)
      }
      const retrieveCommunity = numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const retrieveFileType = stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = retrieveContext(graph, {
        question,
        budget: retrieveBudget,
        ...(retrieveCommunity !== null ? { community: retrieveCommunity } : {}),
        ...(retrieveFileType ? { fileType: retrieveFileType } : {}),
      })
      return ok(id, textToolResult(JSON.stringify(result)))
    }
    default:
      return failure(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${toolName}`)
  }
}

export function handleStdioRequest(graphPath: string, payload: unknown, sessionState: StdioSessionState = createSessionState()): StdioResponse | null {
  if (!payload || typeof payload !== 'object') {
    return failure(null, JSONRPC_INVALID_REQUEST, 'Invalid request')
  }

  const request = payload as StdioRequest
  const id = requestId(request)
  const method = typeof request.method === 'string' ? request.method : null
  if (!method) {
    return failure(id, JSONRPC_INVALID_REQUEST, 'Invalid request: missing method')
  }

  try {
    const params = request.params

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            completions: {},
            logging: {},
            prompts: { listChanged: false },
            resources: { subscribe: true, listChanged: true },
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            title: MCP_SERVER_TITLE,
            version: MCP_SERVER_VERSION,
          },
          instructions: 'Use tools/list to discover graph tools, then tools/call to query the generated graph.',
        })
      case 'notifications/initialized':
        return null
      case 'completion/complete':
        return handleCompletion(id, graphPath, params)
      case 'logging/setLevel': {
        const requestedLevel = parseLogLevel(stringParam(params, 'level'))
        if (!requestedLevel) {
          return failure(id, JSONRPC_INVALID_PARAMS, 'logging/setLevel requires level to be one of debug, info, notice, warning, error, critical, alert, emergency')
        }
        sessionState.logLevel = requestedLevel
        return ok(id, {})
      }
      case 'prompts/list':
        return ok(id, { prompts: promptDefinitionsForGraph(graphPath) })
      case 'prompts/get':
        return handlePromptGet(id, graphPath, params)
      case 'resources/list':
        return ok(id, {
          resources: resourcesForGraph(graphPath).map(({ uri, name, title, description, mimeType, annotations }) => ({
            uri,
            name,
            title,
            description,
            mimeType,
            annotations,
          })),
        })
      case 'resources/subscribe':
        return handleResourceSubscribe(id, graphPath, params, sessionState)
      case 'resources/unsubscribe':
        return handleResourceUnsubscribe(id, params, sessionState)
      case 'resources/read':
        return handleResourceRead(id, graphPath, params)
      case 'tools/list':
        return ok(id, { tools: MCP_TOOLS })
      case 'tools/call':
        return handleToolCall(id, graphPath, params)
      case 'ping':
        return ok(id, { ok: true })
      case 'query':
        return handleDirectQuery(graphPath, id, params)
      case 'diff':
        return handleGraphDiff(id, graphPath, params)
      case 'anomalies':
        return ok(id, semanticAnomaliesSummary(graphPath, numberParamAlias(params, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 5))
      case 'node': {
        const graph = loadGraphCached(graphPath)
        const label = stringParam(params, 'label')
        if (!label) {
          return failure(id, JSONRPC_INVALID_PARAMS, `node requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        return ok(id, getNode(graph, label))
      }
      case 'neighbors': {
        const graph = loadGraphCached(graphPath)
        const label = stringParam(params, 'label')
        if (!label) {
          return failure(id, JSONRPC_INVALID_PARAMS, `neighbors requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        return ok(id, getNeighbors(graph, label, stringParamAlias(params, ['relation_filter', 'relation']) ?? ''))
      }
      case 'path': {
        const graph = loadGraphCached(graphPath)
        const source = stringParam(params, 'source')
        const target = stringParam(params, 'target')
        if (!source || !target) {
          return failure(id, JSONRPC_INVALID_PARAMS, `path requires string source and target parameters <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        return ok(id, shortestPath(graph, source, target, numberParamAlias(params, ['max_hops', 'maxHops'], { min: 1, max: MAX_STDIO_HOPS }) ?? 8))
      }
      case 'explain': {
        const graph = loadGraphCached(graphPath)
        const label = stringParam(params, 'label')
        if (!label) {
          return failure(id, JSONRPC_INVALID_PARAMS, `explain requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        const relation = stringParamAlias(params, ['relation_filter', 'relation']) ?? ''
        return ok(id, `${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`)
      }
      case 'stats': {
        const graph = loadGraphCached(graphPath)
        return ok(id, graphStats(graph))
      }
      case 'god_nodes': {
        const graph = loadGraphCached(graphPath)
        return ok(id, godNodesSummary(graph, numberParamAlias(params, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 10))
      }
      case 'community': {
        const graph = loadGraphCached(graphPath)
        const communityId = numberParamAlias(params, ['community_id', 'communityId'], { min: 0 })
        if (communityId === null) {
          return failure(id, JSONRPC_INVALID_PARAMS, 'community requires a numeric community_id parameter >= 0')
        }
        return ok(id, getCommunity(graph, communitiesFromGraph(graph), communityId))
      }
      default:
        return failure(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  } catch {
    return failure(id, JSONRPC_SERVER_ERROR, 'Graph query failed')
  }
}

export async function serveGraphStdio(options: ServeGraphStdioOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const logger = options.logger ?? console
  const sessionState = createSessionState()

  logger.log(`[graphify serve] stdio ready for ${options.graphPath}`)

  const readline = createInterface({ input, crlfDelay: Infinity })

  for await (const line of readline) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    if (trimmed.length > MAX_STDIO_LINE_BYTES) {
      const response = failure(null, JSONRPC_INVALID_REQUEST, `Payload too large (max ${MAX_STDIO_LINE_BYTES} bytes)`)
      output.write(`${JSON.stringify(response)}\n`)
      continue
    }

    let payload: unknown
    try {
      payload = JSON.parse(trimmed)
    } catch {
      const response = failure(null, JSONRPC_PARSE_ERROR, 'Parse error')
      emitLogNotification(output, sessionState, 'error', { message: response.error?.message ?? 'Parse error', code: JSONRPC_PARSE_ERROR })
      output.write(`${JSON.stringify(response)}\n`)
      continue
    }

    emitResourceNotifications(output, options.graphPath, sessionState)
    const response = handleStdioRequest(options.graphPath, payload, sessionState)
    if (response) {
      if (response.error) {
        emitLogNotification(output, sessionState, 'error', { message: response.error.message, code: response.error.code })
      }
      output.write(`${JSON.stringify(response)}\n`)
    }
  }
}
