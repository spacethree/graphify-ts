import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  buildBaselinePromptPack,
  buildGraphifyPromptPack,
  generateCompareArtifacts,
  resolveCompareQuestions,
} from '../../src/infrastructure/compare.js'
import { toJson } from '../../src/pipeline/export.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

const GRAPH_FIXTURE_ROOT = resolve('graphify-out', 'test-runtime', 'compare-runtime')
const COMPARE_OUTPUT_ROOT = resolve('graphify-out', 'compare', 'test-runtime')

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('auth_user', {
    label: 'authenticateUser',
    source_file: 'src/auth.ts',
    source_location: 'L10',
    line_number: 10,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_manager', {
    label: 'SessionManager',
    source_file: 'src/session.ts',
    source_location: 'L3',
    line_number: 3,
    node_kind: 'class',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_store', {
    label: 'SessionStore',
    source_file: 'src/session-store.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'class',
    file_type: 'code',
    community: 1,
  })
  graph.addEdge('auth_user', 'session_manager', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: 'src/auth.ts',
  })
  graph.addEdge('session_manager', 'session_store', {
    relation: 'uses',
    confidence: 'EXTRACTED',
    source_file: 'src/session.ts',
  })
  return graph
}

function makeCorpusText(): string {
  return [
    'src/auth.ts',
    'export function authenticateUser(credentials) {',
    '  return new SessionManager().createSession(credentials.userId)',
    '}',
    '',
    'src/session.ts',
    'export class SessionManager {',
    '  createSession(userId) {',
    '    return new SessionStore().write(userId)',
    '  }',
    '}',
    '',
    'src/session-store.ts',
    'export class SessionStore {',
    '  write(userId) {',
    '    return `session:${userId}`',
    '  }',
    '}',
    '',
    'src/routes.ts',
    'export function registerRoutes(app) {',
    '  app.post("/login", authenticateUser)',
    '  app.get("/health", () => "ok")',
    '}',
    '',
    'src/config.ts',
    'export const config = {',
    '  sessionCookieName: "sid",',
    '  sessionTtlSeconds: 86400,',
    '  loginAuditChannel: "auth-login",',
    '}',
    '',
    'docs/architecture.md',
    'The login flow starts in the HTTP route, validates credentials, and writes a session through the session manager.',
    'The billing system, reporting jobs, and queue worker are unrelated to login but live in the same repository corpus.',
    'This full-corpus baseline intentionally includes unrelated material so the compare prompt has more naive context to carry.',
    '',
    'src/billing.ts',
    'export function buildInvoiceSummary(accountId) {',
    '  return { accountId, total: 0, currency: "USD" }',
    '}',
    '',
    'src/reports.ts',
    'export function buildMonthlyRevenueReport() {',
    '  return []',
    '}',
  ].join('\n')
}

function writeGraphFixture(graph: KnowledgeGraph): string {
  mkdirSync(GRAPH_FIXTURE_ROOT, { recursive: true })
  const graphPath = join(GRAPH_FIXTURE_ROOT, 'graph.json')
  toJson(graph, { 0: ['auth_user', 'session_manager'], 1: ['session_store'] }, graphPath)
  return graphPath
}

