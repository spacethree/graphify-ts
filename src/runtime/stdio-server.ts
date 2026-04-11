import { createInterface } from 'node:readline'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { communitiesFromGraph, getCommunity, getNeighbors, getNode, graphStats, loadGraph, queryGraph, shortestPath } from './serve.js'
import { validateGraphPath } from '../shared/security.js'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_SERVER_ERROR = -32000
const MCP_PROTOCOL_VERSION = '2025-11-25'
const MCP_SERVER_NAME = 'graphify-ts'
const MCP_SERVER_VERSION = '0.1.0'
const MAX_STDIO_LINE_BYTES = 1_000_000
const MAX_STDIO_TEXT_LENGTH = 512
const MAX_STDIO_TOKEN_BUDGET = 100_000
const MAX_STDIO_DEPTH = 20
const MAX_STDIO_HOPS = 20
const MAX_STDIO_RESOURCE_BYTES = 5_000_000
const graphCache = new Map<string, { mtimeMs: number; graph: ReturnType<typeof loadGraph> }>()

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

interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

interface McpResourceDefinition {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  filePath: string
}

interface McpPromptDefinition {
  name: string
  title: string
  description: string
  arguments?: Array<{
    name: string
    description: string
    required?: boolean
  }>
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

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'query_graph',
    description: 'Traverse the graph to answer a question from graph evidence.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string' },
        mode: { type: 'string', enum: ['bfs', 'dfs'] },
        depth: { type: 'number' },
        tokenBudget: { type: 'number' },
      },
    },
  },
  {
    name: 'get_node',
    description: 'Return details for one graph node.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
      },
    },
  },
  {
    name: 'get_neighbors',
    description: 'Return neighbors for one node, optionally filtered by relation.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        relation: { type: 'string' },
      },
    },
  },
  {
    name: 'shortest_path',
    description: 'Find the shortest path between two labels in the graph.',
    inputSchema: {
      type: 'object',
      required: ['source', 'target'],
      properties: {
        source: { type: 'string' },
        target: { type: 'string' },
        maxHops: { type: 'number' },
      },
    },
  },
  {
    name: 'explain_node',
    description: 'Explain a node and summarize its neighborhood.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        relation: { type: 'string' },
      },
    },
  },
  {
    name: 'graph_stats',
    description: 'Return summary graph statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_community',
    description: 'Return the members of a community by numeric id.',
    inputSchema: {
      type: 'object',
      required: ['communityId'],
      properties: {
        communityId: { type: 'number' },
      },
    },
  },
]

const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: 'graph_query_prompt',
    title: 'Graph Evidence Query',
    description: 'Ask a question and answer it using graph evidence only.',
    arguments: [
      { name: 'question', description: 'The question to answer from the graph', required: true },
      { name: 'mode', description: 'Traversal mode: bfs or dfs' },
    ],
  },
  {
    name: 'graph_path_prompt',
    title: 'Graph Path Exploration',
    description: 'Explain the shortest path between two graph concepts.',
    arguments: [
      { name: 'source', description: 'Starting concept label', required: true },
      { name: 'target', description: 'Target concept label', required: true },
    ],
  },
  {
    name: 'graph_explain_prompt',
    title: 'Graph Node Explanation',
    description: 'Explain a single node and summarize its neighborhood.',
    arguments: [
      { name: 'label', description: 'Node label to explain', required: true },
      { name: 'relation', description: 'Optional neighbor relation filter' },
    ],
  },
]

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

  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
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

  return candidates.filter((resource) => existsSync(resource.filePath))
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
      },
    ],
  })
}

