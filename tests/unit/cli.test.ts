import { resolve } from 'node:path'

import { type CliDependencies, executeCli, formatHelp } from '../../src/cli/main.js'
import {
  parseAddArgs,
  parseBenchmarkArgs,
  parseExplainArgs,
  parseGenerateArgs,
  parseHookArgs,
  parseInstallArgs,
  parsePathArgs,
  parsePlatformActionArgs,
  parseQueryArgs,
  parseSaveResultArgs,
  parseServeArgs,
  parseWatchArgs,
} from '../../src/cli/parser.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'

function createIo() {
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    io: {
      log(message?: string) {
        logs.push(String(message ?? ''))
      },
      error(message?: string) {
        errors.push(String(message ?? ''))
      },
    },
  }
}

function createDependencies(): CliDependencies {
  return {
    loadGraph: (graphPath) => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth', { label: 'AuthService', source_file: graphPath, file_type: 'code', community: 0 })
      graph.addNode('client', { label: 'HttpClient', source_file: graphPath, file_type: 'code', community: 0 })
      graph.addNode('transport', { label: 'Transport', source_file: graphPath, file_type: 'code', community: 1 })
      graph.addEdge('auth', 'client', { relation: 'calls', confidence: 'EXTRACTED' })
      graph.addEdge('client', 'transport', { relation: 'uses', confidence: 'EXTRACTED' })
      return graph
    },
    queryGraph: (_graph, question, options) => `${question} :: ${options?.mode ?? 'bfs'} :: ${options?.tokenBudget ?? 2000}`,
    saveQueryResult: (question, _answer, memoryDir) => `${memoryDir}/${question}.md`,
    ingest: async (url, targetDir) => `${resolve(targetDir)}/${url.includes('arxiv') ? 'paper.md' : 'page.md'}`,
    runBenchmark: (graphPath) => ({
      corpus_tokens: 1000,
      corpus_words: 750,
      nodes: 10,
      edges: 20,
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [{ question: graphPath ?? 'graphify-out/graph.json', query_tokens: 100, reduction: 10 }],
    }),
    printBenchmark: () => {},
    installHooks: () => 'hooks installed',
    uninstallHooks: () => 'hooks removed',
    hookStatus: () => 'post-commit: installed\npost-checkout: installed',
    geminiInstall: () => 'gemini local rules installed',
    geminiUninstall: () => 'gemini local rules removed',
    installSkill: (platform) => `installed ${platform}`,
    uninstallSkill: (platform) => `removed ${platform}`,
    cursorInstall: () => 'cursor local rules installed',
    cursorUninstall: () => 'cursor local rules removed',
    pushGraphToNeo4j: async (_graph, options) => ({
      uri: options.uri,
      database: options.database ?? 'neo4j',
      nodes: 3,
      edges: 2,
    }),
    generateGraph: (rootPath = '.', options = {}) => ({
      mode: options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate',
      rootPath: resolve(rootPath),
      outputDir: resolve(rootPath, 'graphify-out'),
      graphPath: resolve(rootPath, 'graphify-out', 'graph.json'),
      reportPath: resolve(rootPath, 'graphify-out', 'GRAPH_REPORT.md'),
      htmlPath: options.noHtml ? null : resolve(rootPath, 'graphify-out', 'graph.html'),
      wikiPath: options.wiki ? resolve(rootPath, 'graphify-out', 'wiki') : null,
      obsidianPath: options.obsidian ? resolve(options.obsidianDir ?? resolve(rootPath, 'graphify-out', 'obsidian')) : null,
      svgPath: options.svg ? resolve(rootPath, 'graphify-out', 'graph.svg') : null,
      graphmlPath: options.graphml ? resolve(rootPath, 'graphify-out', 'graph.graphml') : null,
      cypherPath: options.neo4j ? resolve(rootPath, 'graphify-out', 'cypher.txt') : null,
      totalFiles: 3,
      codeFiles: 2,
      nonCodeFiles: 1,
      totalWords: 120,
      nodeCount: 5,
      edgeCount: 4,
      communityCount: 2,
      changedFiles: options.update ? 1 : 0,
      deletedFiles: 0,
      warning: null,
      notes: ['test note'],
    }),
    watchGraph: async () => {},
    serveGraph: async () => {},
    serveGraphStdio: async () => {},
    claudeInstall: () => 'claude local rules installed',
    claudeUninstall: () => 'claude local rules removed',
    agentsInstall: (_projectDir, platform) => `${platform} local rules installed`,
    agentsUninstall: (_projectDir, platform) => `${platform} local rules removed`,
  }
}

