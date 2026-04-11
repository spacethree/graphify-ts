import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runBenchmark, printBenchmark, querySubgraphTokens } from '../../src/infrastructure/benchmark.js'
import { toJson } from '../../src/pipeline/export.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-benchmark-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
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

describe('querySubgraphTokens', () => {
  test('returns positive tokens for matching questions', () => {
    expect(querySubgraphTokens(makeGraph(), 'how does authentication work')).toBeGreaterThan(0)
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
})

describe('printBenchmark', () => {
  test('prints a human readable report', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    printBenchmark({
      corpus_tokens: 1000,
      corpus_words: 750,
      nodes: 5,
      edges: 4,
      avg_query_tokens: 100,
      reduction_ratio: 10,
      per_question: [{ question: 'how does authentication work', query_tokens: 100, reduction: 10 }],
    })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
