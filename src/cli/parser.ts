import { validateGraphOutputPath } from '../shared/security.js'
import { type InstallPlatform, isInstallPlatform } from '../infrastructure/install.js'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface QueryCliOptions {
  question: string
  mode: 'bfs' | 'dfs'
  tokenBudget: number
  graphPath: string
}

export interface PathCliOptions {
  source: string
  target: string
  graphPath: string
  maxHops: number
}

export interface ExplainCliOptions {
  label: string
  graphPath: string
  relation: string
}

export interface AddCliOptions {
  url: string
  path: string
  followSymlinks: boolean
  noHtml: boolean
}

export interface SaveResultCliOptions {
  question: string
  answer: string
  queryType: string
  sourceNodes: string[]
  memoryDir: string
}

export interface BenchmarkCliOptions {
  graphPath: string
}

export interface GenerateCliOptions {
  path: string
  update: boolean
  clusterOnly: boolean
  watch: boolean
  followSymlinks: boolean
  debounceSeconds: number
  noHtml: boolean
}

export interface WatchCliOptions {
  path: string
  followSymlinks: boolean
  debounceSeconds: number
  noHtml: boolean
}

export interface ServeCliOptions {
  graphPath: string
  host: string
  port: number
  transport: 'http' | 'stdio'
}

export interface HookCliOptions {
  action: 'install' | 'uninstall' | 'status'
}

export interface InstallCliOptions {
  platform: InstallPlatform
}

export interface PlatformActionCliOptions {
  action: 'install' | 'uninstall'
}

const MAX_CLI_SOURCE_NODES = 50
const MAX_CLI_LABEL_LENGTH = 512
const MAX_QUESTION_LENGTH = 2_000
const MAX_ANSWER_LENGTH = 100_000
const MAX_PATH_HOPS = 20
const MAX_TOKEN_BUDGET = 100_000
const MAX_PORT = 65_535

function requireNonEmptyValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new UsageError(`error: ${flag} requires a value`)
  }
  return value
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`error: ${flag} must be a positive integer`)
  }
  return parsed
}

function parseNonNegativeNumber(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`error: ${flag} must be a non-negative number`)
  }
  return parsed
}

function parsePort(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_PORT) {
    throw new UsageError(`error: ${flag} must be between 0 and ${MAX_PORT}`)
  }
  return parsed
}

function parseBudget(value: string): number {
  const parsed = parsePositiveInteger('--budget', value)
  if (parsed > MAX_TOKEN_BUDGET) {
    throw new UsageError(`error: --budget must be <= ${MAX_TOKEN_BUDGET}`)
  }
  return parsed
}

function validateCliText(field: string, value: string): string {
  if (value.length > MAX_CLI_LABEL_LENGTH) {
    throw new UsageError(`error: ${field} exceeds maximum length of ${MAX_CLI_LABEL_LENGTH} characters`)
  }
  return value
}

export function parseQueryArgs(args: string[]): QueryCliOptions {
  const question = args[0]?.trim()
  if (!question) {
    throw new UsageError('Usage: graphify-ts query "<question>" [--dfs] [--budget N] [--graph path]')
  }

  let mode: 'bfs' | 'dfs' = 'bfs'
  let tokenBudget = 2000
  let graphPath = 'graphify-out/graph.json'

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--dfs') {
      mode = 'dfs'
      continue
    }

    if (argument === '--budget') {
      tokenBudget = parseBudget(requireNonEmptyValue('--budget', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--budget=')) {
      const [, value] = argument.split('=', 2)
      tokenBudget = parseBudget(requireNonEmptyValue('--budget', value))
      continue
    }

    if (argument === '--graph') {
      graphPath = requireNonEmptyValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireNonEmptyValue('--graph', value)
      continue
    }

    throw new UsageError(`error: unknown option for query: ${argument}`)
  }

  return { question, mode, tokenBudget, graphPath }
}