function handlePromptGet(id: string | number | null, params: unknown): StdioResponse {
  const promptName = stringParam(params, 'name')
  if (!promptName) {
    return failure(id, JSONRPC_INVALID_PARAMS, `prompts/get requires a string name parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const promptArguments = recordParam(params, 'arguments') ?? {}

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
              text: `Use graph evidence only to answer this question: ${question}\nPreferred traversal mode: ${mode}. Cite the strongest nodes/edges you relied on and stay explicit about uncertainty.`,
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
              text: `Find the shortest path between ${source} and ${target}. Then explain each hop in plain language and call out the relation/confidence of each edge.`,
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
              text: `Explain the graph node ${label}${relation ? ` with neighbor relation filter ${relation}` : ''}. Summarize what it is, where it comes from, and why its neighborhood matters.`,
            },
          },
        ],
      })
    }
    default:
      return failure(id, JSONRPC_INVALID_PARAMS, `Unknown prompt: ${promptName}`)
  }
}

function handleDirectQuery(graphPath: string, id: string | number | null, params: unknown): StdioResponse {
  const graph = loadGraphCached(graphPath)
  const question = stringParam(params, 'question')
  if (!question) {
    return failure(id, JSONRPC_INVALID_PARAMS, `query requires a string question parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const mode = stringParam(params, 'mode') === 'dfs' ? 'dfs' : 'bfs'
  const depth = numberParam(params, 'depth', { min: 0, max: MAX_STDIO_DEPTH })
  const tokenBudget = numberParam(params, 'tokenBudget', { min: 1, max: MAX_STDIO_TOKEN_BUDGET })
  const queryOptions: { mode?: 'bfs' | 'dfs'; depth?: number; tokenBudget?: number } = {
    mode,
    ...(depth !== null ? { depth } : {}),
    ...(tokenBudget !== null ? { tokenBudget } : {}),
  }

  return ok(id, queryGraph(graph, question, queryOptions))
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

      const mode = stringParam(toolArguments, 'mode') === 'dfs' ? 'dfs' : 'bfs'
      const depth = numberParam(toolArguments, 'depth', { min: 0, max: MAX_STDIO_DEPTH })
      const tokenBudget = numberParam(toolArguments, 'tokenBudget', { min: 1, max: MAX_STDIO_TOKEN_BUDGET })
      const queryOptions: { mode?: 'bfs' | 'dfs'; depth?: number; tokenBudget?: number } = {
        mode,
        ...(depth !== null ? { depth } : {}),
        ...(tokenBudget !== null ? { tokenBudget } : {}),
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
    case 'get_neighbors': {
      const label = stringParam(toolArguments, 'label')
      if (!label) {
        return failure(id, JSONRPC_INVALID_PARAMS, `get_neighbors requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      return ok(id, textToolResult(getNeighbors(graph, label, stringParam(toolArguments, 'relation') ?? '')))
    }
    case 'shortest_path': {
      const source = stringParam(toolArguments, 'source')
      const target = stringParam(toolArguments, 'target')
      if (!source || !target) {
        return failure(id, JSONRPC_INVALID_PARAMS, `shortest_path requires string source and target parameters <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      return ok(id, textToolResult(shortestPath(graph, source, target, numberParam(toolArguments, 'maxHops', { min: 1, max: MAX_STDIO_HOPS }) ?? 8)))
    }
    case 'explain_node': {
      const label = stringParam(toolArguments, 'label')
      if (!label) {
        return failure(id, JSONRPC_INVALID_PARAMS, `explain_node requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
      }
      const relation = stringParam(toolArguments, 'relation') ?? ''
      return ok(id, textToolResult(`${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`))
    }
    case 'graph_stats':
      return ok(id, textToolResult(graphStats(graph)))
    case 'get_community': {
      const communityId = numberParam(toolArguments, 'communityId', { min: 0 })
      if (communityId === null) {
        return failure(id, JSONRPC_INVALID_PARAMS, 'get_community requires a numeric communityId parameter >= 0')
      }
      return ok(id, textToolResult(getCommunity(graph, communitiesFromGraph(graph), communityId)))
    }
    default:
      return failure(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${toolName}`)
  }
}

export function handleStdioRequest(graphPath: string, payload: unknown): StdioResponse | null {
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
            prompts: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
          instructions: 'Use tools/list to discover graph tools, then tools/call to query the generated graph.',
        })
      case 'notifications/initialized':
        return null
      case 'prompts/list':
        return ok(id, { prompts: MCP_PROMPTS })
      case 'prompts/get':
        return handlePromptGet(id, params)
      case 'resources/list':
        return ok(id, {
          resources: resourcesForGraph(graphPath).map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })),
        })
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
        return ok(id, getNeighbors(graph, label, stringParam(params, 'relation') ?? ''))
      }
      case 'path': {
        const graph = loadGraphCached(graphPath)
        const source = stringParam(params, 'source')
        const target = stringParam(params, 'target')
        if (!source || !target) {
          return failure(id, JSONRPC_INVALID_PARAMS, `path requires string source and target parameters <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        return ok(id, shortestPath(graph, source, target, numberParam(params, 'maxHops', { min: 1, max: MAX_STDIO_HOPS }) ?? 8))
      }
      case 'explain': {
        const graph = loadGraphCached(graphPath)
        const label = stringParam(params, 'label')
        if (!label) {
          return failure(id, JSONRPC_INVALID_PARAMS, `explain requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        const relation = stringParam(params, 'relation') ?? ''
        return ok(id, `${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`)
      }
      case 'stats': {
        const graph = loadGraphCached(graphPath)
        return ok(id, graphStats(graph))
      }
      case 'community': {
        const graph = loadGraphCached(graphPath)
        const communityId = numberParam(params, 'communityId', { min: 0 })
        if (communityId === null) {
          return failure(id, JSONRPC_INVALID_PARAMS, 'community requires a numeric communityId parameter >= 0')
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
      output.write(`${JSON.stringify(response)}\n`)
      continue
    }

    const response = handleStdioRequest(options.graphPath, payload)
    if (response) {
      output.write(`${JSON.stringify(response)}\n`)
    }
  }
}
