import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import { CODE_EXTENSIONS, DOC_EXTENSIONS, MANIFEST_METADATA_KEY, OFFICE_EXTENSIONS, PAPER_EXTENSIONS } from '../pipeline/detect.js'
import { extractCompareBaselineNonCodeText } from '../pipeline/extract/non-code.js'
import { loadBenchmarkQuestions } from './benchmark/questions.js'
import { retrieveContext, type RetrieveResult } from '../runtime/retrieve.js'
import { QUERY_CHARS_PER_TOKEN, estimateQueryTokens, loadGraph } from '../runtime/serve.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { MAX_TEXT_BYTES, validateGraphOutputPath, validateGraphPath } from '../shared/security.js'

export type CompareBaselineMode = 'full' | 'bounded'

export interface ComparePromptPack {
  kind: 'baseline' | 'graphify'
  question: string
  prompt: string
  token_count: number
}

export interface BuildBaselinePromptPackInput {
  question: string
  graph: KnowledgeGraph
  corpusText: string
  mode: CompareBaselineMode
  maxTokens?: number
}

export interface BuildGraphifyPromptPackInput {
  question: string
  retrieval: RetrieveResult
}

export interface ComparePromptArtifactPaths {
  output_dir: string
  baseline_prompt: string
  graphify_prompt: string
  report: string
}

export interface ComparePromptReport {
  question: string
  graph_path: string
  exec_command: string
  baseline_mode: CompareBaselineMode
  baseline_prompt_tokens: number
  graphify_prompt_tokens: number
  reduction_ratio: number
  started_at: string
  completed_at: string
  elapsed_ms: {
    baseline: number
    graphify: number
  }
  status: {
    baseline: 'not_run'
    graphify: 'not_run'
  }
  paths: ComparePromptArtifactPaths
}

export interface GenerateCompareArtifactsInput {
  graphPath: string
  question?: string | null
  questionsPath?: string | null
  outputDir: string
  execTemplate: string
  baselineMode: CompareBaselineMode
  corpusText?: string
  limit?: number | null
  retrievalBudget?: number
  baselineMaxTokens?: number
  now?: Date
}

export interface GenerateCompareArtifactsResult {
  graph_path: string
  output_root: string
  reports: ComparePromptReport[]
}

const DEFAULT_RETRIEVAL_BUDGET = 3_000
const DEFAULT_BOUNDED_BASELINE_TOKENS = 4_000
function timestampDirectoryName(date: Date): string {
  const iso = date.toISOString()
  return iso.slice(0, 19).replace(/:/g, '-')
}

function renderBaselinePrompt(question: string, graph: KnowledgeGraph, corpusBody: string, mode: CompareBaselineMode): string {
  return [
    'Answer the question using only the provided project corpus.',
    'If the corpus does not contain the answer, say so.',
    '',
    `Question:\n${question}`,
    '',
    'Project graph summary:',
    `- Nodes: ${graph.numberOfNodes()}`,
    `- Edges: ${graph.numberOfEdges()}`,
    '',
    `Corpus (${mode}):`,
    corpusBody,
    '',
    'Answer:',
  ].join('\n')
}

function buildBoundedCorpusExcerpt(question: string, graph: KnowledgeGraph, corpusText: string, maxTokens: number): string {
  const note = '[bounded baseline excerpt]'
  let excerpt = corpusText.trim()
  let prompt = renderBaselinePrompt(question, graph, `${note}\n${excerpt}`, 'bounded')
  while (estimateQueryTokens(prompt) > maxTokens && excerpt.length > 0) {
    const overshoot = estimateQueryTokens(prompt) - maxTokens
    excerpt = excerpt.slice(0, Math.max(0, excerpt.length - Math.max(1, overshoot * QUERY_CHARS_PER_TOKEN))).trimEnd()
    prompt = renderBaselinePrompt(question, graph, `${note}\n${excerpt}`, 'bounded')
  }

  if (estimateQueryTokens(prompt) > maxTokens) {
    throw new Error(`Bounded baseline token budget ${maxTokens} is too small for the compare prompt floor.`)
  }

  return `${note}\n${excerpt}`.trimEnd()
}