export function parsePathArgs(args: string[]): PathCliOptions {
  const source = args[0]?.trim()
  const target = args[1]?.trim()
  if (!source || !target) {
    throw new UsageError('Usage: graphify-ts path <source> <target> [--graph path] [--max-hops N]')
  }

  let graphPath = 'graphify-out/graph.json'
  let maxHops = 8
  const normalizedSource = validateCliText('source', source)
  const normalizedTarget = validateCliText('target', target)

  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--graph') {
      graphPath = requireNonEmptyValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireNonEmptyValue('--graph', value)
      continue
    }

    if (argument === '--max-hops') {
      maxHops = parsePositiveInteger('--max-hops', requireNonEmptyValue('--max-hops', args[index + 1]))
      index += 1
    } else if (argument.startsWith('--max-hops=')) {
      const [, value] = argument.split('=', 2)
      maxHops = parsePositiveInteger('--max-hops', requireNonEmptyValue('--max-hops', value))
    } else {
      throw new UsageError(`error: unknown option for path: ${argument}`)
    }

    if (maxHops > MAX_PATH_HOPS) {
      throw new UsageError(`error: --max-hops must be <= ${MAX_PATH_HOPS}`)
    }
  }

  return { source: normalizedSource, target: normalizedTarget, graphPath, maxHops }
}

export function parseExplainArgs(args: string[]): ExplainCliOptions {
  const label = args[0]?.trim()
  if (!label) {
    throw new UsageError('Usage: graphify-ts explain <label> [--graph path] [--relation REL]')
  }

  let graphPath = 'graphify-out/graph.json'
  let relation = ''
  const normalizedLabel = validateCliText('label', label)

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--graph') {
      graphPath = requireNonEmptyValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireNonEmptyValue('--graph', value)
      continue
    }

    if (argument === '--relation') {
      relation = validateCliText('--relation', requireNonEmptyValue('--relation', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--relation=')) {
      const [, value] = argument.split('=', 2)
      relation = validateCliText('--relation', requireNonEmptyValue('--relation', value))
      continue
    }

    throw new UsageError(`error: unknown option for explain: ${argument}`)
  }

  return { label: normalizedLabel, graphPath, relation }
}

export function parseAddArgs(args: string[]): AddCliOptions {
  const url = args[0]?.trim()
  if (!url) {
    throw new UsageError('Usage: graphify-ts add <url> [path] [--follow-symlinks] [--no-html]')
  }

  let path = '.'
  let followSymlinks = false
  let noHtml = false

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError('Usage: graphify-ts add <url> [path] [--follow-symlinks] [--no-html]')
      }
      path = argument
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--no-html') {
      noHtml = true
      continue
    }

    throw new UsageError(`error: unknown option for add: ${argument}`)
  }

  return { url, path, followSymlinks, noHtml }
}

export function parseSaveResultArgs(args: string[]): SaveResultCliOptions {
  let question = ''
  let answer = ''
  let queryType = 'query'
  let memoryDir = 'graphify-out/memory'
  const sourceNodes: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--question') {
      question = requireNonEmptyValue('--question', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--answer') {
      answer = requireNonEmptyValue('--answer', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--type') {
      queryType = requireNonEmptyValue('--type', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--memory-dir') {
      memoryDir = requireNonEmptyValue('--memory-dir', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--nodes') {
      let cursor = index + 1
      while (cursor < args.length && !String(args[cursor]).startsWith('--')) {
        const value = args[cursor]?.trim()
        if (value) {
          if (sourceNodes.length >= MAX_CLI_SOURCE_NODES) {
            throw new UsageError(`error: --nodes is limited to ${MAX_CLI_SOURCE_NODES} items`)
          }
          sourceNodes.push(value)
        }
        cursor += 1
      }
      index = cursor - 1
      continue
    }

    throw new UsageError(`error: unknown option for save-result: ${argument}`)
  }

  if (question.trim().length === 0 || answer.trim().length === 0) {
    throw new UsageError('Usage: graphify-ts save-result --question Q --answer A [--type T] [--nodes N1 N2 ...] [--memory-dir DIR]')
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    throw new UsageError(`error: --question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters`)
  }
  if (answer.length > MAX_ANSWER_LENGTH) {
    throw new UsageError(`error: --answer exceeds maximum length of ${MAX_ANSWER_LENGTH} characters`)
  }

  memoryDir = validateGraphOutputPath(memoryDir)

  return { question, answer, queryType, sourceNodes, memoryDir }
}

export function parseBenchmarkArgs(args: string[]): BenchmarkCliOptions {
  if (args.length === 0) {
    return { graphPath: 'graphify-out/graph.json' }
  }

  if (args.length > 1 || args[0]?.startsWith('--')) {
    throw new UsageError('Usage: graphify-ts benchmark [graph.json]')
  }

  return { graphPath: requireNonEmptyValue('graph path', args[0]) }
}

export function parseGenerateArgs(args: string[]): GenerateCliOptions {
  let path = '.'
  let update = false
  let clusterOnly = false
  let watch = false
  let followSymlinks = false
  let debounceSeconds = 3
  let noHtml = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError('Usage: graphify-ts generate [path] [--update] [--cluster-only] [--watch] [--follow-symlinks] [--debounce S] [--no-html]')
      }
      path = argument
      continue
    }

    if (argument === '--update') {
      update = true
      continue
    }

    if (argument === '--cluster-only') {
      clusterOnly = true
      continue
    }

    if (argument === '--watch') {
      watch = true
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--no-html') {
      noHtml = true
      continue
    }

    if (argument === '--debounce') {
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--debounce=')) {
      const [, value] = argument.split('=', 2)
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', value))
      continue
    }

    throw new UsageError(`error: unknown option for generate: ${argument}`)
  }

  if (update && clusterOnly) {
    throw new UsageError('error: --update and --cluster-only cannot be used together')
  }

  return {
    path,
    update,
    clusterOnly,
    watch,
    followSymlinks,
    debounceSeconds,
    noHtml,
  }
}