describe('cli parser', () => {
  it('parses query args with defaults and overrides', () => {
    expect(parseQueryArgs(['how does auth work'])).toEqual({
      question: 'how does auth work',
      mode: 'bfs',
      tokenBudget: 2000,
      graphPath: 'graphify-out/graph.json',
    })

    expect(parseQueryArgs(['show flow', '--dfs', '--budget', '1500', '--graph', 'custom.json'])).toEqual({
      question: 'show flow',
      mode: 'dfs',
      tokenBudget: 1500,
      graphPath: 'custom.json',
    })
  })

  it('rejects invalid query args', () => {
    expect(() => parseQueryArgs([])).toThrow('Usage: graphify-ts query')
    expect(() => parseQueryArgs(['test', '--budget', 'abc'])).toThrow('error: --budget must be a positive integer')
    expect(() => parseQueryArgs(['test', '--budget', '100001'])).toThrow('error: --budget must be <= 100000')
    expect(() => parseQueryArgs(['test', '--wat'])).toThrow('error: unknown option for query: --wat')
  })

  it('parses path args with defaults and overrides', () => {
    expect(parsePathArgs(['AuthService', 'Transport'])).toEqual({
      source: 'AuthService',
      target: 'Transport',
      graphPath: 'graphify-out/graph.json',
      maxHops: 8,
    })

    expect(parsePathArgs(['AuthService', 'Transport', '--graph', 'custom.json', '--max-hops', '4'])).toEqual({
      source: 'AuthService',
      target: 'Transport',
      graphPath: 'custom.json',
      maxHops: 4,
    })

    expect(() => parsePathArgs(['AuthService'])).toThrow('Usage: graphify-ts path')
    expect(() => parsePathArgs(['AuthService', 'Transport', '--wat'])).toThrow('error: unknown option for path: --wat')
    expect(() => parsePathArgs(['AuthService', 'Transport', '--max-hops', '99'])).toThrow('error: --max-hops must be <= 20')
  })

  it('parses explain args', () => {
    expect(parseExplainArgs(['HttpClient'])).toEqual({
      label: 'HttpClient',
      graphPath: 'graphify-out/graph.json',
      relation: '',
    })

    expect(parseExplainArgs(['HttpClient', '--graph=custom.json', '--relation', 'calls'])).toEqual({
      label: 'HttpClient',
      graphPath: 'custom.json',
      relation: 'calls',
    })

    expect(() => parseExplainArgs([])).toThrow('Usage: graphify-ts explain')
    expect(() => parseExplainArgs(['HttpClient', '--wat'])).toThrow('error: unknown option for explain: --wat')
    expect(() => parseExplainArgs([`H${'x'.repeat(512)}`])).toThrow('error: label exceeds maximum length of 512 characters')
  })

  it('parses add args', () => {
    expect(parseAddArgs(['https://example.com/post'])).toEqual({
      url: 'https://example.com/post',
      path: '.',
      followSymlinks: false,
      noHtml: false,
    })

    expect(parseAddArgs(['https://example.com/post', 'docs', '--follow-symlinks', '--no-html'])).toEqual({
      url: 'https://example.com/post',
      path: 'docs',
      followSymlinks: true,
      noHtml: true,
    })

    expect(() => parseAddArgs([])).toThrow('Usage: graphify-ts add')
    expect(() => parseAddArgs(['https://example.com/post', 'docs', 'extra'])).toThrow('Usage: graphify-ts add')
    expect(() => parseAddArgs(['https://example.com/post', '--wat'])).toThrow('error: unknown option for add: --wat')
  })

  it('parses save-result args', () => {
    expect(parseSaveResultArgs(['--question', 'Q', '--answer', 'A', '--type', 'explain', '--nodes', 'n1', 'n2', '--memory-dir', 'graphify-out/mem'])).toEqual({
      question: 'Q',
      answer: 'A',
      queryType: 'explain',
      sourceNodes: ['n1', 'n2'],
      memoryDir: resolve('graphify-out/mem'),
    })
  })

  it('rejects invalid save-result args', () => {
    expect(() => parseSaveResultArgs(['--question', 'Q'])).toThrow('Usage: graphify-ts save-result')
    expect(() => parseSaveResultArgs(['--question', 'Q', '--answer', 'A', '--wat'])).toThrow('error: unknown option for save-result: --wat')
    expect(() => parseSaveResultArgs(['--question', 'Q', '--answer', 'A', '--memory-dir', '../tmp'])).toThrow('Only paths inside graphify-out/ are permitted')
  })

  it('parses benchmark args', () => {
    expect(parseBenchmarkArgs([])).toEqual({ graphPath: 'graphify-out/graph.json' })
    expect(parseBenchmarkArgs(['custom.json'])).toEqual({ graphPath: 'custom.json' })
    expect(() => parseBenchmarkArgs(['one.json', 'two.json'])).toThrow('Usage: graphify-ts benchmark')
  })

  it('parses generate args', () => {
    expect(parseGenerateArgs([])).toEqual({
      path: '.',
      update: false,
      clusterOnly: false,
      watch: false,
      directed: false,
      followSymlinks: false,
      debounceSeconds: 3,
      noHtml: false,
      wiki: false,
      obsidian: false,
      obsidianDir: null,
      svg: false,
      graphml: false,
      neo4j: false,
      neo4jPushUri: null,
      neo4jUser: null,
      neo4jPassword: null,
      neo4jDatabase: null,
    })

    expect(
      parseGenerateArgs([
        'src',
        '--update',
        '--watch',
        '--directed',
        '--follow-symlinks',
        '--debounce',
        '1.5',
        '--no-html',
        '--wiki',
        '--obsidian',
        '--obsidian-dir',
        'vault',
        '--svg',
        '--graphml',
        '--neo4j',
        '--neo4j-push',
        'bolt://localhost:7687',
        '--neo4j-user',
        'neo4j',
        '--neo4j-password',
        'secret',
        '--neo4j-database',
        'graphify',
      ]),
    ).toEqual({
      path: 'src',
      update: true,
      clusterOnly: false,
      watch: true,
      directed: true,
      followSymlinks: true,
      debounceSeconds: 1.5,
      noHtml: true,
      wiki: true,
      obsidian: true,
      obsidianDir: 'vault',
      svg: true,
      graphml: true,
      neo4j: true,
      neo4jPushUri: 'bolt://localhost:7687',
      neo4jUser: 'neo4j',
      neo4jPassword: 'secret',
      neo4jDatabase: 'graphify',
    })

    expect(() => parseGenerateArgs(['src', 'other'])).toThrow('Usage: graphify-ts generate')
    expect(() => parseGenerateArgs(['--update', '--cluster-only'])).toThrow('cannot be used together')
  })

  it('parses watch args', () => {
    expect(parseWatchArgs(['src', '--follow-symlinks', '--debounce=2', '--no-html'])).toEqual({
      path: 'src',
      followSymlinks: true,
      debounceSeconds: 2,
      noHtml: true,
    })

    expect(() => parseWatchArgs(['src', 'other'])).toThrow('Usage: graphify-ts watch')
  })

  it('parses serve args', () => {
    expect(parseServeArgs([])).toEqual({
      graphPath: 'graphify-out/graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'http',
    })

    expect(parseServeArgs(['custom.json', '--host', '0.0.0.0', '--port', '8080'])).toEqual({
      graphPath: 'custom.json',
      host: '0.0.0.0',
      port: 8080,
      transport: 'http',
    })

    expect(parseServeArgs(['graph.json', '--mcp'])).toEqual({
      graphPath: 'graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'stdio',
    })

    expect(parseServeArgs(['graph.json', '--transport', 'stdio'])).toEqual({
      graphPath: 'graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'stdio',
    })

    expect(parseServeArgs(['graph.json', '--http'])).toEqual({
      graphPath: 'graph.json',
      host: '127.0.0.1',
      port: 4173,
      transport: 'http',
    })

    expect(() => parseServeArgs(['--port', '70000'])).toThrow('must be between 0 and 65535')
    expect(() => parseServeArgs(['--transport', 'socket'])).toThrow('error: --transport must be one of http, stdio')
  })

  it('parses hook args', () => {
    expect(parseHookArgs(['install'])).toEqual({ action: 'install' })
    expect(parseHookArgs(['uninstall'])).toEqual({ action: 'uninstall' })
    expect(parseHookArgs(['status'])).toEqual({ action: 'status' })
    expect(() => parseHookArgs([])).toThrow('Usage: graphify-ts hook')
  })

  it('parses install args and platform actions', () => {
    expect(parseInstallArgs([], 'claude')).toEqual({ platform: 'claude' })
    expect(parseInstallArgs(['--platform', 'aider'], 'claude')).toEqual({ platform: 'aider' })
    expect(parseInstallArgs(['--platform', 'gemini'], 'claude')).toEqual({ platform: 'gemini' })
    expect(parseInstallArgs(['--platform', 'codex'], 'claude')).toEqual({ platform: 'codex' })
    expect(parseInstallArgs(['--platform=copilot'], 'claude')).toEqual({ platform: 'copilot' })
    expect(parseInstallArgs(['--platform=cursor'], 'claude')).toEqual({ platform: 'cursor' })
    expect(parseInstallArgs(['--platform=windows'], 'claude')).toEqual({ platform: 'windows' })
    expect(() => parseInstallArgs(['--platform', 'unknown'], 'claude')).toThrow("error: unknown platform 'unknown'")

    expect(parsePlatformActionArgs('claude', ['install'])).toEqual({ action: 'install' })
    expect(parsePlatformActionArgs('aider', ['install'])).toEqual({ action: 'install' })
    expect(parsePlatformActionArgs('gemini', ['install'])).toEqual({ action: 'install' })
    expect(parsePlatformActionArgs('copilot', ['uninstall'])).toEqual({ action: 'uninstall' })
    expect(parsePlatformActionArgs('cursor', ['uninstall'])).toEqual({ action: 'uninstall' })
    expect(parsePlatformActionArgs('codex', ['uninstall'])).toEqual({ action: 'uninstall' })
    expect(() => parsePlatformActionArgs('trae', [])).toThrow('Usage: graphify-ts trae [install|uninstall]')
  })
})

