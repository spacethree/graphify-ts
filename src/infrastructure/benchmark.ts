import { QUERY_TOKEN_ESTIMATOR, loadGraph } from '../runtime/serve.js'
import { KnowledgeGraph } from '../contracts/graph.js'
import { graphStructureMetrics, type GraphStructureMetrics } from '../pipeline/analyze.js'
import { formatTokenRatio, resolveCorpusBaseline, type CorpusBaselineSource } from './benchmark/corpus.js'
import {
  runBenchmarkPrompt,
  type BenchmarkPromptExecution,
  type BenchmarkPromptRunnerResult,
} from './benchmark/runner.js'
import {
  evaluateBenchmarkQuestion,
  querySubgraphTokens,
  type BenchmarkMissingExpectedLabels,
  type BenchmarkQuestionInput,
  type BenchmarkQuestionResult,
} from './benchmark/questions.js'

export { loadBenchmarkQuestions, querySubgraphTokens, type BenchmarkQuestionInput } from './benchmark/questions.js'

export const SAMPLE_QUESTIONS = [
  'how does authentication work',
  'what is the main entry point',
  'how are errors handled',
  'what connects the data layer to the api',
  'what are the core abstractions',
]

export interface BenchmarkSuccessResult {
  corpus_tokens: number
  corpus_words: number
  corpus_source: CorpusBaselineSource
  nodes: number
  edges: number
  structure_signals: GraphStructureMetrics | null
  question_count: number
  matched_question_count: number
  unmatched_questions: string[]
  expected_label_count: number
  matched_expected_label_count: number
  missing_expected_labels: BenchmarkMissingExpectedLabels[]
  avg_query_tokens: number
  avg_total_tokens?: number | null
  reduction_ratio: number
  per_question: BenchmarkQuestionResult[]
}

export interface BenchmarkErrorResult {
  error: string
}

export type BenchmarkResult = BenchmarkSuccessResult | BenchmarkErrorResult

export interface BenchmarkRunOptions {
  execTemplate?: string
  outputDir?: string
  now?: Date
  retrievalBudget?: number
  runner?: (execution: BenchmarkPromptExecution) => Promise<BenchmarkPromptRunnerResult>
}

function loadBenchmarkGraph(graphPath: string): KnowledgeGraph {
  return loadGraph(graphPath)
}

function hasStructureSignalProvenance(graph: KnowledgeGraph): boolean {
  return graph.nodeEntries().every(([, attributes]) => String(attributes.source_file ?? '').length > 0)
}

function averageQueryTokens(perQuestion: readonly BenchmarkQuestionResult[]): number {
  return Math.floor(perQuestion.reduce((sum, entry) => sum + entry.query_tokens, 0) / perQuestion.length)
}

function averageTotalTokens(perQuestion: readonly BenchmarkQuestionResult[]): number | null {
  let total = 0
  for (const entry of perQuestion) {
    if (entry.total_tokens === null || entry.total_tokens === undefined) {
      return null
    }
    total += entry.total_tokens
  }
  return Math.floor(total / perQuestion.length)
}

function finalizeBenchmarkResult(
  graph: KnowledgeGraph,
  structureSignals: GraphStructureMetrics | null,
  baseline: ReturnType<typeof resolveCorpusBaseline>,
  benchmarkQuestions: readonly BenchmarkQuestionInput[],
  unmatchedQuestions: string[],
  expectedLabelCount: number,
  matchedExpectedLabelCount: number,
  missingExpectedLabels: BenchmarkMissingExpectedLabels[],
  perQuestion: BenchmarkQuestionResult[],
): BenchmarkSuccessResult {
  const avgQueryTokens = averageQueryTokens(perQuestion)
  return {
    corpus_tokens: baseline.tokens,
    corpus_words: baseline.words,
    corpus_source: baseline.source,
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
    structure_signals: structureSignals,
    question_count: benchmarkQuestions.length,
    matched_question_count: perQuestion.length,
    unmatched_questions: unmatchedQuestions,
    expected_label_count: expectedLabelCount,
    matched_expected_label_count: matchedExpectedLabelCount,
    missing_expected_labels: missingExpectedLabels,
    avg_query_tokens: avgQueryTokens,
    avg_total_tokens: averageTotalTokens(perQuestion),
    reduction_ratio: avgQueryTokens > 0 ? Number((baseline.tokens / avgQueryTokens).toFixed(1)) : 0,
    per_question: perQuestion,
  }
}

