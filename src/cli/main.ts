import { existsSync } from 'node:fs'

import { type BenchmarkResult, printBenchmark, runBenchmark } from '../infrastructure/benchmark.js'
import { generateGraph, type GenerateGraphResult } from '../infrastructure/generate.js'
import { install as installHooks, status as hookStatus, uninstall as uninstallHooks } from '../infrastructure/hooks.js'
import { ingest, saveQueryResult } from '../infrastructure/ingest.js'
import {
  agentsInstall,
  agentsUninstall,
  claudeInstall,
  claudeUninstall,
  defaultInstallPlatform,
  installSkill,
  isAgentPlatform,
  type AgentPlatform,
} from '../infrastructure/install.js'
import { watch as watchGraph } from '../infrastructure/watch.js'
import { serveGraph } from '../runtime/http-server.js'
import { serveGraphStdio } from '../runtime/stdio-server.js'
import { getNeighbors, getNode, loadGraph, queryGraph, shortestPath } from '../runtime/serve.js'
import {
  parseBenchmarkArgs,
  parseAddArgs,
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
  UsageError,
} from './parser.js'

export interface CliIO {
  log(message?: string): void
  error(message?: string): void
}

export interface CliDependencies {
  loadGraph: typeof loadGraph
  queryGraph: typeof queryGraph
  saveQueryResult: typeof saveQueryResult
  ingest: typeof ingest
  runBenchmark: typeof runBenchmark
  printBenchmark: (result: BenchmarkResult) => void
  installHooks: typeof installHooks
  uninstallHooks: typeof uninstallHooks
  hookStatus: typeof hookStatus
  installSkill: typeof installSkill
  generateGraph: typeof generateGraph
  watchGraph: typeof watchGraph
  serveGraph: typeof serveGraph
  serveGraphStdio: typeof serveGraphStdio
  claudeInstall: typeof claudeInstall
  claudeUninstall: typeof claudeUninstall
  agentsInstall: typeof agentsInstall
  agentsUninstall: typeof agentsUninstall
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  loadGraph,
  queryGraph,
  saveQueryResult,
  ingest,
  runBenchmark,
  printBenchmark,
  installHooks,
  uninstallHooks,
  hookStatus,
  installSkill,
  generateGraph,
  watchGraph,
  serveGraph,
  serveGraphStdio,
  claudeInstall,
  claudeUninstall,
  agentsInstall,
  agentsUninstall,
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatHelp(binaryName = 'graphify-ts'): string {
  return [
    `Usage: ${binaryName} <command>`,
    '',
    'Run with --help or -h to see this message.',
    '',
    'Commands:',
    '  generate [path]       build graph artifacts for a folder (default .)',
    '    --update             show incremental change status before rebuilding',
    '    --cluster-only       re-cluster an existing graph.json without re-extraction',
    '    --watch              keep watching after the initial build',
    '    --follow-symlinks    include in-root symlink targets',
    '    --debounce S         watch debounce seconds (default 3)',
    '    --no-html            skip graph.html generation',
    '  watch [path]          build once, then watch for code/doc changes',
    '    --follow-symlinks    include in-root symlink targets',
    '    --debounce S         watch debounce seconds (default 3)',
    '    --no-html            skip graph.html generation during the initial build',
    '  serve [graph.json]    serve graph artifacts over HTTP or stdio',
    '    --host H             host interface (default 127.0.0.1)',
    '    --port N             port (default 4173; use 0 for a random port)',
    '    --stdio              serve graph query methods over stdio (JSON lines)',
    '    --mcp                alias for --stdio for installer/runtime parity',
    '  query "<question>"     traverse graph.json for a question',
    '    --dfs                 use depth-first instead of breadth-first',
    '    --budget N            cap output at N tokens (default 2000)',
    '    --graph <path>        path to graph.json (default graphify-out/graph.json)',
    '  path <source> <target> find the shortest path between two concepts',
    '    --graph <path>        path to graph.json (default graphify-out/graph.json)',
    '    --max-hops N          maximum allowed hops before reporting overflow (default 8)',
    '  explain <label>        explain one node and its neighborhood from graph evidence',
    '    --graph <path>        path to graph.json (default graphify-out/graph.json)',
    '    --relation REL        optional relation filter for neighbors',
    '  add <url> [path]       ingest a URL into raw/ and rebuild with --update',
    '    --follow-symlinks    include in-root symlink targets during rebuild',
    '    --no-html            skip graph.html generation during rebuild',
    '  save-result            save a Q&A result to graphify-out/memory/',
    '    --question Q          the question asked',
    '    --answer A            the answer to save',
    '    --type T              query type: query|path_query|explain (default query)',
    '    --nodes N1 N2 ...     source node labels cited in the answer',
    '    --memory-dir DIR      memory directory (default graphify-out/memory)',
    '  benchmark [graph.json] measure token reduction vs naive full-corpus approach',
    '  install [--platform P] copy skill to platform config dir',
    '    platforms            claude|windows|codex|opencode|claw|droid|trae|trae-cn',
    '  hook [action]          manage git hooks for graphify rebuild reminders',
    '    install              install post-commit and post-checkout hooks',
    '    uninstall            remove graphify hook sections',
    '    status               show whether graphify hooks are installed',
    '  claude [install|uninstall]  manage local CLAUDE.md graphify rules',
    '  codex [install|uninstall]   manage local AGENTS.md + Codex hook rules',
    '  opencode [install|uninstall] manage local AGENTS.md + OpenCode plugin rules',
    '  claw [install|uninstall]    manage local AGENTS.md rules',
    '  droid [install|uninstall]   manage local AGENTS.md rules',
    '  trae [install|uninstall]    manage local AGENTS.md rules',
    '  trae-cn [install|uninstall] manage local AGENTS.md rules',
    '',
    `Tip: '${binaryName} . --update' is treated like '${binaryName} generate . --update'.`,
    '',
  ].join('\n')
}

function isGenerateLikeArgument(argument: string): boolean {
  return (
    argument === '--update' ||
    argument === '--cluster-only' ||
    argument === '--watch' ||
    argument === '--follow-symlinks' ||
    argument === '--no-html' ||
    argument === '--debounce' ||
    argument.startsWith('--debounce=')
  )
}

function isImplicitGenerateCommand(argument: string): boolean {
  if (isGenerateLikeArgument(argument)) {
    return true
  }

  if (argument.startsWith('--')) {
    return false
  }

  return existsSync(argument)
}

function formatGenerateSummary(result: GenerateGraphResult): string {
  const lines = [
    `[graphify generate] ${result.mode} completed for ${result.rootPath}`,
    `- Corpus: ${result.totalFiles} file(s) · ~${result.totalWords.toLocaleString()} words`,
    `- Extracted: ${result.codeFiles} code file(s)` + (result.nonCodeFiles > 0 ? ` (+${result.nonCodeFiles} non-code detected)` : ''),
    `- Graph: ${result.nodeCount} nodes · ${result.edgeCount} edges · ${result.communityCount} communities`,
    `- Outputs: ${result.graphPath}, ${result.reportPath}`,
  ]

  if (result.htmlPath) {
    lines.push(`- HTML: ${result.htmlPath}`)
  }

  if (result.changedFiles > 0 || result.deletedFiles > 0) {
    lines.push(`- Incremental: ${result.changedFiles} changed · ${result.deletedFiles} deleted`)
  }

  if (result.warning) {
    lines.push(`- Warning: ${result.warning}`)
  }

  for (const note of result.notes) {
    lines.push(`- Note: ${note}`)
  }

  return lines.join('\n')
}

function formatExplainSummary(graph: ReturnType<typeof loadGraph>, label: string, relation = ''): string {
  const nodeDetails = getNode(graph, label)
  if (nodeDetails.startsWith('No node matching')) {
    return nodeDetails
  }

  return `${nodeDetails}\n\n${getNeighbors(graph, label, relation)}`
}

function handleAgentCommand(command: AgentPlatform, args: string[], io: CliIO, dependencies: CliDependencies): number {
  const options = parsePlatformActionArgs(command, args)
  if (options.action === 'install') {
    io.log(dependencies.agentsInstall('.', command))
    return 0
  }

  io.log(dependencies.agentsUninstall('.', command))
  return 0
}

export async function executeCli(argv: string[], io: CliIO = console, dependencies: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
  const [command, ...args] = argv

  if (!command || command === '-h' || command === '--help') {
    io.log(formatHelp())
    return 0
  }

  try {
    if (command === 'generate' || (command !== undefined && !isAgentPlatform(command) && isImplicitGenerateCommand(command))) {
      const generateArgs = command === 'generate' ? args : [command, ...args]
      const options = parseGenerateArgs(generateArgs)
      const result = dependencies.generateGraph(options.path, {
        update: options.update,
        clusterOnly: options.clusterOnly,
        followSymlinks: options.followSymlinks,
        noHtml: options.noHtml,
      })
      io.log(formatGenerateSummary(result))

      if (options.watch) {
        await dependencies.watchGraph(options.path, options.debounceSeconds, {
          followSymlinks: options.followSymlinks,
          noHtml: options.noHtml,
          logger: io,
        })
      }
      return 0
    }

    if (command === 'watch') {
      const options = parseWatchArgs(args)
      const result = dependencies.generateGraph(options.path, {
        followSymlinks: options.followSymlinks,
        noHtml: options.noHtml,
      })
      io.log(formatGenerateSummary(result))
      await dependencies.watchGraph(options.path, options.debounceSeconds, {
        followSymlinks: options.followSymlinks,
        noHtml: options.noHtml,
        logger: io,
      })
      return 0
    }

    if (command === 'serve') {
      const options = parseServeArgs(args)
      if (options.transport === 'stdio') {
        await dependencies.serveGraphStdio({
          graphPath: options.graphPath,
          logger: io,
        })
        return 0
      }

      await dependencies.serveGraph({
        graphPath: options.graphPath,
        host: options.host,
        port: options.port,
        logger: io,
      })
      return 0
    }

    if (command === 'query') {
      const options = parseQueryArgs(args)
      const graph = dependencies.loadGraph(options.graphPath)
      io.log(dependencies.queryGraph(graph, options.question, { mode: options.mode, tokenBudget: options.tokenBudget }))
      return 0
    }

    if (command === 'path') {
      const options = parsePathArgs(args)
      const graph = dependencies.loadGraph(options.graphPath)
      io.log(shortestPath(graph, options.source, options.target, options.maxHops))
      return 0
    }

    if (command === 'explain') {
      const options = parseExplainArgs(args)
      const graph = dependencies.loadGraph(options.graphPath)
      io.log(formatExplainSummary(graph, options.label, options.relation))
      return 0
    }

    if (command === 'add') {
      const options = parseAddArgs(args)
      const assetPath = await dependencies.ingest(options.url, `${options.path}/raw`)
      const result = dependencies.generateGraph(options.path, {
        update: true,
        followSymlinks: options.followSymlinks,
        noHtml: options.noHtml,
      })
      io.log(`[graphify add] Saved ${assetPath}`)
      io.log(formatGenerateSummary(result))
      return 0
    }

    if (command === 'save-result') {
      const options = parseSaveResultArgs(args)
      const outputPath = dependencies.saveQueryResult(options.question, options.answer, options.memoryDir, {
        queryType: options.queryType,
        sourceNodes: options.sourceNodes,
      })
      io.log(`Saved to ${outputPath}`)
      return 0
    }

    if (command === 'benchmark') {
      const options = parseBenchmarkArgs(args)
      const result = dependencies.runBenchmark(options.graphPath)
      dependencies.printBenchmark(result)
      return 0
    }

    if (command === 'install') {
      const options = parseInstallArgs(args, defaultInstallPlatform())
      io.log(dependencies.installSkill(options.platform))
      return 0
    }

    if (command === 'hook') {
      const options = parseHookArgs(args)
      if (options.action === 'install') {
        io.log(dependencies.installHooks('.'))
        return 0
      }
      if (options.action === 'uninstall') {
        io.log(dependencies.uninstallHooks('.'))
        return 0
      }
      io.log(dependencies.hookStatus('.'))
      return 0
    }

    if (command === 'claude') {
      const options = parsePlatformActionArgs(command, args)
      io.log(options.action === 'install' ? dependencies.claudeInstall('.') : dependencies.claudeUninstall('.'))
      return 0
    }

    if (isAgentPlatform(command)) {
      return handleAgentCommand(command, args, io, dependencies)
    }

    io.error(`error: unknown command '${command}'`)
    io.error(`Run 'graphify-ts --help' for usage.`)
    return 1
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(error.message)
      return 2
    }

    io.error(`error: ${messageFromError(error)}`)
    return 1
  }
}
