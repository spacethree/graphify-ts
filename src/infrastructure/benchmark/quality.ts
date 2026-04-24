import { KnowledgeGraph } from '../../contracts/graph.js'
import { retrieveContext, type RetrieveResult } from '../../runtime/retrieve.js'

export interface GoldQuestion {
  question: string
  expected_labels: string[]
}

export interface QualityResult {
  question: string
  expected_labels: string[]
  returned_labels: string[]
  matched_labels: string[]
  missing_labels: string[]
  precision: number
  recall: number
  reciprocal_rank: number
  tokens_used: number
}

export interface QualityReport {
  questions: QualityResult[]
  avg_precision: number
  avg_recall: number
  mrr: number
  questions_with_hits: number
  total_questions: number
  avg_tokens_used: number
  corpus_tokens: number
  compression_ratio: number
}

/**
 * Gold-standard questions for graphify-ts itself.
 * Each expected_labels entry is the exact normalized form of a real node label
 * in the graphify-ts graph (lowercase, non-alphanumeric stripped).
 */
export const GOLD_QUESTIONS: GoldQuestion[] = [
  {
    question: 'how does community detection work',
    expected_labels: ['cluster', 'louvainpass'],
  },
  {
    question: 'how does the retrieve MCP tool find relevant nodes',
    expected_labels: ['retrievecontext', 'scorenode'],
  },
  {
    question: 'how does code extraction work',
    expected_labels: ['extractjs', 'extractionnode'],
  },
  {
    question: 'how does the CLI parse command arguments',
    expected_labels: ['parsegenerateargs', 'parsequeryargs'],
  },
  {
    question: 'how does impact analysis compute blast radius',
    expected_labels: ['analyzeimpact', 'impactresult'],
  },
  {
    question: 'how does the claude install command configure hooks and MCP',
    expected_labels: ['claudeinstall', 'installmcpserver'],
  },
  {
    question: 'how does community naming assign labels to clusters',
    expected_labels: ['buildcommunitylabels'],
  },
  {
    question: 'how does incremental update detect changed files',
    expected_labels: ['detectincremental'],
  },
  {
    question: 'how does the graph report get generated',
    expected_labels: ['generate', 'reportts'],
  },
  {
    question: 'how does the HTML export build the interactive explorer',
    expected_labels: ['tohtml'],
  },
]

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isExactMatch(returned: string, expected: string): boolean {
  return returned === expected
}

function evaluateQuestion(graph: KnowledgeGraph, gold: GoldQuestion, budget: number): QualityResult {
  const result: RetrieveResult = retrieveContext(graph, { question: gold.question, budget })
  const returnedLabels = result.matched_nodes.map((node) => normalizeLabel(node.label))
  const expectedNormalized = gold.expected_labels.map(normalizeLabel)

  const matchedLabels = expectedNormalized.filter((expected) => returnedLabels.some((returned) => isExactMatch(returned, expected)))
  const missingLabels = expectedNormalized.filter((expected) => !returnedLabels.some((returned) => isExactMatch(returned, expected)))

  // Reciprocal rank: position of first expected label in results (1-indexed)
  let reciprocalRank = 0
  for (let i = 0; i < returnedLabels.length; i++) {
    const returned = returnedLabels[i]
    if (returned === undefined) continue
    if (expectedNormalized.some((expected) => isExactMatch(returned, expected))) {
      reciprocalRank = 1 / (i + 1)
      break
    }
  }

  const precision = returnedLabels.length > 0 ? matchedLabels.length / returnedLabels.length : 0
  const recall = expectedNormalized.length > 0 ? matchedLabels.length / expectedNormalized.length : 0

  return {
    question: gold.question,
    expected_labels: gold.expected_labels,
    returned_labels: result.matched_nodes.map((node) => node.label),
    matched_labels: matchedLabels,
    missing_labels: missingLabels,
    precision,
    recall,
    reciprocal_rank: reciprocalRank,
    tokens_used: result.token_count,
  }
}

export function evaluateRetrievalQuality(graph: KnowledgeGraph, questions: GoldQuestion[] = GOLD_QUESTIONS, budget = 3000): QualityReport {
  const results = questions.map((q) => evaluateQuestion(graph, q, budget))
  const withHits = results.filter((r) => r.matched_labels.length > 0)
  const avgTokens = results.length > 0 ? Math.floor(results.reduce((sum, r) => sum + r.tokens_used, 0) / results.length) : 0
  const corpusTokens = Math.floor(graph.numberOfNodes() * 50 * 100 / 75)

  return {
    questions: results,
    avg_precision: results.length > 0 ? results.reduce((sum, r) => sum + r.precision, 0) / results.length : 0,
    avg_recall: results.length > 0 ? results.reduce((sum, r) => sum + r.recall, 0) / results.length : 0,
    mrr: results.length > 0 ? results.reduce((sum, r) => sum + r.reciprocal_rank, 0) / results.length : 0,
    questions_with_hits: withHits.length,
    total_questions: results.length,
    avg_tokens_used: avgTokens,
    corpus_tokens: corpusTokens,
    compression_ratio: avgTokens > 0 ? Number((corpusTokens / avgTokens).toFixed(1)) : 0,
  }
}

export function formatQualityReport(report: QualityReport): string {
  const lines = [
    '',
    'graphify retrieval quality benchmark',
    '─'.repeat(50),
    `  Questions:    ${report.questions_with_hits}/${report.total_questions} found expected nodes`,
    `  Recall:       ${(report.avg_recall * 100).toFixed(1)}%`,
    `  MRR:          ${report.mrr.toFixed(3)}`,
  ]

  if (report.avg_tokens_used > 0) {
    lines.push(`  Avg tokens:   ${report.avg_tokens_used.toLocaleString()} per query (vs ~${report.corpus_tokens.toLocaleString()} naive corpus)`)
    lines.push(`  Compression:  ${report.compression_ratio}x fewer tokens with ${(report.avg_recall * 100).toFixed(0)}% recall`)
  }

  lines.push('')
  lines.push('  Per question:')
  for (const r of report.questions) {
    const status = r.recall === 1 ? '+' : r.recall > 0 ? '~' : 'x'
    const recallPct = (r.recall * 100).toFixed(0)
    lines.push(`    ${status} [recall ${recallPct}%] ${r.question}`)
    if (r.missing_labels.length > 0) {
      lines.push(`      missing: ${r.missing_labels.join(', ')}`)
    }
  }
  lines.push('')

  return lines.join('\n')
}