export function parseWatchArgs(args: string[]): WatchCliOptions {
  let path = '.'
  let followSymlinks = false
  let debounceSeconds = 3
  let noHtml = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError('Usage: graphify-ts watch [path] [--follow-symlinks] [--debounce S] [--no-html]')
      }
      path = argument
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--no-html') {
      noHtml = true
      continue
    }

    if (argument === '--debounce') {
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--debounce=')) {
      const [, value] = argument.split('=', 2)
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', value))
      continue
    }

    throw new UsageError(`error: unknown option for watch: ${argument}`)
  }

  return { path, followSymlinks, debounceSeconds, noHtml }
}

export function parseServeArgs(args: string[]): ServeCliOptions {
  let graphPath = 'graphify-out/graph.json'
  let host = '127.0.0.1'
  let port = 4173
  let transport: 'http' | 'stdio' = 'http'

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (graphPath !== 'graphify-out/graph.json') {
        throw new UsageError('Usage: graphify-ts serve [graph.json] [--host H] [--port N] [--stdio|--mcp]')
      }
      graphPath = argument
      continue
    }

    if (argument === '--stdio' || argument === '--mcp') {
      transport = 'stdio'
      continue
    }

    if (argument === '--host') {
      host = requireNonEmptyValue('--host', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--host=')) {
      const [, value] = argument.split('=', 2)
      host = requireNonEmptyValue('--host', value)
      continue
    }

    if (argument === '--port') {
      port = parsePort('--port', requireNonEmptyValue('--port', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--port=')) {
      const [, value] = argument.split('=', 2)
      port = parsePort('--port', requireNonEmptyValue('--port', value))
      continue
    }

    throw new UsageError(`error: unknown option for serve: ${argument}`)
  }

  return { graphPath, host, port, transport }
}

export function parseHookArgs(args: string[]): HookCliOptions {
  const action = args[0]
  if (action === 'install' || action === 'uninstall' || action === 'status') {
    if (args.length > 1) {
      throw new UsageError('Usage: graphify-ts hook [install|uninstall|status]')
    }
    return { action }
  }

  throw new UsageError('Usage: graphify-ts hook [install|uninstall|status]')
}

export function parseInstallArgs(args: string[], defaultPlatform: InstallPlatform): InstallCliOptions {
  let platform = defaultPlatform

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--platform') {
      const value = requireNonEmptyValue('--platform', args[index + 1])
      if (!isInstallPlatform(value)) {
        throw new UsageError(`error: unknown platform '${value}'`)
      }
      platform = value
      index += 1
      continue
    }

    if (argument.startsWith('--platform=')) {
      const [, value] = argument.split('=', 2)
      const normalizedValue = requireNonEmptyValue('--platform', value)
      if (!isInstallPlatform(normalizedValue)) {
        throw new UsageError(`error: unknown platform '${normalizedValue}'`)
      }
      platform = normalizedValue
      continue
    }

    throw new UsageError('Usage: graphify-ts install [--platform P]')
  }

  return { platform }
}

export function parsePlatformActionArgs(command: string, args: string[]): PlatformActionCliOptions {
  const action = args[0]
  if ((action === 'install' || action === 'uninstall') && args.length === 1) {
    return { action }
  }

  throw new UsageError(`Usage: graphify-ts ${command} [install|uninstall]`)
}
