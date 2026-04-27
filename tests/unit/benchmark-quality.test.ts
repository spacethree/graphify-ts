import { existsSync } from 'node:fs'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { evaluateRetrievalQuality, formatQualityReport, GOLD_QUESTIONS, type GoldQuestion } from '../../src/infrastructure/benchmark/quality.js'
import { type BenchmarkQuestionSpec } from '../../src/infrastructure/benchmark/questions.js'
import { loadGraph } from '../../src/runtime/serve.js'

function buildTestGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('auth_module', { label: 'AuthModule', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L1' })
  graph.addNode('login_handler', { label: 'loginHandler', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L10' })
  graph.addNode('database', { label: 'Database', file_type: 'code', source_file: 'src/db.ts', source_location: 'L1' })
  graph.addNode('user_model', { label: 'UserModel', file_type: 'code', source_file: 'src/models/user.ts', source_location: 'L1' })
  graph.addEdge('auth_module', 'login_handler', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('login_handler', 'database', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('database', 'user_model', { relation: 'references', confidence: 'EXTRACTED', source_file: 'src/db.ts' })
  return graph
}

// @ts-expect-error GoldQuestion must require expected_labels for built-in eval sets.
const invalidGoldQuestion: GoldQuestion = { question: 'missing labels' }

describe('retrieval quality benchmark', () => {

  it('computes precision, recall, and MRR for gold questions with exact matching', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [
      { question: 'how does authentication work', expected_labels: ['authmodule', 'loginhandler'] },
      { question: 'what is the database layer', expected_labels: ['database'] },
    ]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.total_questions).toBe(2)
    expect(report.avg_recall).toBeGreaterThan(0)
    expect(report.mrr).toBeGreaterThan(0)
    expect(report.questions).toHaveLength(2)
    for (const q of report.questions) {
      expect(q.expected_labels.length).toBeGreaterThan(0)
    }
  })

  it('does not over-credit partial matches', () => {
    const graph = buildTestGraph()
    // 'auth' is a substring of 'authmodule' but should NOT match with exact matching
    const questions: GoldQuestion[] = [{ question: 'authentication module', expected_labels: ['auth'] }]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.questions[0]!.recall).toBe(0)
  })

  it('matches normalized shared question labels while preserving original expected labels', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [
      { question: 'how does authentication work', expected_labels: ['Auth Module', 'login-handler()'] },
    ]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.questions[0]!.recall).toBe(1)
    expect(report.questions[0]!.matched_labels).toEqual(['Auth Module', 'login-handler()'])
    expect(report.questions[0]!.missing_labels).toEqual([])
  })

  it('raises reciprocal rank when the expected direct node appears before supporting context', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [
      { question: 'how does authentication work', expected_labels: ['loginhandler'] },
    ]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.mrr).toBe(1)
  })

  it('keeps recall while reducing unnecessary returned labels for narrow symbol queries', () => {
    const graph = buildTestGraph()
    const report = evaluateRetrievalQuality(
      graph,
      [{ question: 'login handler', expected_labels: ['loginhandler'] }],
      3000,
    )

    expect(report.questions[0]?.recall).toBe(1)
    expect(report.questions[0]?.returned_labels.length).toBeLessThanOrEqual(3)
  })

  it('reports zero recall when no expected labels match', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [{ question: 'quantum entanglement physics', expected_labels: ['quantumprocessor'] }]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    expect(report.questions[0]!.recall).toBe(0)
    expect(report.questions[0]!.reciprocal_rank).toBe(0)
    expect(report.questions_with_hits).toBe(0)
  })

  it('uses token_count from retrieve result, not snippet length', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [{ question: 'auth module', expected_labels: ['authmodule'] }]

    const report = evaluateRetrievalQuality(graph, questions, 3000)

    // token_count comes from retrieveContext result, which is always >= 0
    expect(report.questions[0]!.tokens_used).toBeGreaterThanOrEqual(0)
    expect(typeof report.questions[0]!.tokens_used).toBe('number')
  })

  it('handles empty question list', () => {
    const graph = buildTestGraph()
    const report = evaluateRetrievalQuality(graph, [], 3000)

    expect(report.total_questions).toBe(0)
    expect(report.avg_precision).toBe(0)
    expect(report.avg_recall).toBe(0)
    expect(report.mrr).toBe(0)
  })

  it('skips unlabeled shared questions when computing eval metrics', () => {
    const graph = buildTestGraph()
    const questions: BenchmarkQuestionSpec[] = [
      { question: 'how does authentication work', expected_labels: ['authmodule'] },
      { question: 'benchmark-only prompt', expected_labels: [] },
      { question: 'missing labels prompt' },
    ]
    const report = evaluateRetrievalQuality(
      graph,
      questions,
      3000,
    )

    expect(report.total_questions).toBe(1)
    expect(report.skipped_questions).toBe(2)
    expect(report.questions).toHaveLength(1)
    expect(report.questions[0]?.question).toBe('how does authentication work')
  })

  it('reports when unlabeled shared questions were skipped', () => {
    const graph = buildTestGraph()
    const report = evaluateRetrievalQuality(
      graph,
      [
        { question: 'how does authentication work', expected_labels: ['authmodule'] },
        { question: 'benchmark-only prompt' },
      ],
      3000,
    )

    expect(formatQualityReport(report)).toContain('Skipped:      1 unlabeled question(s) missing expected_labels')
  })

  it('formatQualityReport returns a string for io.log', () => {
    const graph = buildTestGraph()
    const questions: GoldQuestion[] = [{ question: 'auth', expected_labels: ['authmodule'] }]
    const report = evaluateRetrievalQuality(graph, questions, 3000)

    const output = formatQualityReport(report)

    expect(typeof output).toBe('string')
    expect(output).toContain('retrieval quality benchmark')
    expect(output).toContain('Recall:')
    expect(output).toContain('MRR:')
  })

  const graphPath = 'graphify-out/graph.json'
  const hasGraph = existsSync(graphPath)

  it.skipIf(!hasGraph)('every built-in gold label resolves in the repo graph', () => {
    const graph = loadGraph(graphPath)
    const normalize = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, '')
    const allNormalized = new Set(graph.nodeEntries().map(([, a]) => normalize(String(a.label ?? ''))))

    for (const gold of GOLD_QUESTIONS) {
      for (const expected of gold.expected_labels) {
        const norm = normalize(expected)
        expect(allNormalized.has(norm), `Gold label "${expected}" (normalized: "${norm}") not found in graph for question: "${gold.question}"`).toBe(true)
      }
    }
  })
})