describe('cli main', () => {
  it('prints help for empty args', async () => {
    const { io, logs, errors } = createIo()

    const exitCode = await executeCli([], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(errors).toHaveLength(0)
    expect(logs[0]).toContain('Usage: graphify-ts <command>')
  })

  it('formats help text with supported commands', () => {
    const help = formatHelp()
    expect(help).toContain('--help')
    expect(help).toContain('generate [path]')
    expect(help).toContain('watch [path]')
    expect(help).toContain('serve [graph.json]')
    expect(help).toContain('--directed')
    expect(help).toContain('--wiki')
    expect(help).toContain('--obsidian')
    expect(help).toContain('--svg')
    expect(help).toContain('--graphml')
    expect(help).toContain('--neo4j')
    expect(help).toContain('--neo4j-push')
    expect(help).toContain('--transport')
    expect(help).toContain('--http')
    expect(help).toContain('--stdio')
    expect(help).toContain('--mcp')
    expect(help).toContain('query "<question>"')
    expect(help).toContain('path <source> <target>')
    expect(help).toContain('explain <label>')
    expect(help).toContain('add <url> [path]')
    expect(help).toContain('save-result')
    expect(help).toContain('benchmark [graph.json]')
    expect(help).toContain('hook [action]')
    expect(help).toContain('install [--platform P]')
    expect(help).toContain('aider [install|uninstall]')
    expect(help).toContain('claude [install|uninstall]')
    expect(help).toContain('cursor [install|uninstall]')
    expect(help).toContain('gemini [install|uninstall]')
    expect(help).toContain('copilot [install|uninstall]')
    expect(help).toContain('codex [install|uninstall]')
  })

  it('executes query commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['query', 'show auth flow', '--dfs', '--budget', '1500'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs).toEqual(['show auth flow :: dfs :: 1500'])
  })

  it('executes path and explain commands against the loaded graph', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()

    const pathExitCode = await executeCli(['path', 'AuthService', 'Transport', '--max-hops', '3'], io, dependencies)
    const explainExitCode = await executeCli(['explain', 'HttpClient', '--relation', 'uses'], io, dependencies)

    expect(pathExitCode).toBe(0)
    expect(explainExitCode).toBe(0)
    expect(logs[0]).toContain('Shortest path (2 hops)')
    expect(logs[0]).toContain('AuthService')
    expect(logs[1]).toContain('Node: HttpClient')
    expect(logs[1]).toContain('Neighbors of HttpClient')
    expect(logs[1]).toContain('Transport')
  })

  it('executes add commands by ingesting into raw and rebuilding incrementally', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()

    const exitCode = await executeCli(['add', 'https://example.com/post', 'workspace', '--no-html'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(logs[0]).toContain('[graphify add] Saved')
    expect(logs[0]).toContain(resolve('workspace', 'raw'))
    expect(logs[1]).toContain('[graphify generate] update completed')
  })

  it('executes generate commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['generate', 'src', '--update'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs[0]).toContain('[graphify generate] update completed')
    expect(logs[0]).toContain('graph.json')
  })

  it('passes optional export flags through generate commands', async () => {
    const { io } = createIo()
    let capturedOptions: Record<string, unknown> | undefined
    const dependencies = createDependencies()
    dependencies.generateGraph = (rootPath = '.', options = {}) => {
      capturedOptions = { rootPath, ...options }
      return {
        mode: options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate',
        rootPath: resolve(rootPath),
        outputDir: resolve(rootPath, 'graphify-out'),
        graphPath: resolve(rootPath, 'graphify-out', 'graph.json'),
        reportPath: resolve(rootPath, 'graphify-out', 'GRAPH_REPORT.md'),
        htmlPath: options.noHtml ? null : resolve(rootPath, 'graphify-out', 'graph.html'),
        wikiPath: options.wiki ? resolve(rootPath, 'graphify-out', 'wiki') : null,
        obsidianPath: options.obsidian ? resolve(options.obsidianDir ?? resolve(rootPath, 'graphify-out', 'obsidian')) : null,
        svgPath: options.svg ? resolve(rootPath, 'graphify-out', 'graph.svg') : null,
        graphmlPath: options.graphml ? resolve(rootPath, 'graphify-out', 'graph.graphml') : null,
        cypherPath: options.neo4j ? resolve(rootPath, 'graphify-out', 'cypher.txt') : null,
        totalFiles: 3,
        codeFiles: 2,
        nonCodeFiles: 1,
        totalWords: 120,
        nodeCount: 5,
        edgeCount: 4,
        communityCount: 2,
        changedFiles: 0,
        deletedFiles: 0,
        warning: null,
        notes: [],
      }
    }

    const exitCode = await executeCli(
      ['generate', 'src', '--directed', '--wiki', '--obsidian', '--obsidian-dir', 'vault', '--svg', '--graphml', '--neo4j'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(capturedOptions).toEqual({
      rootPath: 'src',
      update: false,
      clusterOnly: false,
      directed: true,
      followSymlinks: false,
      noHtml: false,
      wiki: true,
      obsidian: true,
      obsidianDir: 'vault',
      svg: true,
      graphml: true,
      neo4j: true,
    })
  })

  it('pushes the generated graph to neo4j when requested', async () => {
    const { io, logs } = createIo()
    const dependencies = createDependencies()
    let capturedOptions: Parameters<CliDependencies['pushGraphToNeo4j']>[1] | undefined

    dependencies.pushGraphToNeo4j = async (_graph, options) => {
      capturedOptions = options
      return {
        uri: options.uri,
        database: options.database ?? 'neo4j',
        nodes: 4,
        edges: 3,
      }
    }

    const exitCode = await executeCli(
      ['generate', 'src', '--neo4j-push', 'bolt://localhost:7687', '--neo4j-user', 'neo4j', '--neo4j-password', 'secret', '--neo4j-database', 'graphify'],
      io,
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(capturedOptions).toMatchObject({
      uri: 'bolt://localhost:7687',
      user: 'neo4j',
      password: 'secret',
      database: 'graphify',
      projectRoot: resolve('src'),
    })
    expect(logs.some((line) => line.includes('[graphify neo4j] Pushed 4 nodes and 3 edges'))).toBe(true)
  })

  it('treats path-first invocations as generate commands', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['src', '--cluster-only'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs[0]).toContain('[graphify generate] cluster-only completed')
  })

  it('executes save-result commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const exitCode = await executeCli(['save-result', '--question', 'Q', '--answer', 'A', '--memory-dir', 'graphify-out/mem'], io, createDependencies())

    expect(exitCode).toBe(0)
    expect(logs[0]).toBe(`Saved to ${resolve('graphify-out/mem')}/Q.md`)
  })

  it('executes benchmark commands via injected dependencies', async () => {
    const { io } = createIo()
    let printed = false
    const dependencies = createDependencies()
    dependencies.printBenchmark = () => {
      printed = true
    }

    const exitCode = await executeCli(['benchmark', 'graph.json'], io, dependencies)

    expect(exitCode).toBe(0)
    expect(printed).toBe(true)
  })

  it('executes hook commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const installExitCode = await executeCli(['hook', 'install'], io, createDependencies())
    const statusExitCode = await executeCli(['hook', 'status'], io, createDependencies())

    expect(installExitCode).toBe(0)
    expect(statusExitCode).toBe(0)
    expect(logs).toContain('hooks installed')
    expect(logs).toContain('post-commit: installed\npost-checkout: installed')
  })

  it('executes install and platform action commands via injected dependencies', async () => {
    const { io, logs } = createIo()

    const aiderInstallExitCode = await executeCli(['aider', 'install'], io, createDependencies())
    const installGeminiExitCode = await executeCli(['install', '--platform', 'gemini'], io, createDependencies())
    const installExitCode = await executeCli(['install', '--platform', 'codex'], io, createDependencies())
    const claudeExitCode = await executeCli(['claude', 'install'], io, createDependencies())
    const geminiInstallExitCode = await executeCli(['gemini', 'install'], io, createDependencies())
    const geminiUninstallExitCode = await executeCli(['gemini', 'uninstall'], io, createDependencies())
    const installCursorExitCode = await executeCli(['install', '--platform', 'cursor'], io, createDependencies())
    const cursorInstallExitCode = await executeCli(['cursor', 'install'], io, createDependencies())
    const cursorUninstallExitCode = await executeCli(['cursor', 'uninstall'], io, createDependencies())
    const copilotInstallExitCode = await executeCli(['copilot', 'install'], io, createDependencies())
    const copilotUninstallExitCode = await executeCli(['copilot', 'uninstall'], io, createDependencies())
    const codexExitCode = await executeCli(['codex', 'uninstall'], io, createDependencies())

    expect(aiderInstallExitCode).toBe(0)
    expect(installGeminiExitCode).toBe(0)
    expect(installExitCode).toBe(0)
    expect(claudeExitCode).toBe(0)
    expect(geminiInstallExitCode).toBe(0)
    expect(geminiUninstallExitCode).toBe(0)
    expect(installCursorExitCode).toBe(0)
    expect(cursorInstallExitCode).toBe(0)
    expect(cursorUninstallExitCode).toBe(0)
    expect(copilotInstallExitCode).toBe(0)
    expect(copilotUninstallExitCode).toBe(0)
    expect(codexExitCode).toBe(0)
    expect(logs).toContain('aider local rules installed')
    expect(logs).toContain('gemini local rules installed')
    expect(logs).toContain('installed codex')
    expect(logs).toContain('claude local rules installed')
    expect(logs).toContain('cursor local rules installed')
    expect(logs).toContain('cursor local rules removed')
    expect(logs).toContain('gemini local rules removed')
    expect(logs).toContain('installed copilot')
    expect(logs).toContain('removed copilot')
    expect(logs).toContain('codex local rules removed')
  })

  it('executes watch and serve commands via injected dependencies', async () => {
    const { io, logs } = createIo()
    let watched = false
    let served = false
    let servedOverStdio = false
    let lastWatchOptions: Record<string, unknown> | undefined
    const dependencies = createDependencies()
    dependencies.watchGraph = async (_path, _debounce, options) => {
      watched = true
      lastWatchOptions = options as Record<string, unknown>
    }
    dependencies.serveGraph = async () => {
      served = true
    }
    dependencies.serveGraphStdio = async () => {
      servedOverStdio = true
    }

    const watchExitCode = await executeCli(['watch', 'src', '--debounce', '1', '--no-html'], io, dependencies)
    const serveExitCode = await executeCli(['serve', 'graphify-out/graph.json', '--port', '0'], io, dependencies)
    const stdioExitCode = await executeCli(['serve', 'graphify-out/graph.json', '--mcp'], io, dependencies)

    expect(watchExitCode).toBe(0)
    expect(serveExitCode).toBe(0)
    expect(stdioExitCode).toBe(0)
    expect(watched).toBe(true)
    expect(served).toBe(true)
    expect(servedOverStdio).toBe(true)
    expect(lastWatchOptions?.noHtml).toBe(true)
    expect(logs[0]).toContain('[graphify generate]')
  })

  it('returns usage exit codes for invalid usage', async () => {
    const { io, errors } = createIo()

    const exitCode = await executeCli(['query'], io, createDependencies())

    expect(exitCode).toBe(2)
    expect(errors[0]).toContain('Usage: graphify-ts query')
  })

  it('returns command errors for unknown commands', async () => {
    const { io, errors } = createIo()

    const exitCode = await executeCli(['mystery'], io, createDependencies())

    expect(exitCode).toBe(1)
    expect(errors[0]).toContain("error: unknown command 'mystery'")
  })
})