async function runRunnerBackedBenchmark(
  graph: KnowledgeGraph,
  graphPath: string,
  baseline: ReturnType<typeof resolveCorpusBaseline>,
  evaluations: readonly BenchmarkQuestionResult[],
  options: BenchmarkRunOptions,
): Promise<BenchmarkQuestionResult[]> {
  const execTemplate = options.execTemplate
  if (!execTemplate) {
    return [...evaluations]
  }

  const perQuestion: BenchmarkQuestionResult[] = []
  for (const evaluation of evaluations) {
    const run = await runBenchmarkPrompt({
      graphPath,
      graph,
      question: evaluation.question,
      execTemplate,
      ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.retrievalBudget !== undefined ? { retrievalBudget: options.retrievalBudget } : {}),
      ...(options.runner !== undefined ? { runner: options.runner } : {}),
    })
    perQuestion.push({
      ...evaluation,
      query_tokens: run.query_tokens,
      total_tokens: run.total_tokens,
      prompt_tokens_estimated: run.prompt_tokens_estimated,
      prompt_token_source: run.prompt_token_source,
      usage: run.usage,
      answer_text: run.answer_text,
      elapsed_ms: run.elapsed_ms,
      artifacts: run.artifacts,
      reduction: run.query_tokens > 0 ? Number((baseline.tokens / run.query_tokens).toFixed(1)) : 0,
    })
  }
  return perQuestion
}

function usageProviderLabel(result: BenchmarkSuccessResult): string {
  const providers = new Set(result.per_question.flatMap((entry) => (entry.usage ? [entry.usage.provider] : [])))
  if (providers.size !== 1) {
    return 'Runner'
  }

  const [provider] = providers
  return provider === 'gemini' ? 'Gemini' : 'Claude'
}

function promptTokenLabel(result: BenchmarkSuccessResult): string {
  const usageRuns = result.per_question.reduce((count, entry) => count + (entry.usage === null || entry.usage === undefined ? 0 : 1), 0)
  const totalRuns = result.per_question.length
  const providerLabel = usageProviderLabel(result)

  if (usageRuns === totalRuns) {
    return `Avg input tokens (${providerLabel} reported)`
  }
  if (usageRuns > 0) {
    return `Avg input tokens (${providerLabel} reported where available; ${QUERY_TOKEN_ESTIMATOR.model} estimate fallback)`
  }
  return `Avg input tokens (estimated ${QUERY_TOKEN_ESTIMATOR.model})`
}

function usageCaptureLine(result: BenchmarkSuccessResult): string | null {
  const usageRuns = result.per_question.reduce((count, entry) => count + (entry.usage === null || entry.usage === undefined ? 0 : 1), 0)
  if (usageRuns <= 0 || usageRuns >= result.per_question.length) {
    return null
  }

  return `  Usage capture: ${usageProviderLabel(result)} reported usage for ${usageRuns}/${result.per_question.length} matched questions; remaining runs used local estimate fallback`
}

function totalTokenLabel(result: BenchmarkSuccessResult): string | null {
  if (result.avg_total_tokens === null || result.avg_total_tokens === undefined) {
    return null
  }

  return `  Avg total tokens (${usageProviderLabel(result)} reported): ~${result.avg_total_tokens.toLocaleString()}`
}

function perQuestionTokenSourceLabel(entry: BenchmarkQuestionResult): string {
  if (entry.prompt_token_source === 'claude_reported_input') {
    return ' · Claude reported'
  }
  if (entry.prompt_token_source === 'gemini_reported_input') {
    return ' · Gemini reported'
  }
  return entry.prompt_token_source === 'estimated_cl100k_base' ? ` · estimated ${QUERY_TOKEN_ESTIMATOR.model}` : ''
}