beforeEach(() => {
  rmSync(GRAPH_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(COMPARE_OUTPUT_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(GRAPH_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(COMPARE_OUTPUT_ROOT, { recursive: true, force: true })
})

describe('compare runtime', () => {
  it('builds a baseline prompt pack from graph and corpus input', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()

    const fullPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'full',
    })
    const boundedPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'bounded',
      maxTokens: 120,
    })

    expect(fullPack.prompt).toContain('Question:\nhow does login create a session')
    expect(fullPack.prompt).toContain('authenticateUser')
    expect(fullPack.prompt).toContain('SessionManager')
    expect(boundedPack.prompt).toContain('[bounded baseline excerpt]')
    expect(boundedPack.prompt.length).toBeLessThan(fullPack.prompt.length)
    expect(estimateQueryTokens(boundedPack.prompt)).toBeLessThanOrEqual(120)
  })

  it('rejects bounded baseline budgets below the prompt floor', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()

    expect(() =>
      buildBaselinePromptPack({
        question: 'how does login create a session',
        graph,
        corpusText,
        mode: 'bounded',
        maxTokens: 10,
      }),
    ).toThrow(/too small/i)

    expect(() =>
      buildBaselinePromptPack({
        question: 'how does login create a session',
        graph,
        corpusText: '',
        mode: 'bounded',
        maxTokens: 10,
      }),
    ).toThrow(/too small/i)
  })

  it('builds a graphify prompt pack from existing retrieval output', () => {
    const graph = makeGraph()
    const retrieval = retrieveContext(graph, {
      question: 'how does login create a session',
      budget: 3000,
    })

    const pack = buildGraphifyPromptPack({ question: retrieval.question, retrieval })

    expect(pack.prompt).toContain('Retrieved graph context:')
    expect(pack.prompt).toContain('authenticateUser')
    expect(pack.prompt).toContain('SessionManager')
    expect(pack.prompt).toContain('calls')
  })

  it('computes prompt token counts from the exact prompt text', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()
    const retrieval = retrieveContext(graph, {
      question: 'how does login create a session',
      budget: 3000,
    })

    const baselinePack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'full',
    })
    const graphifyPack = buildGraphifyPromptPack({
      question: retrieval.question,
      retrieval,
    })

    expect(baselinePack.token_count).toBe(estimateQueryTokens(baselinePack.prompt))
    expect(graphifyPack.token_count).toBe(estimateQueryTokens(graphifyPack.prompt))
  })

  it('writes prompt artifacts and report with reduction ratio and saved file paths', () => {
    const graph = makeGraph()
    const graphPath = writeGraphFixture(graph)
    const questionsPath = join(GRAPH_FIXTURE_ROOT, 'compare-questions.json')
    writeFileSync(
      questionsPath,
      JSON.stringify([{ question: 'how does login create a session', expected_labels: ['authenticateUser'] }], null, 2),
      'utf8',
    )

    const result = generateCompareArtifacts({
      graphPath,
      questionsPath,
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      corpusText: makeCorpusText(),
      limit: 1,
      now: new Date('2026-04-24T19:30:00Z'),
    })

    expect(result.reports).toHaveLength(1)
    const report = result.reports[0]
    expect(report).toBeDefined()
    expect(report?.reduction_ratio).toBeGreaterThan(1)
    expect(report?.paths.output_dir).toBe(resolve('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00'))
    expect(report?.status.baseline).toBe('not_run')
    expect(report?.status.graphify).toBe('not_run')
    expect(existsSync(report!.paths.baseline_prompt)).toBe(true)
    expect(existsSync(report!.paths.graphify_prompt)).toBe(true)
    expect(existsSync(report!.paths.report)).toBe(true)

    const baselinePrompt = readFileSync(report!.paths.baseline_prompt, 'utf8')
    const graphifyPrompt = readFileSync(report!.paths.graphify_prompt, 'utf8')
    const savedReport = JSON.parse(readFileSync(report!.paths.report, 'utf8')) as Record<string, unknown>

    expect(baselinePrompt).toContain('Question:\nhow does login create a session')
    expect(graphifyPrompt).toContain('Retrieved graph context:')
    expect(savedReport).toEqual(
      expect.objectContaining({
        question: 'how does login create a session',
        exec_command: 'external-template',
        graph_path: join('graphify-out', 'test-runtime', 'compare-runtime', 'graph.json'),
        baseline_prompt_tokens: estimateQueryTokens(baselinePrompt),
        graphify_prompt_tokens: estimateQueryTokens(graphifyPrompt),
        reduction_ratio: report!.reduction_ratio,
        paths: {
          output_dir: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00'),
          baseline_prompt: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'baseline-prompt.txt'),
          graphify_prompt: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'graphify-prompt.txt'),
          report: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'report.json'),
        },
      }),
    )
  })

  it('rejects ambiguous question sources and invalid limits', () => {
    expect(() =>
      resolveCompareQuestions({
        question: 'how does login create a session',
        questionsPath: 'compare-questions.json',
        limit: 1,
      }),
    ).toThrow(/either a single question or a questions path/i)

    expect(() =>
      resolveCompareQuestions({
        question: 'how does login create a session',
        limit: 0,
      }),
    ).toThrow(/positive integer/i)
  })
})
