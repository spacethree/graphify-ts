import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { handleStdioRequest, serveGraphStdio } from '../../src/runtime/stdio-server.js'

function createGraphFixtureRoot(): string {
  const parentDir = resolve('graphify-out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'graphify-ts-stdio-'))
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code', community: 0 },
        { id: 'client', label: 'HttpClient', source_file: 'client.ts', source_location: '2', file_type: 'code', community: 0 },
        { id: 'transport', label: 'Transport', source_file: 'transport.ts', source_location: '3', file_type: 'code', community: 1 },
      ],
      edges: [
        { source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' },
        { source: 'client', target: 'transport', relation: 'uses', confidence: 'EXTRACTED', source_file: 'client.ts' },
      ],
      hyperedges: [],
    }),
    'utf8',
  )
  writeFileSync(join(root, 'GRAPH_REPORT.md'), '# Graph Report\n\n- AuthService calls HttpClient\n', 'utf8')
  writeFileSync(join(root, 'graph.html'), '<!doctype html><title>graphify-ts</title>', 'utf8')
  return root
}

describe('stdio runtime', () => {
  it('supports basic MCP initialize, tools/list, and tools/call flows', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const initialize = handleStdioRequest(graphPath, { id: 1, method: 'initialize' })
      const prompts = handleStdioRequest(graphPath, { id: 2, method: 'prompts/list' })
      const resources = handleStdioRequest(graphPath, { id: 3, method: 'resources/list' })
      const tools = handleStdioRequest(graphPath, { id: 4, method: 'tools/list' })
      const call = handleStdioRequest(graphPath, {
        id: 5,
        method: 'tools/call',
        params: {
          name: 'shortest_path',
          arguments: { source: 'AuthService', target: 'Transport', maxHops: 3 },
        },
      })
      const promptGet = handleStdioRequest(graphPath, {
        id: 6,
        method: 'prompts/get',
        params: {
          name: 'graph_query_prompt',
          arguments: { question: 'How does auth reach transport?' },
        },
      })
      const resourceRead = handleStdioRequest(graphPath, {
        id: 7,
        method: 'resources/read',
        params: { uri: 'graphify://artifact/GRAPH_REPORT.md' },
      })
      const initializedNotification = handleStdioRequest(graphPath, { method: 'notifications/initialized' })

      expect(initialize).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {
            completions: {},
            logging: {},
            prompts: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            tools: { listChanged: false },
          },
          serverInfo: { name: 'graphify-ts' },
        },
      })
      expect((prompts?.result as { prompts: Array<{ name: string }> }).prompts.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(['graph_query_prompt', 'graph_path_prompt', 'graph_explain_prompt']),
      )
      expect((resources?.result as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(['graphify://artifact/graph.json', 'graphify://artifact/GRAPH_REPORT.md', 'graphify://artifact/graph.html']),
      )
      expect((tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['query_graph', 'get_node', 'get_neighbors', 'shortest_path', 'explain_node', 'graph_stats', 'get_community', 'god_nodes']),
      )
      expect((call?.result as { content: Array<{ type: string; text: string }> }).content[0]?.text).toContain('Shortest path (2 hops)')
      expect((promptGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('How does auth reach transport?')
      expect((resourceRead?.result as { contents: Array<{ text: string }> }).contents[0]?.text).toContain('# Graph Report')
      expect(initializedNotification).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports completion requests for prompt arguments', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const labelCompletion = handleStdioRequest(graphPath, {
        id: 8,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'graph_explain_prompt' },
          argument: { name: 'label', value: 'Auth' },
        },
      })
      const modeCompletion = handleStdioRequest(graphPath, {
        id: 9,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'graph_query_prompt' },
          argument: { name: 'mode', value: 'd' },
        },
      })

      expect(labelCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 8,
        result: {
          completion: {
            values: expect.arrayContaining(['AuthService']),
          },
        },
      })
      expect(modeCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 9,
        result: {
          completion: {
            values: ['dfs'],
            hasMore: false,
          },
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports logging/setLevel and emits JSON-RPC log notifications for stdio errors', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const input = new PassThrough()
      const output = new PassThrough()
      let outputText = ''
      output.on('data', (chunk) => {
        outputText += chunk.toString('utf8')
      })

      input.end([JSON.stringify({ id: 1, method: 'logging/setLevel', params: { level: 'error' } }), '{bad json'].join('\n'))

      await serveGraphStdio({
        graphPath,
        input,
        output,
      })

      const messages = outputText
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ jsonrpc: '2.0', id: 1, result: {} }),
          expect.objectContaining({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: expect.objectContaining({
              level: 'error',
            }),
          }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports richer MCP snake_case schemas and tool arguments', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const initialize = handleStdioRequest(graphPath, { id: 1, method: 'initialize' })
      const tools = handleStdioRequest(graphPath, { id: 2, method: 'tools/list' })
      const query = handleStdioRequest(graphPath, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'query_graph',
          arguments: { question: 'auth transport', token_budget: 256, depth: 3 },
        },
      })
      const neighbors = handleStdioRequest(graphPath, {
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_neighbors',
          arguments: { label: 'HttpClient', relation_filter: 'uses' },
        },
      })
      const path = handleStdioRequest(graphPath, {
        id: 5,
        method: 'tools/call',
        params: {
          name: 'shortest_path',
          arguments: { source: 'AuthService', target: 'Transport', max_hops: 3 },
        },
      })
      const community = handleStdioRequest(graphPath, {
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_community',
          arguments: { community_id: 0 },
        },
      })
      const godNodes = handleStdioRequest(graphPath, {
        id: 7,
        method: 'tools/call',
        params: {
          name: 'god_nodes',
          arguments: { top_n: 1 },
        },
      })

      const toolList = (tools?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
      const queryTool = toolList.find((tool) => tool.name === 'query_graph')
      const neighborsTool = toolList.find((tool) => tool.name === 'get_neighbors')
      const pathTool = toolList.find((tool) => tool.name === 'shortest_path')
      const communityTool = toolList.find((tool) => tool.name === 'get_community')

      expect(initialize).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          serverInfo: {
            name: 'graphify-ts',
            title: 'Graphify TS',
          },
        },
      })
      expect(queryTool?.inputSchema.properties).toHaveProperty('token_budget')
      expect(neighborsTool?.inputSchema.properties).toHaveProperty('relation_filter')
      expect(pathTool?.inputSchema.properties).toHaveProperty('max_hops')
      expect(communityTool?.inputSchema.properties).toHaveProperty('community_id')
      expect((query?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Traversal:')
      expect((neighbors?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Transport')
      expect((path?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Shortest path (2 hops)')
      expect((community?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Community 0')
      expect((godNodes?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('God nodes')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('handles stdio requests for query and path-like methods', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const ping = handleStdioRequest(graphPath, { id: 1, method: 'ping' })
      const path = handleStdioRequest(graphPath, { id: 2, method: 'path', params: { source: 'AuthService', target: 'Transport', maxHops: 3 } })
      const explain = handleStdioRequest(graphPath, { id: 3, method: 'explain', params: { label: 'HttpClient', relation: 'uses' } })

      expect(ping).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
      expect(path).not.toBeNull()
      expect(explain).not.toBeNull()
      expect((path as { result: string }).result).toContain('Shortest path (2 hops)')
      expect((explain as { result: string }).result).toContain('Node: HttpClient')
      expect((explain as { result: string }).result).toContain('Neighbors of HttpClient')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reloads the cached graph when graph.json changes on disk', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')

      const before = handleStdioRequest(graphPath, { id: 1, method: 'stats' })

      writeFileSync(
        graphPath,
        JSON.stringify({
          nodes: [{ id: 'replacement', label: 'ReplacementNode', source_file: 'replacement.ts', source_location: '1', file_type: 'code', community: 0 }],
          edges: [],
          hyperedges: [],
        }),
        'utf8',
      )

      const after = handleStdioRequest(graphPath, { id: 2, method: 'node', params: { label: 'ReplacementNode' } })

      expect((before as { result: string }).result).toContain('Nodes: 3')
      expect((after as { result: string }).result).toContain('Node: ReplacementNode')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns JSON-RPC-style errors for invalid requests', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      expect(handleStdioRequest(graphPath, null)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid request' },
      })
      expect(handleStdioRequest(graphPath, { id: 9, method: 'mystery' })).toEqual({
        jsonrpc: '2.0',
        id: 9,
        error: { code: -32601, message: 'Method not found: mystery' },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serves JSON-line requests over stdio streams', async () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const input = new PassThrough()
      const output = new PassThrough()
      const loggerMessages: string[] = []
      let outputText = ''
      output.on('data', (chunk) => {
        outputText += chunk.toString('utf8')
      })

      input.end(
        [
          JSON.stringify({ id: 1, method: 'stats' }),
          JSON.stringify({ method: 'notifications/initialized' }),
          '{bad json',
          JSON.stringify({ id: 2, method: 'node', params: { label: 'AuthService' } }),
        ].join('\n'),
      )

      await serveGraphStdio({
        graphPath,
        input,
        output,
        logger: {
          log(message?: string) {
            loggerMessages.push(String(message ?? ''))
          },
          error() {},
        },
      })

      const responses = outputText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const rpcResponses = responses.filter((message) => 'id' in message)
      const notifications = responses.filter((message) => message.method === 'notifications/message')

      expect(loggerMessages[0]).toContain('[graphify serve] stdio ready')
      expect(notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: expect.objectContaining({
              level: 'error',
            }),
          }),
        ]),
      )
      expect(rpcResponses[0]).toMatchObject({ jsonrpc: '2.0', id: 1 })
      expect(rpcResponses[0].result).toContain('Nodes: 3')
      expect(rpcResponses[1]).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      expect(rpcResponses[2]).toMatchObject({ jsonrpc: '2.0', id: 2 })
      expect(rpcResponses[2].result).toContain('Node: AuthService')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