export function runBenchmark(
  graphPath = 'graphify-out/graph.json',
  corpusWords?: number | null,
  questions?: BenchmarkQuestionInput[],
  options: BenchmarkRunOptions = {},
): BenchmarkResult | Promise<BenchmarkResult> {
  const graph = loadBenchmarkGraph(graphPath)
  const structureSignals = hasStructureSignalProvenance(graph) ? graphStructureMetrics(graph) : null
  const baseline = resolveCorpusBaseline(graph.numberOfNodes(), { graphPath, corpusWords })
  const benchmarkQuestions = questions ?? SAMPLE_QUESTIONS
  const usesSampleQuestions = questions === undefined
  const evaluatedQuestions: BenchmarkQuestionResult[] = []
  const unmatchedQuestions: string[] = []
  const missingExpectedLabels: BenchmarkMissingExpectedLabels[] = []
  if (benchmarkQuestions.length === 0) {
    return {
      error: usesSampleQuestions
        ? 'No sample questions are available for this benchmark run.'
        : 'Question file did not include any benchmark questions. Add at least one question or omit --questions to use the sample set.',
    }
  }

  let expectedLabelCount = 0
  let matchedExpectedLabelCount = 0
  for (const question of benchmarkQuestions) {
    const evaluation = evaluateBenchmarkQuestion(graph, question, baseline.tokens)
    expectedLabelCount += evaluation.expected_label_count
    matchedExpectedLabelCount += evaluation.matched_expected_label_count
    if (evaluation.missing_expected_labels) {
      missingExpectedLabels.push(evaluation.missing_expected_labels)
    }
    if (!evaluation.result) {
      unmatchedQuestions.push(evaluation.question)
      continue
    }
    evaluatedQuestions.push(evaluation.result)
  }

  if (evaluatedQuestions.length === 0) {
    return {
      error: usesSampleQuestions
        ? 'No matching nodes found for sample questions. Build the graph first.'
        : 'No matching nodes found for the supplied questions. Check the graph path or question file.',
    }
  }

  if (!options.execTemplate) {
    return finalizeBenchmarkResult(
      graph,
      structureSignals,
      baseline,
      benchmarkQuestions,
      unmatchedQuestions,
      expectedLabelCount,
      matchedExpectedLabelCount,
      missingExpectedLabels,
      evaluatedQuestions,
    )
  }

  return runRunnerBackedBenchmark(graph, graphPath, baseline, evaluatedQuestions, options)
    .then((perQuestion) =>
      finalizeBenchmarkResult(
        graph,
        structureSignals,
        baseline,
        benchmarkQuestions,
        unmatchedQuestions,
        expectedLabelCount,
        matchedExpectedLabelCount,
        missingExpectedLabels,
        perQuestion,
      ),
    )
    .catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
}

export function printBenchmark(result: BenchmarkResult): void {
  if ('error' in result) {
    console.log(`Benchmark error: ${result.error}`)
    return
  }

  console.log('\ngraphify runner-backed benchmark')
  console.log(`${'─'.repeat(50)}`)
  const corpusNote = result.corpus_source === 'estimated' ? ' (estimated from graph size)' : ''
  console.log(`  Corpus baseline: ${result.corpus_words.toLocaleString()} words → ~${result.corpus_tokens.toLocaleString()} tokens${corpusNote}`)
  console.log(`  Graph:           ${result.nodes.toLocaleString()} nodes, ${result.edges.toLocaleString()} edges`)
  console.log(`  Question coverage: ${result.matched_question_count}/${result.question_count} matched`)
  if (result.unmatched_questions.length > 0) {
    console.log(`    Unmatched: ${result.unmatched_questions.join(', ')}`)
  }
  if (result.expected_label_count > 0) {
    console.log(`  Expected evidence: ${result.matched_expected_label_count}/${result.expected_label_count} labels found`)
    for (const missing of result.missing_expected_labels) {
      console.log(`    Missing evidence for ${missing.question}: ${missing.labels.join(', ')}`)
    }
  }
  if (result.structure_signals) {
    console.log('  Structure signals:')
    console.log(
      `    entity basis: ${result.structure_signals.total_nodes.toLocaleString()} nodes, ${result.structure_signals.total_edges.toLocaleString()} edges`,
    )
    console.log(
      `    components: ${result.structure_signals.weakly_connected_components.toLocaleString()} weakly connected, ${result.structure_signals.singleton_components.toLocaleString()} singleton, ${result.structure_signals.isolated_nodes.toLocaleString()} isolated`,
    )
    console.log(
      `    largest component: ${result.structure_signals.largest_component_nodes.toLocaleString()} nodes (${Math.round(result.structure_signals.largest_component_ratio * 100)}% of entity graph)`,
    )
    console.log(
      result.structure_signals.low_cohesion_communities > 0
        ? `    low cohesion: ${result.structure_signals.low_cohesion_communities.toLocaleString()} communities, largest ${result.structure_signals.largest_low_cohesion_community_nodes.toLocaleString()} nodes (cohesion ${result.structure_signals.largest_low_cohesion_community_score})`
        : '    low cohesion: 0 communities, none on the entity basis',
    )
  } else {
    console.log('  Structure signals: unavailable for graph artifacts without source_file provenance')
  }
  console.log(`  ${promptTokenLabel(result)}: ~${result.avg_query_tokens.toLocaleString()}`)
  const totalTokensLine = totalTokenLabel(result)
  if (totalTokensLine) {
    console.log(totalTokensLine)
  }
  const usageLine = usageCaptureLine(result)
  if (usageLine) {
    console.log(usageLine)
  }
  console.log(`  Corpus compression: ${formatTokenRatio(result.corpus_tokens, result.avg_query_tokens)} per matched question`)
  console.log('\n  Per question:')
  for (const entry of result.per_question) {
    console.log(
      `    [${formatTokenRatio(result.corpus_tokens, entry.query_tokens)}] ${entry.question.slice(0, 55)}${perQuestionTokenSourceLabel(entry)}`,
    )
  }
  console.log('')
}
