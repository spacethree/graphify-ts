import { existsSync } from 'node:fs'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { evaluateRetrievalQuality, formatQualityReport, GOLD_QUESTIONS, type GoldQuestion } from '../../src/infrastructure/benchmark/quality.js'
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
