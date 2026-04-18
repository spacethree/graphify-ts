import { KnowledgeGraph } from '../../contracts/graph.js'
import { bfs, estimateQueryTokens, queryGraph, scoreNodes } from '../../runtime/serve.js'

export interface BenchmarkQuestionResult {
  question: string
  query_tokens: number
  reduction: number
  expected_labels: string[]
  matched_expected_labels: string[]
  missing_expected_labels: string[]
}

export interface BenchmarkQuestionSpec {
  question: string
  expected_labels?: string[]
}

export type BenchmarkQuestionInput = string | BenchmarkQuestionSpec

export interface BenchmarkMissingExpectedLabels {
  question: string
  labels: string[]
}

export interface BenchmarkQuestionEvaluation {
  question: string
  result: BenchmarkQuestionResult | null
  expected_label_count: number
  matched_expected_label_count: number
  missing_expected_labels: BenchmarkMissingExpectedLabels | null
}

export function normalizeBenchmarkQuestion(question: BenchmarkQuestionInput): BenchmarkQuestionSpec {
  if (typeof question === 'string') {
    return { question, expected_labels: [] }
  }
  return {
    question: question.question,
    expected_labels: Array.isArray(question.expected_labels) ? question.expected_labels.filter((label) => label.trim().length > 0) : [],
  }
}

function querySubgraphMatch(graph: KnowledgeGraph, question: string, depth = 2): { queryTokens: number; labels: Set<string> } | null {
  const terms = question
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2)
  const startNodes = scoreNodes(graph, terms).slice(0, 5).map(([, nodeId]) => nodeId)
  if (startNodes.length === 0) {
    return null
  }

  const output = queryGraph(graph, question, { depth })
  if (output.startsWith('No matching nodes found')) {
    return null
  }

  const traversal = bfs(graph, startNodes, depth)
  const labels = new Set(
    [...traversal.visited]
      .filter((nodeId) => graph.hasNode(nodeId))
      .map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId).toLowerCase()),
  )

  return { queryTokens: estimateQueryTokens(output), labels }
}

export function querySubgraphTokens(graph: KnowledgeGraph, question: string, depth = 2): number {
  return querySubgraphMatch(graph, question, depth)?.queryTokens ?? 0
}

export function evaluateBenchmarkQuestion(graph: KnowledgeGraph, question: BenchmarkQuestionInput, corpusTokens: number, depth = 2): BenchmarkQuestionEvaluation {
  const questionSpec = normalizeBenchmarkQuestion(question)
  const expectedLabels = questionSpec.expected_labels ?? []
  const match = querySubgraphMatch(graph, questionSpec.question, depth)
  if (!match) {
    return {
      question: questionSpec.question,
      result: null,
      expected_label_count: expectedLabels.length,
      matched_expected_label_count: 0,
      missing_expected_labels: expectedLabels.length > 0 ? { question: questionSpec.question, labels: expectedLabels } : null,
    }
  }

  const matchedExpectedLabels = expectedLabels.filter((label) => match.labels.has(label.toLowerCase()))
  const missingLabels = expectedLabels.filter((label) => !match.labels.has(label.toLowerCase()))
  return {
    question: questionSpec.question,
    result: {
      question: questionSpec.question,
      query_tokens: match.queryTokens,
      reduction: Number((corpusTokens / match.queryTokens).toFixed(1)),
      expected_labels: expectedLabels,
      matched_expected_labels: matchedExpectedLabels,
      missing_expected_labels: missingLabels,
    },
    expected_label_count: expectedLabels.length,
    matched_expected_label_count: matchedExpectedLabels.length,
    missing_expected_labels: missingLabels.length > 0 ? { question: questionSpec.question, labels: missingLabels } : null,
  }
}
