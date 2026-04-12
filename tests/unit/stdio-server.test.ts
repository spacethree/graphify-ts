import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { handleStdioRequest, serveGraphStdio } from '../../src/runtime/stdio-server.js'

function createGraphFixtureRoot(): string {
  const parentDir = resolve('graphify-out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'graphify-ts-stdio-'))
  writeFileSync(
    join(root, 'baseline.graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code', community: 0 },
        { id: 'client', label: 'HttpClient', source_file: 'client.ts', source_location: '2', file_type: 'code', community: 0 },
      ],
      edges: [{ source: 'auth', target: 'client', relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' }],
      hyperedges: [],
    }),
    'utf8',
  )
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
      community_labels: {
        '0': 'Auth Services',
        '1': 'Transport Layer',
      },
      semantic_anomalies: [
        {
          id: 'bridge-httpclient',
          kind: 'bridge_node',
          severity: 'HIGH',
          score: 8.4,
          summary: 'HttpClient bridges Auth Services and Transport Layer.',
          why: 'High betweenness across two communities.',
        },
      ],
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
      const communityPrompt = handleStdioRequest(graphPath, {
        id: 8,
        method: 'prompts/get',
        params: {
          name: 'graph_community_summary_prompt',
          arguments: { community_id: '0' },
        },
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
        expect.arrayContaining(['graph_query_prompt', 'graph_path_prompt', 'graph_explain_prompt', 'graph_community_summary_prompt']),
      )
      expect((resources?.result as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(['graphify://artifact/graph.json', 'graphify://artifact/GRAPH_REPORT.md', 'graphify://artifact/graph.html']),
      )
      const graphResource = (resources?.result as { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> }).resources.find(
        (resource) => resource.uri === 'graphify://artifact/graph.json',
      )
      expect((tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'query_graph',
          'graph_diff',
          'semantic_anomalies',
          'get_node',
          'get_neighbors',
          'shortest_path',
          'explain_node',
          'graph_stats',
          'get_community',
          'god_nodes',
        ]),
      )
      expect(graphResource?.annotations?.graph_version).toMatch(/^[a-f0-9]{12}$/)
      expect(graphResource?.annotations?.graph_modified_ms).toEqual(expect.any(Number))
      expect((call?.result as { content: Array<{ type: string; text: string }> }).content[0]?.text).toContain('Shortest path (2 hops)')
      expect((promptGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('How does auth reach transport?')
      expect((promptGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('Top communities:')
      expect((promptGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('Auth Services')
      expect((resourceRead?.result as { contents: Array<{ text: string }> }).contents[0]?.text).toContain('# Graph Report')
      expect((resourceRead?.result as { contents: Array<{ annotations?: Record<string, unknown> }> }).contents[0]?.annotations?.graph_version).toMatch(/^[a-f0-9]{12}$/)
      expect((resourceRead?.result as { contents: Array<{ annotations?: Record<string, unknown> }> }).contents[0]?.annotations?.resource_modified_ms).toEqual(
        expect.any(Number),
      )
      expect((communityPrompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('Auth Services')
      expect((communityPrompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('AuthService')
      expect((communityPrompt?.result as { messages: Array<{ content: { text: string } }> }).messages[0]?.content.text).toContain('HttpClient')
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
      const communityCompletion = handleStdioRequest(graphPath, {
        id: 10,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'graph_community_summary_prompt' },
          argument: { name: 'community_id', value: '' },
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
      expect(communityCompletion).toMatchObject({
        jsonrpc: '2.0',
        id: 10,
        result: {
          completion: {
            values: expect.arrayContaining(['0', '1']),
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
          arguments: { question: 'auth transport', token_budget: 256, depth: 3, rank_by: 'degree', community_id: 0, file_type: 'code' },
        },
      })
      const filteredOut = handleStdioRequest(graphPath, {
        id: 31,
        method: 'tools/call',
        params: {
          name: 'query_graph',
          arguments: { question: 'auth', community_id: 1 },
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
      const anomalies = handleStdioRequest(graphPath, {
        id: 71,
        method: 'tools/call',
        params: {
          name: 'semantic_anomalies',
          arguments: { top_n: 1 },
        },
      })
      const diff = handleStdioRequest(graphPath, {
        id: 8,
        method: 'tools/call',
        params: {
          name: 'graph_diff',
          arguments: { baseline_graph_path: join(root, 'baseline.graph.json'), limit: 5 },
        },
      })
      const directDiff = handleStdioRequest(graphPath, {
        id: 9,
        method: 'diff',
        params: { baseline_graph_path: join(root, 'baseline.graph.json'), limit: 5 },
      })
      const directAnomalies = handleStdioRequest(graphPath, {
        id: 10,
        method: 'anomalies',
        params: { top_n: 1 },
      })

      const toolList = (tools?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
      const queryTool = toolList.find((tool) => tool.name === 'query_graph')
      const diffTool = toolList.find((tool) => tool.name === 'graph_diff')
      const anomaliesTool = toolList.find((tool) => tool.name === 'semantic_anomalies')
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
      expect(queryTool?.inputSchema.properties).toHaveProperty('rank_by')
      expect(queryTool?.inputSchema.properties).toHaveProperty('community_id')
      expect(queryTool?.inputSchema.properties).toHaveProperty('file_type')
      expect(diffTool?.inputSchema.properties).toHaveProperty('baseline_graph_path')
      expect(diffTool?.inputSchema.properties).toHaveProperty('limit')
      expect(anomaliesTool?.inputSchema.properties).toHaveProperty('top_n')
      expect(neighborsTool?.inputSchema.properties).toHaveProperty('relation_filter')
      expect(pathTool?.inputSchema.properties).toHaveProperty('max_hops')
      expect(communityTool?.inputSchema.properties).toHaveProperty('community_id')
      expect((query?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Traversal:')
      expect((query?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Rank: DEGREE')
      expect((filteredOut?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('No matching nodes found')
      expect((neighbors?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Transport')
      expect((path?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Shortest path (2 hops)')
      expect((community?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Community 0')
      expect((godNodes?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('God nodes')
      expect((anomalies?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Semantic anomalies (1 shown)')
      expect((anomalies?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('HttpClient bridges Auth Services and Transport Layer.')
      expect((diff?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Graph diff: 1 new node, 1 new edge')
      expect((diff?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('Transport [transport]')
      expect(directDiff?.result as string).toContain('Before: 2 nodes')
      expect(directDiff?.result as string).toContain('After: 3 nodes')
      expect(directAnomalies?.result as string).toContain('Semantic anomalies (1 shown)')
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
      const freshnessBefore = handleStdioRequest(graphPath, { id: 11, method: 'resources/list' })

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
      const freshnessAfter = handleStdioRequest(graphPath, { id: 12, method: 'resources/list' })

      const versionBefore = (freshnessBefore as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'graphify://artifact/graph.json',
      )?.annotations?.graph_version
      const versionAfter = (freshnessAfter as { result: { resources: Array<{ uri: string; annotations?: Record<string, unknown> }> } }).result.resources.find(
        (resource) => resource.uri === 'graphify://artifact/graph.json',
      )?.annotations?.graph_version

      expect((before as { result: string }).result).toContain('Nodes: 3')
      expect((after as { result: string }).result).toContain('Node: ReplacementNode')
      expect(versionBefore).toMatch(/^[a-f0-9]{12}$/)
      expect(versionAfter).toMatch(/^[a-f0-9]{12}$/)
      expect(versionAfter).not.toBe(versionBefore)
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
