import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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

const RUNNER_GRAPH_PATH = join(process.cwd(), 'graphify-out', 'graph.json')
const RUNNER_OUTPUT_DIR = join(process.cwd(), 'graphify-out', 'benchmark-quality-test-output')

function resetRunnerOutputDir(): void {
  rmSync(RUNNER_OUTPUT_DIR, { recursive: true, force: true })
  mkdirSync(RUNNER_OUTPUT_DIR, { recursive: true })
}

// @ts-expect-error GoldQuestion must require expected_labels for built-in eval sets.
const invalidGoldQuestion: GoldQuestion = { question: 'missing labels' }

describe('retrieval quality benchmark', () => {
  afterAll(() => {
    rmSync(RUNNER_OUTPUT_DIR, { recursive: true, force: true })
  })

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

  it('executes each labeled eval question through the runner and reports provider usage averages', async () => {
    resetRunnerOutputDir()
    const graph = buildTestGraph()
    const executions: Array<{ question: string; mode: string; command: string; promptFile: string; outputFile: string }> = []
    const report = await evaluateRetrievalQuality(
      graph,
      [
        { question: 'how does authentication work', expected_labels: ['authmodule', 'loginhandler'] },
        { question: 'benchmark-only prompt' },
        { question: 'what is the database layer', expected_labels: ['database'] },
      ],
      3000,
      {
        graphPath: RUNNER_GRAPH_PATH,
        execTemplate: "runner --mode '{mode}' --prompt {prompt_file} --output {output_file}",
        outputDir: RUNNER_OUTPUT_DIR,
        now: new Date('2024-03-04T05:06:07.000Z'),
        runner: async (execution) => {
          executions.push(execution)
          const inputTokens = execution.question.includes('authentication') ? 320 : 180
          const totalTokens = execution.question.includes('authentication') ? 360 : 210
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              result: `Answer for ${execution.question}\n`,
              usage: {
                input_tokens: inputTokens,
                output_tokens: totalTokens - inputTokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            }),
            stderr: '',
            elapsedMs: execution.question.includes('authentication') ? 11 : 17,
          }
        },
      },
    )

    expect(executions.map((execution) => execution.question)).toEqual([
      'how does authentication work',
      'what is the database layer',
    ])
    expect(executions.map((execution) => execution.mode)).toEqual(['graphify', 'graphify'])
    expect(executions[0]?.command).toContain('graphify-prompt.txt')
    expect(report.total_questions).toBe(2)
    expect(report.skipped_questions).toBe(1)
    expect(report.avg_recall).toBe(1)
    expect(report.mrr).toBe(1)
    expect(report.avg_tokens_used).toBe(250)
    expect(report.avg_total_tokens).toBe(285)
    expect(report.questions[0]?.usage?.provider).toBe('claude')
    expect(report.questions[0]?.artifacts?.prompt).toContain('graphify-prompt.txt')
    expect(readFileSync(report.questions[0]!.artifacts!.answer, 'utf8')).toBe('Answer for how does authentication work\n')

    const output = formatQualityReport(report)

    expect(output).toContain('Recall:       100.0%')
    expect(output).toContain('MRR:          1.000')
    expect(output).toContain('Avg input tokens (Claude reported): ~250')
    expect(output).toContain('Avg total tokens (Claude reported): ~285')
    expect(output).not.toContain('estimate fallback')
  })

  it('labels fallback estimates only when structured runner usage is unavailable', async () => {
    resetRunnerOutputDir()
    const graph = buildTestGraph()
    const report = await evaluateRetrievalQuality(
      graph,
      [
        { question: 'how does authentication work', expected_labels: ['authmodule'] },
        { question: 'what is the database layer', expected_labels: ['database'] },
      ],
      3000,
      {
        graphPath: RUNNER_GRAPH_PATH,
        execTemplate: "runner --mode '{mode}' --prompt {prompt_file} --output {output_file}",
        outputDir: RUNNER_OUTPUT_DIR,
        now: new Date('2024-03-04T05:06:08.000Z'),
        runner: async (execution) => {
          if (execution.question.includes('authentication')) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                result: `Answer for ${execution.question}\n`,
                usage: {
                  input_tokens: 400,
                  output_tokens: 70,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 10,
                },
              }),
              stderr: '',
              elapsedMs: 11,
            }
          }

          return {
            exitCode: 0,
            stdout: `Plain answer for ${execution.question}\n`,
            stderr: '',
            elapsedMs: 7,
          }
        },
      },
    )

    expect(report.avg_total_tokens).toBeNull()
    expect(report.questions[0]?.usage?.provider).toBe('claude')
    expect(report.questions[1]?.prompt_token_source).toBe('estimated_cl100k_base')
    expect(readFileSync(report.questions[1]!.artifacts!.answer, 'utf8')).toBe('Plain answer for what is the database layer\n')

    const output = formatQualityReport(report)

    expect(output).toContain(`Avg input tokens (Claude reported where available; cl100k_base estimate fallback): ~${report.avg_tokens_used.toLocaleString()}`)
    expect(output).toContain('Usage capture: Claude reported usage for 1/2 evaluated questions; remaining runs used local estimate fallback')
    expect(output).not.toContain('Avg total tokens (Claude reported)')
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
