import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { bfs, communitiesFromGraph, dfs, loadGraph, scoreNodes, subgraphToText } from '../../src/runtime/serve.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-serve-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('n1', { label: 'extract', source_file: 'extract.py', source_location: 'L10', community: 0 })
  graph.addNode('n2', { label: 'cluster', source_file: 'cluster.py', source_location: 'L5', community: 0 })
  graph.addNode('n3', { label: 'build', source_file: 'build.py', source_location: 'L1', community: 1 })
  graph.addNode('n4', { label: 'report', source_file: 'report.py', source_location: 'L1', community: 1 })
  graph.addNode('n5', { label: 'isolated', source_file: 'other.py', source_location: 'L1', community: 2 })
  graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'INFERRED' })
  graph.addEdge('n2', 'n3', { relation: 'imports', confidence: 'EXTRACTED' })
  graph.addEdge('n3', 'n4', { relation: 'uses', confidence: 'EXTRACTED' })
  return graph
}

describe('communitiesFromGraph', () => {
  test('reconstructs communities from node attributes', () => {
    const communities = communitiesFromGraph(makeGraph())
    expect(communities[0]).toContain('n1')
    expect(communities[0]).toContain('n2')
    expect(communities[1]).toContain('n3')
    expect(communities[2]).toContain('n5')
  })

  test('ignores nodes without a community attribute', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('a', { label: 'foo' })
    expect(communitiesFromGraph(graph)).toEqual({})
  })
})

describe('scoreNodes', () => {
  test('prefers exact label matches', () => {
    const scored = scoreNodes(makeGraph(), ['extract'])
    expect(scored[0]?.[1]).toBe('n1')
    expect(scored[0]?.[0]).toBeGreaterThan(0)
  })

  test('returns empty list for missing terms', () => {
    expect(scoreNodes(makeGraph(), ['xyzzy'])).toEqual([])
  })

  test('scores partial source file matches at lower weight', () => {
    const scored = scoreNodes(makeGraph(), ['cluster'])
    expect(scored.map(([, id]) => id)).toContain('n2')
  })
})

describe('bfs', () => {
  test('respects traversal depth', () => {
    const { visited } = bfs(makeGraph(), ['n1'], 1)
    expect(visited.has('n1')).toBe(true)
    expect(visited.has('n2')).toBe(true)
    expect(visited.has('n3')).toBe(false)
  })

  test('returns traversed edges', () => {
    const { edges } = bfs(makeGraph(), ['n1'], 1)
    expect(edges.some(([source, target]) => source === 'n1' || target === 'n1')).toBe(true)
  })
})

describe('dfs', () => {
  test('respects traversal depth', () => {
    const { visited } = dfs(makeGraph(), ['n1'], 1)
    expect(visited.has('n1')).toBe(true)
    expect(visited.has('n2')).toBe(true)
    expect(visited.has('n3')).toBe(false)
  })

  test('can walk the full chain', () => {
    const { visited } = dfs(makeGraph(), ['n1'], 5)
    expect(visited.has('n4')).toBe(true)
  })
})

describe('subgraphToText', () => {
  test('includes labels and relations', () => {
    const text = subgraphToText(makeGraph(), new Set(['n1', 'n2']), [['n1', 'n2']])
    expect(text).toContain('extract')
    expect(text).toContain('cluster')
    expect(text).toContain('EDGE')
    expect(text).toContain('calls')
  })

  test('truncates at the token budget', () => {
    const text = subgraphToText(makeGraph(), new Set(['n1', 'n2', 'n3', 'n4']), [['n1', 'n2']], 1)
    expect(text).toContain('truncated')
  })
})

describe('loadGraph', () => {
  test('loads graph json written by the TS exporter format', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'graphify-out')
      const graphPath = join(outDir, 'graph.json')
      mkdirSync(outDir, { recursive: true })
      const graphData = {
        nodes: [
          { id: 'n1', label: 'extract', community: 0, source_file: 'extract.py', file_type: 'code' },
          { id: 'n2', label: 'cluster', community: 0, source_file: 'cluster.py', file_type: 'code' },
        ],
        links: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'extract.py' }],
        hyperedges: [],
      }
      writeFileSync(graphPath, `${JSON.stringify(graphData)}\n`, 'utf8')

      const graph = loadGraph(graphPath)
      expect(graph.numberOfNodes()).toBe(2)
      expect(graph.numberOfEdges()).toBe(1)
    })
  })

  test('throws when the graph file is missing', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'graphify-out')
      expect(() => loadGraph(join(outDir, 'missing.json'))).toThrow(/graph/i)
    })
  })

  test('rejects invalid json content', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'graphify-out')
      const graphPath = join(outDir, 'graph.json')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(graphPath, '{bad-json', 'utf8')
      expect(() => loadGraph(graphPath)).toThrow(/corrupt|json/i)
    })
  })
})