function formatGraphifyContext(retrieval: RetrieveResult): string {
  const nodeLines = retrieval.matched_nodes.map((node) => {
    const source = node.source_file ? ` @ ${node.source_file}${node.line_number > 0 ? `:${node.line_number}` : ''}` : ''
    const community = node.community_label ? ` [${node.community_label}]` : ''
    const snippet = node.snippet ? `\n  ${node.snippet}` : ''
    return `- ${node.label}${source}${community}${snippet}`
  })
  const relationshipLines = retrieval.relationships.map((relationship) => `- ${relationship.from} -[${relationship.relation}]-> ${relationship.to}`)
  const communityLines = retrieval.community_context.map((community) => `- ${community.label} (${community.node_count} nodes)`)
  const signalLines = [...retrieval.graph_signals.god_nodes, ...retrieval.graph_signals.bridge_nodes]

  const sections = [
    ['Matched nodes:', ...(nodeLines.length > 0 ? nodeLines : ['- (none)'])],
    ['Relationships:', ...(relationshipLines.length > 0 ? relationshipLines : ['- (none)'])],
    ...(communityLines.length > 0 ? [['Community context:', ...communityLines]] : []),
    ...(signalLines.length > 0 ? [['Graph signals:', `- ${signalLines.join(', ')}`]] : []),
  ]

  return sections.map((section) => section.join('\n')).join('\n\n')
}

function computeReductionRatio(baselinePromptTokens: number, graphifyPromptTokens: number): number {
  if (baselinePromptTokens <= 0 || graphifyPromptTokens <= 0) {
    return 0
  }
  return Number((baselinePromptTokens / graphifyPromptTokens).toFixed(1))
}

function portablePath(path: string): string {
  return relative(process.cwd(), path) || '.'
}

function inferProjectRootFromGraphPath(graphPath: string): string {
  let currentPath = dirname(resolve(graphPath))

  while (dirname(currentPath) !== currentPath) {
    if (basename(currentPath) === 'graphify-out') {
      return dirname(currentPath)
    }
    currentPath = dirname(currentPath)
  }

  return dirname(resolve(graphPath))
}

function loadGraphBackedManifestFingerprints(graphPath: string): Map<string, number> {
  const manifestPath = join(dirname(resolve(graphPath)), 'manifest.json')
  if (!existsSync(manifestPath)) {
    return new Map()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch {
    throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
  }

  const manifestEntries = Object.entries(parsed as Record<string, unknown>).filter(([key]) => key !== MANIFEST_METADATA_KEY)
  for (const [, fingerprint] of manifestEntries) {
    if (typeof fingerprint !== 'number' || !Number.isFinite(fingerprint)) {
      throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
    }
  }

  return new Map(manifestEntries.map(([filePath, fingerprint]) => [resolve(filePath), fingerprint as number]))
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, targetPath)
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function isReadableCorpusPath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return (
    CODE_EXTENSIONS.has(extension) ||
    DOC_EXTENSIONS.has(extension) ||
    PAPER_EXTENSIONS.has(extension) ||
    OFFICE_EXTENSIONS.has(extension)
  )
}

function collectGraphBackedCorpusFiles(graph: KnowledgeGraph, projectRoot: string): string[] {
  return graph.nodeEntries()
    .map(([, attributes]) => String(attributes.source_file ?? '').trim())
    .filter((sourceFile) => sourceFile.length > 0)
    .map((sourceFile) => resolve(projectRoot, sourceFile))
}

function readBaselineCorpusFile(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase()

  if (CODE_EXTENSIONS.has(extension) || DOC_EXTENSIONS.has(extension)) {
    if (statSync(filePath).size > MAX_TEXT_BYTES) {
      return null
    }
    return readFileSync(filePath, 'utf8').trimEnd()
  }

  const nonCodeText = extractCompareBaselineNonCodeText(filePath)
  if (nonCodeText !== null) {
    return nonCodeText
  }

  return null
}

