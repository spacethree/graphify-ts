import { loadGraph } from '../runtime/serve.js'
import { KnowledgeGraph } from '../contracts/graph.js'
import { graphStructureMetrics, type GraphStructureMetrics } from '../pipeline/analyze.js'
import { formatTokenRatio, resolveCorpusBaseline, type CorpusBaselineSource } from './benchmark/corpus.js'
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
  reduction_ratio: number
  per_question: BenchmarkQuestionResult[]
}

export interface BenchmarkErrorResult {
  error: string
}

export type BenchmarkResult = BenchmarkSuccessResult | BenchmarkErrorResult

function loadBenchmarkGraph(graphPath: string): KnowledgeGraph {
  return loadGraph(graphPath)
}

function hasStructureSignalProvenance(graph: KnowledgeGraph): boolean {
  return graph.nodeEntries().every(([, attributes]) => String(attributes.source_file ?? '').length > 0)
}

export function runBenchmark(graphPath = 'graphify-out/graph.json', corpusWords?: number | null, questions?: BenchmarkQuestionInput[]): BenchmarkResult {
  const graph = loadBenchmarkGraph(graphPath)
  const structureSignals = hasStructureSignalProvenance(graph) ? graphStructureMetrics(graph) : null
  const baseline = resolveCorpusBaseline(graph.numberOfNodes(), { graphPath, corpusWords })
  const benchmarkQuestions = questions ?? SAMPLE_QUESTIONS
  const usesSampleQuestions = questions === undefined
  const perQuestion: BenchmarkQuestionResult[] = []
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
    perQuestion.push(evaluation.result)
  }

  if (perQuestion.length === 0) {
    return {
      error: usesSampleQuestions
        ? 'No matching nodes found for sample questions. Build the graph first.'
        : 'No matching nodes found for the supplied questions. Check the graph path or question file.',
    }
  }

  const avgQueryTokens = Math.floor(perQuestion.reduce((sum, entry) => sum + entry.query_tokens, 0) / perQuestion.length)
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
    reduction_ratio: avgQueryTokens > 0 ? Number((baseline.tokens / avgQueryTokens).toFixed(1)) : 0,
    per_question: perQuestion,
  }
}

export function printBenchmark(result: BenchmarkResult): void {
  if ('error' in result) {
    console.log(`Benchmark error: ${result.error}`)
    return
  }

  console.log('\ngraphify token reduction benchmark')
  console.log(`${'─'.repeat(50)}`)
  const corpusNote = result.corpus_source === 'estimated' ? ' (estimated from graph size)' : ''
  const reductionSummary =
    result.avg_query_tokens > 0
      ? result.corpus_tokens >= result.avg_query_tokens
        ? `${formatTokenRatio(result.corpus_tokens, result.avg_query_tokens)} tokens per query`
        : `not achieved (${formatTokenRatio(result.corpus_tokens, result.avg_query_tokens)} tokens per query)`
      : 'n/a'
  console.log(`  Corpus:          ${result.corpus_words.toLocaleString()} words → ~${result.corpus_tokens.toLocaleString()} tokens (naive corpus${corpusNote})`)
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
  console.log(`  Avg query cost:  ~${result.avg_query_tokens.toLocaleString()} tokens`)
  console.log(`  Reduction:       ${reductionSummary}`)
  console.log('\n  Per question:')
  for (const entry of result.per_question) {
    console.log(`    [${formatTokenRatio(result.corpus_tokens, entry.query_tokens)}] ${entry.question.slice(0, 55)}`)
  }
  console.log('')
}
