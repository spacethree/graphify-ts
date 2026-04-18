import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { runBenchmark, printBenchmark, querySubgraphTokens, type BenchmarkQuestionInput } from '../../src/infrastructure/benchmark.js'
import { toJson } from '../../src/pipeline/export.js'
import { estimateQueryTokens, queryGraph } from '../../src/runtime/serve.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-benchmark-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function copyFixtureCorpus(fixtureName: string, tempDir: string): string {
  const fixtureRoot = join(FIXTURES_DIR, fixtureName)
  const targetRoot = join(tempDir, fixtureName)
  cpSync(fixtureRoot, targetRoot, { recursive: true })
  return targetRoot
}

function readWorkspaceParityQuestions(): BenchmarkQuestionInput[] {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'workspace-parity-questions.json'), 'utf8')) as BenchmarkQuestionInput[]
}

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('n1', { label: 'authentication', source_file: 'auth.py', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('n2', { label: 'api_handler', source_file: 'api.py', source_location: 'L5', community: 0, file_type: 'code' })
  graph.addNode('n3', { label: 'main_entry', source_file: 'main.py', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('n4', { label: 'error_handler', source_file: 'errors.py', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('n5', { label: 'database_layer', source_file: 'db.py', source_location: 'L1', community: 2, file_type: 'code' })
  graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'INFERRED', source_file: 'auth.py' })
  graph.addEdge('n2', 'n3', { relation: 'imports', confidence: 'EXTRACTED', source_file: 'api.py' })
  graph.addEdge('n3', 'n4', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'main.py' })
  graph.addEdge('n5', 'n2', { relation: 'provides', confidence: 'EXTRACTED', source_file: 'db.py' })
  return graph
}

function makeWorkspaceGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph(true)
  graph.addNode('a', { label: 'authentication', source_file: 'auth.ts', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('b', { label: 'api_handler', source_file: 'api.ts', source_location: 'L5', community: 0, file_type: 'code' })
  graph.addNode('c', { label: 'main_entry', source_file: 'main.ts', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('d', { label: 'database_layer', source_file: 'db.ts', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('e', { label: 'queue_worker', source_file: 'worker.ts', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('f', { label: 'toHtml()', source_file: 'export.ts', source_location: 'L1', community: 2, file_type: 'code' })
  graph.addNode('file', { label: 'auth.ts', source_file: 'auth.ts', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('concept', { label: 'Shared infra', source_file: 'concept.md', source_location: 'L1', community: 3, file_type: 'document' })
  graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' })
  graph.addEdge('b', 'c', { relation: 'imports', confidence: 'EXTRACTED', source_file: 'api.ts' })
  graph.addEdge('d', 'e', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'db.ts' })
  graph.addEdge('f', 'concept', { relation: 'references', confidence: 'EXTRACTED', source_file: 'export.ts' })
  graph.addEdge('file', 'a', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'auth.ts' })
  return graph
}

describe('querySubgraphTokens', () => {
  test('returns positive tokens for matching questions', () => {
    expect(querySubgraphTokens(makeGraph(), 'how does authentication work')).toBeGreaterThan(0)
  })

  test('matches the runtime query output sizing path', () => {
    const output = queryGraph(makeGraph(), 'how does authentication work')
    expect(querySubgraphTokens(makeGraph(), 'how does authentication work')).toBe(estimateQueryTokens(output))
  })

  test('returns zero for missing matches', () => {
    expect(querySubgraphTokens(makeGraph(), 'xyzzy plugh zorkmid')).toBe(0)
  })
})

describe('runBenchmark', () => {
  test('returns reduction metrics', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'graphify-out', 'graph.json')
      mkdirSync(join(tempDir, 'graphify-out'), { recursive: true })
      toJson(makeGraph(), { 0: ['n1', 'n2'], 1: ['n3', 'n4'], 2: ['n5'] }, graphPath)
      const result = runBenchmark(graphPath, 10_000)
      expect('reduction_ratio' in result).toBe(true)
      if ('reduction_ratio' in result) {
        expect(result.reduction_ratio).toBeGreaterThan(1)
        expect(result.nodes).toBe(5)
        expect(result.edges).toBe(4)
      }
    })
  })

  test('returns an error for empty graphs', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'graphify-out', 'graph.json')
      mkdirSync(join(tempDir, 'graphify-out'), { recursive: true })
      toJson(new KnowledgeGraph(), {}, graphPath)
      const result = runBenchmark(graphPath, 1_000)
      expect(result).toEqual(expect.objectContaining({ error: expect.stringMatching(/no matching nodes/i) }))
    })
  })

  test('does not emit extraction warnings for exported graph json nodes without source_file', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'graphify-out', 'graph.json')
      mkdirSync(join(tempDir, 'graphify-out'), { recursive: true })

      const graph = new KnowledgeGraph()
      graph.addNode('n1', { label: 'authentication', file_type: 'code', community: 0 })
      graph.addNode('n2', { label: 'api_handler', file_type: 'code', community: 0 })
      graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'EXTRACTED' })
      toJson(graph, { 0: ['n1', 'n2'] }, graphPath)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const result = runBenchmark(graphPath, 1_000, ['how does authentication work'])

      expect('reduction_ratio' in result).toBe(true)
      if ('reduction_ratio' in result) {
        expect(result.structure_signals).toBeNull()
      }
      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })

  test('treats partially-provenanced graph artifacts as unavailable for structure signals', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'graphify-out', 'graph.json')
      mkdirSync(join(tempDir, 'graphify-out'), { recursive: true })

      const graph = new KnowledgeGraph()
      graph.addNode('n1', { label: 'authentication', file_type: 'code', community: 0, source_file: 'auth.ts' })
      graph.addNode('n2', { label: 'api_handler', file_type: 'code', community: 0 })
      graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'auth.ts' })
      toJson(graph, { 0: ['n1', 'n2'] }, graphPath)

      const result = runBenchmark(graphPath, 1_000, ['how does authentication work'])

      expect('reduction_ratio' in result).toBe(true)
      if ('reduction_ratio' in result) {
        expect(result.structure_signals).toBeNull()
      }
    })
  })

  test('returns workspace parity structure signals on the shared entity basis', () => {
    withTempDir((tempDir) => {
      const graphPath = join(tempDir, 'graphify-out', 'graph.json')
      mkdirSync(join(tempDir, 'graphify-out'), { recursive: true })
      toJson(makeWorkspaceGraph(), { 0: ['a', 'b', 'c'], 1: ['d', 'e'], 2: ['f'], 3: ['concept'] }, graphPath)

      const result = runBenchmark(graphPath, 12_000, ['how does authentication work'])

      expect('structure_signals' in result).toBe(true)
      if ('structure_signals' in result) {
        expect(result.structure_signals).toEqual({
          total_nodes: 7,
          total_edges: 4,
          weakly_connected_components: 3,
          singleton_components: 0,
          isolated_nodes: 0,
          largest_component_nodes: 3,
          largest_component_ratio: 3 / 7,
          low_cohesion_communities: 0,
          largest_low_cohesion_community_nodes: 0,
          largest_low_cohesion_community_score: 0,
        })
      }
    })
  })

  test('uses the checked-in mixed-workspace fixture as a reproducible parity baseline', () => {
    withTempDir((tempDir) => {
      const workspaceRoot = copyFixtureCorpus('workspace-parity', tempDir)
      const generation = generateGraph(workspaceRoot, { noHtml: true })
      const benchmark = runBenchmark(generation.graphPath, null, ['create session login'])

      expect('reduction_ratio' in benchmark).toBe(true)
      if (!('reduction_ratio' in benchmark)) {
        return
      }

      expect(generation.totalFiles).toBe(6)
      expect(generation.codeFiles).toBe(5)
      expect(generation.nonCodeFiles).toBe(1)
      expect(benchmark.structure_signals).toEqual({
        total_nodes: 6,
        total_edges: 3,
        weakly_connected_components: 3,
        singleton_components: 2,
        isolated_nodes: 2,
        largest_component_nodes: 4,
        largest_component_ratio: 2 / 3,
        low_cohesion_communities: 0,
        largest_low_cohesion_community_nodes: 0,
        largest_low_cohesion_community_score: 0,
      })

      const report = readFileSync(generation.reportPath, 'utf8')
      expect(report).toContain('## Structure Signals')
      expect(report).toContain('Weakly connected components: 3')
      expect(report).toContain('Singleton components: 2')
      expect(report).toContain('Isolated nodes: 2')
      expect(report).toContain('Largest component: 4 node(s) (67% of the entity graph basis)')
    })
  })

  test('tracks fixture-backed question coverage for the mixed-workspace baseline', () => {
    withTempDir((tempDir) => {
      const workspaceRoot = copyFixtureCorpus('workspace-parity', tempDir)
      const generation = generateGraph(workspaceRoot, { noHtml: true })
      const questions = readWorkspaceParityQuestions()
      const benchmark = runBenchmark(generation.graphPath, null, questions)

      expect('reduction_ratio' in benchmark).toBe(true)
      if (!('reduction_ratio' in benchmark)) {
        return
      }

      expect(benchmark.question_count).toBe(6)
      expect(benchmark.matched_question_count).toBe(5)
      expect(benchmark.unmatched_questions).toEqual(['billing flow'])
      expect(benchmark.expected_label_count).toBe(13)
      expect(benchmark.matched_expected_label_count).toBe(13)
      expect(benchmark.missing_expected_labels).toEqual([])
      expect(benchmark.per_question.map((entry) => entry.question)).toEqual([
        'create session login',
        'login user session',
        'shared auth helper',
        'reindex workspace',
        'workspace architecture docs',
      ])
      expect(benchmark.per_question[0]).toMatchObject({
        question: 'create session login',
        expected_labels: ['default()', 'loginUser()', '.login()'],
        matched_expected_labels: ['default()', 'loginUser()', '.login()'],
        missing_expected_labels: [],
      })
    })
  })
})