function deriveBaselineCorpusText(graphPath: string, graph: KnowledgeGraph): string {
  const projectRoot = inferProjectRootFromGraphPath(graphPath)
  const realProjectRoot = realpathSync(projectRoot)
  const candidateFiles = collectGraphBackedCorpusFiles(graph, projectRoot)
  const manifestFingerprints = loadGraphBackedManifestFingerprints(graphPath)
  const files = new Map<string, string>()

  for (const candidatePath of candidateFiles) {
    const expectsTextContent = isReadableCorpusPath(candidatePath)
    const expectedFingerprint = manifestFingerprints.get(resolve(candidatePath))
    let absolutePath: string
    try {
      absolutePath = realpathSync(candidatePath)
    } catch {
      if (expectsTextContent) {
        throw new Error(`Compare baseline could not read graph-backed file: ${candidatePath}`)
      }
      continue
    }

    if (!isPathWithinRoot(absolutePath, realProjectRoot)) {
      continue
    }

    if (!isReadableCorpusPath(absolutePath)) {
      continue
    }

    if (expectedFingerprint !== undefined) {
      const modifiedAt = statSync(candidatePath).mtimeMs
      if (sidecarAwareFileFingerprint(candidatePath, modifiedAt) !== expectedFingerprint) {
        throw new Error(`Compare baseline graph-backed file is out of sync with the saved graph snapshot: ${candidatePath}`)
      }
    }

    const corpusPath = relative(realProjectRoot, absolutePath).replaceAll(sep, '/')
    if (files.has(corpusPath)) {
      continue
    }

    try {
      const corpusText = readBaselineCorpusFile(absolutePath)
      if (corpusText === null) {
        continue
      }
      files.set(corpusPath, corpusText)
    } catch {
      continue
    }
  }

  if (files.size === 0) {
    throw new Error('Unable to derive a baseline corpus from graph-backed project files.')
  }

  return [...files.entries()]
    .flatMap(([filePath, content]) => [filePath, content, ''])
    .join('\n')
    .trimEnd()
}

export function buildBaselinePromptPack(input: BuildBaselinePromptPackInput): ComparePromptPack {
  const corpusText = input.corpusText.trim()
  const corpusBody =
    input.mode === 'bounded'
      ? buildBoundedCorpusExcerpt(input.question, input.graph, corpusText, input.maxTokens ?? DEFAULT_BOUNDED_BASELINE_TOKENS)
      : corpusText
  const prompt = renderBaselinePrompt(input.question, input.graph, corpusBody, input.mode)

  return {
    kind: 'baseline',
    question: input.question,
    prompt,
    token_count: estimateQueryTokens(prompt),
  }
}

export function buildGraphifyPromptPack(input: BuildGraphifyPromptPackInput): ComparePromptPack {
  const prompt = [
    'Answer the question using only the provided graph-guided retrieval output.',
    'If the retrieval does not contain the answer, say so.',
    '',
    `Question:\n${input.question}`,
    '',
    'Retrieved graph context:',
    formatGraphifyContext(input.retrieval),
    '',
    'Answer:',
  ].join('\n')

  return {
    kind: 'graphify',
    question: input.question,
    prompt,
    token_count: estimateQueryTokens(prompt),
  }
}

