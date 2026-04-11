import { readFileSync } from 'node:fs'

import { buildFromJson } from '../pipeline/build.js'
import { bfs } from '../runtime/serve.js'
import { isRecord } from '../shared/guards.js'
import { validateGraphPath } from '../shared/security.js'
import { KnowledgeGraph } from '../contracts/graph.js'

const CHARS_PER_TOKEN = 4

export const SAMPLE_QUESTIONS = [
  'how does authentication work',
  'what is the main entry point',
  'how are errors handled',
  'what connects the data layer to the api',
  'what are the core abstractions',
]

export interface BenchmarkQuestionResult {
  question: string
  query_tokens: number
  reduction: number
}

export interface BenchmarkSuccessResult {
  corpus_tokens: number
  corpus_words: number
  nodes: number
  edges: number
  avg_query_tokens: number
  reduction_ratio: number
  per_question: BenchmarkQuestionResult[]
}

export interface BenchmarkErrorResult {
  error: string
}

export type BenchmarkResult = BenchmarkSuccessResult | BenchmarkErrorResult

function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / CHARS_PER_TOKEN))
}

function loadBenchmarkGraph(graphPath: string): KnowledgeGraph {
  const safePath = validateGraphPath(graphPath)
  const parsed = JSON.parse(readFileSync(safePath, 'utf8')) as unknown
  if (!isRecord(parsed)) {
    return new KnowledgeGraph()
  }

  return buildFromJson({
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.links) ? parsed.links : Array.isArray(parsed.edges) ? parsed.edges : [],
    hyperedges: Array.isArray(parsed.hyperedges) ? parsed.hyperedges : [],
  })
}

export function querySubgraphTokens(graph: KnowledgeGraph, question: string, depth = 3): number {
  const terms = question
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2)
  const scored = graph
    .nodeEntries()
    .map(([nodeId, attributes]) => {
      const label = String(attributes.label ?? '').toLowerCase()
      const score = terms.reduce((total, term) => total + (label.includes(term) ? 1 : 0), 0)
      return [score, nodeId] as [number, string]
    })
    .filter(([score]) => score > 0)
    .sort((left, right) => right[0] - left[0] || left[1].localeCompare(right[1]))

  const startNodes = scored.slice(0, 3).map(([, nodeId]) => nodeId)
  if (startNodes.length === 0) {
    return 0
  }

  const { visited, edges } = bfs(graph, startNodes, depth)
  const lines: string[] = []
  for (const nodeId of visited) {
    const attributes = graph.nodeAttributes(nodeId)
    lines.push(`NODE ${String(attributes.label ?? nodeId)} src=${String(attributes.source_file ?? '')} loc=${String(attributes.source_location ?? '')}`)
  }
  for (const [source, target] of edges) {
    if (!visited.has(source) || !visited.has(target)) {
      continue
    }
    const attributes = graph.edgeAttributes(source, target)
    lines.push(
      `EDGE ${String(graph.nodeAttributes(source).label ?? source)} --${String(attributes.relation ?? '')}--> ${String(graph.nodeAttributes(target).label ?? target)}`,
    )
  }

  return estimateTokens(lines.join('\n'))
}

export function runBenchmark(graphPath = 'graphify-out/graph.json', corpusWords?: number | null, questions?: string[]): BenchmarkResult {
  const graph = loadBenchmarkGraph(graphPath)
  const effectiveCorpusWords = corpusWords ?? graph.numberOfNodes() * 50
  const corpusTokens = Math.floor((effectiveCorpusWords * 100) / 75)
  const benchmarkQuestions = questions ?? SAMPLE_QUESTIONS

  const perQuestion = benchmarkQuestions
    .map((question) => {
      const queryTokens = querySubgraphTokens(graph, question)
      if (queryTokens <= 0) {
        return null
      }
      return {
        question,
        query_tokens: queryTokens,
        reduction: Number((corpusTokens / queryTokens).toFixed(1)),
      } satisfies BenchmarkQuestionResult
    })
    .filter((entry): entry is BenchmarkQuestionResult => entry !== null)

  if (perQuestion.length === 0) {
    return { error: 'No matching nodes found for sample questions. Build the graph first.' }
  }

  const avgQueryTokens = Math.floor(perQuestion.reduce((sum, entry) => sum + entry.query_tokens, 0) / perQuestion.length)
  return {
    corpus_tokens: corpusTokens,
    corpus_words: effectiveCorpusWords,
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
    avg_query_tokens: avgQueryTokens,
    reduction_ratio: avgQueryTokens > 0 ? Number((corpusTokens / avgQueryTokens).toFixed(1)) : 0,
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
  console.log(`  Corpus:          ${result.corpus_words.toLocaleString()} words → ~${result.corpus_tokens.toLocaleString()} tokens (naive)`)
  console.log(`  Graph:           ${result.nodes.toLocaleString()} nodes, ${result.edges.toLocaleString()} edges`)
  console.log(`  Avg query cost:  ~${result.avg_query_tokens.toLocaleString()} tokens`)
  console.log(`  Reduction:       ${result.reduction_ratio}x fewer tokens per query`)
  console.log('\n  Per question:')
  for (const entry of result.per_question) {
    console.log(`    [${entry.reduction}x] ${entry.question.slice(0, 55)}`)
  }
  console.log('')
}