describe('printBenchmark', () => {
  test('prints a human readable report', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      nodes: 5,
      edges: 4,
      structure_signals: {
        total_nodes: 5,
        total_edges: 4,
        weakly_connected_components: 2,
        singleton_components: 1,
        isolated_nodes: 1,
        largest_component_nodes: 4,
        largest_component_ratio: 0.8,
        low_cohesion_communities: 1,
        largest_low_cohesion_community_nodes: 15,
        largest_low_cohesion_community_score: 0.14,
      },
      question_count: 6,
      matched_question_count: 5,
      unmatched_questions: ['billing flow'],
      expected_label_count: 2,
      matched_expected_label_count: 1,
      missing_expected_labels: [{ question: 'how does authentication work', labels: ['api_handler'] }],
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 100,
          reduction: 10,
          expected_labels: ['authentication', 'api_handler'],
          matched_expected_labels: ['authentication'],
          missing_expected_labels: ['api_handler'],
        },
      ],
    })
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('Question coverage: 5/6 matched')
    expect(output).toContain('Unmatched: billing flow')
    expect(output).toContain('Expected evidence: 1/2 labels found')
    expect(output).toContain('Missing evidence for how does authentication work: api_handler')
    expect(output).toContain('Structure signals:')
    expect(output).toContain('entity basis: 5 nodes, 4 edges')
    expect(output).toContain('components: 2 weakly connected, 1 singleton, 1 isolated')
    expect(output).toContain('largest component: 4 nodes (80% of entity graph)')
    expect(output).toContain('low cohesion: 1 communities, largest 15 nodes (cohesion 0.14)')
    spy.mockRestore()
  })

  test('prints an unavailable note when structure signals cannot be derived safely', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      nodes: 5,
      edges: 4,
      structure_signals: null,
      question_count: 1,
      matched_question_count: 1,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 100,
          reduction: 10,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
        },
      ],
    })
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('Structure signals: unavailable for graph artifacts without source_file provenance')
    spy.mockRestore()
  })

  test('prints an explicit no-low-cohesion note when no such communities exist', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      nodes: 5,
      edges: 4,
      structure_signals: {
        total_nodes: 5,
        total_edges: 4,
        weakly_connected_components: 2,
        singleton_components: 1,
        isolated_nodes: 1,
        largest_component_nodes: 4,
        largest_component_ratio: 0.8,
        low_cohesion_communities: 0,
        largest_low_cohesion_community_nodes: 0,
        largest_low_cohesion_community_score: 0,
      },
      question_count: 1,
      matched_question_count: 1,
      unmatched_questions: [],
      expected_label_count: 0,
      matched_expected_label_count: 0,
      missing_expected_labels: [],
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [
        {
          question: 'how does authentication work',
          query_tokens: 100,
          reduction: 10,
          expected_labels: [],
          matched_expected_labels: [],
          missing_expected_labels: [],
        },
      ],
    })
    const output = spy.mock.calls.flat().join('\n')
    expect(output).toContain('low cohesion: 0 communities, none on the entity basis')
    spy.mockRestore()
  })
})