export function resolveCompareQuestions(options: Pick<GenerateCompareArtifactsInput, 'question' | 'questionsPath' | 'limit'>): string[] {
  if (options.question !== undefined && options.question !== null && options.questionsPath !== undefined && options.questionsPath !== null) {
    throw new Error('Compare runtime accepts either a single question or a questions path, but not both.')
  }

  if (options.limit !== undefined && options.limit !== null) {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new Error('Compare runtime limit must be a positive integer.')
    }
  }

  const rawQuestions =
    options.questionsPath !== undefined && options.questionsPath !== null
      ? loadBenchmarkQuestions(options.questionsPath).map((entry) => entry.question)
      : options.question !== undefined && options.question !== null
        ? [options.question]
        : []

  const trimmedQuestions = rawQuestions.map((question) => question.trim()).filter((question) => question.length > 0)
  if (trimmedQuestions.length === 0) {
    throw new Error('No compare questions were provided.')
  }

  if (options.limit !== undefined && options.limit !== null) {
      return trimmedQuestions.slice(0, options.limit)
  }

  return trimmedQuestions
}

export function generateCompareArtifacts(input: GenerateCompareArtifactsInput): GenerateCompareArtifactsResult {
  const graphPath = validateGraphPath(input.graphPath)
  const graph = loadGraph(graphPath)
  const corpusText = input.corpusText ?? deriveBaselineCorpusText(graphPath, graph)
  const questions = resolveCompareQuestions(input)
  const outputDir = validateGraphOutputPath(input.outputDir)
  const now = input.now ?? new Date()
  const outputRoot = join(outputDir, timestampDirectoryName(now))
  mkdirSync(outputRoot, { recursive: true })

  const reports = questions.map((question, index) => {
    const questionOutputDir = questions.length === 1 ? outputRoot : join(outputRoot, `question-${String(index + 1).padStart(3, '0')}`)
    mkdirSync(questionOutputDir, { recursive: true })

    const baselinePrompt = buildBaselinePromptPack({
      question,
      graph,
      corpusText,
      mode: input.baselineMode,
      ...(input.baselineMaxTokens !== undefined ? { maxTokens: input.baselineMaxTokens } : {}),
    })
    const retrieval = retrieveContext(graph, {
      question,
      budget: input.retrievalBudget ?? DEFAULT_RETRIEVAL_BUDGET,
    })
    const graphifyPrompt = buildGraphifyPromptPack({ question, retrieval })

    const paths: ComparePromptArtifactPaths = {
      output_dir: questionOutputDir,
      baseline_prompt: join(questionOutputDir, 'baseline-prompt.txt'),
      graphify_prompt: join(questionOutputDir, 'graphify-prompt.txt'),
      report: join(questionOutputDir, 'report.json'),
    }

    const baselinePromptText = baselinePrompt.prompt
    const graphifyPromptText = graphifyPrompt.prompt

    writeFileSync(paths.baseline_prompt, baselinePromptText, 'utf8')
    writeFileSync(paths.graphify_prompt, graphifyPromptText, 'utf8')

    const baselinePromptTokens = estimateQueryTokens(baselinePromptText)
    const graphifyPromptTokens = estimateQueryTokens(graphifyPromptText)

    const report: ComparePromptReport = {
      question,
      graph_path: graphPath,
      exec_command: input.execTemplate,
      baseline_mode: input.baselineMode,
      baseline_prompt_tokens: baselinePromptTokens,
      graphify_prompt_tokens: graphifyPromptTokens,
      reduction_ratio: computeReductionRatio(baselinePromptTokens, graphifyPromptTokens),
      started_at: now.toISOString(),
      completed_at: now.toISOString(),
      elapsed_ms: {
        baseline: 0,
        graphify: 0,
      },
      status: {
        baseline: 'not_run',
        graphify: 'not_run',
      },
      paths,
    }

    writeFileSync(
      paths.report,
      `${JSON.stringify({
        ...report,
        graph_path: portablePath(report.graph_path),
        paths: {
          output_dir: portablePath(report.paths.output_dir),
          baseline_prompt: portablePath(report.paths.baseline_prompt),
          graphify_prompt: portablePath(report.paths.graphify_prompt),
          report: portablePath(report.paths.report),
        },
      }, null, 2)}\n`,
      'utf8',
    )
    return report
  })

  return {
    graph_path: graphPath,
    output_root: resolve(outputRoot),
    reports,
  }
}
