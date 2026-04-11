import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { _fileCategory, _isConceptNode, _surpriseScore, godNodes, graphDiff, suggestQuestions, surprisingConnections } from '../../src/pipeline/analyze.js'
import { cluster } from '../../src/pipeline/cluster.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function makeGraph(): KnowledgeGraph {
  return buildFromJson(JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8')))
}

function makeSimpleGraph(nodes: Array<[string, string]>, edges: Array<[string, string, string, string]>): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  for (const [nodeId, label] of nodes) {
    graph.addNode(nodeId, { label, source_file: 'test.py', file_type: 'code' })
  }
  for (const [source, target, relation, confidence] of edges) {
    graph.addEdge(source, target, { relation, confidence, source_file: 'test.py' })
  }
  return graph
}

describe('analyze', () => {
  it('returns god nodes sorted by degree', () => {
    const result = godNodes(makeGraph(), 10)
    const degrees = result.map((entry) => entry.edges)
    expect(degrees).toEqual([...degrees].sort((left, right) => right - left))
    expect(result[0]).toHaveProperty('id')
    expect(result[0]).toHaveProperty('label')
    expect(result[0]).toHaveProperty('edges')
  })

  it('finds cross-source surprising connections', () => {
    const graph = makeGraph()
    const communities = cluster(graph)
    const surprises = surprisingConnections(graph, communities)

    expect(surprises.length).toBeGreaterThan(0)
    for (const surprise of surprises) {
      expect(surprise.source_files[0]).not.toBe(surprise.source_files[1])
      expect(typeof surprise.why).toBe('string')
      expect(surprise.why.length).toBeGreaterThan(0)
    }
  })

  it('excludes concept nodes from surprising connections', () => {
    const graph = makeGraph()
    graph.addNode('concept_x', { label: 'Abstract Concept', file_type: 'document', source_file: '' })
    graph.addEdge('n_transformer', 'concept_x', { relation: 'relates_to', confidence: 'INFERRED', source_file: '', weight: 0.5 })

    const surprises = surprisingConnections(graph, cluster(graph))
    const labels = surprises.flatMap((surprise) => [surprise.source, surprise.target])
    expect(labels).not.toContain('Abstract Concept')
  })

  it('uses cross-community bridges for single-source graphs', () => {
    const graph = new KnowledgeGraph()
    for (let index = 0; index < 5; index += 1) {
      graph.addNode(`a${index}`, { label: `A${index}`, file_type: 'code', source_file: 'single.py', source_location: `L${index}` })
      graph.addNode(`b${index}`, { label: `B${index}`, file_type: 'code', source_file: 'single.py', source_location: `L${index + 10}` })
    }
    for (let index = 0; index < 4; index += 1) {
      graph.addEdge(`a${index}`, `a${index + 1}`, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'single.py', weight: 1.0 })
      graph.addEdge(`b${index}`, `b${index + 1}`, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'single.py', weight: 1.0 })
    }
    graph.addEdge('a4', 'b0', { relation: 'references', confidence: 'INFERRED', source_file: 'single.py', weight: 0.5 })

    const surprises = surprisingConnections(graph, cluster(graph))
    expect(surprises.length).toBeGreaterThan(0)
  })

  it('scores ambiguous edges above extracted ones', () => {
    const graph = new KnowledgeGraph()
    for (const [nodeId, label, sourceFile] of [
      ['a', 'Alpha', 'repo1/model.py'],
      ['b', 'Beta', 'repo2/train.py'],
      ['c', 'Gamma', 'repo1/data.py'],
      ['d', 'Delta', 'repo2/eval.py'],
    ] as const) {
      graph.addNode(nodeId, { label, source_file: sourceFile, file_type: 'code' })
    }
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'AMBIGUOUS', weight: 1.0, source_file: 'repo1/model.py' })
    graph.addEdge('c', 'd', { relation: 'calls', confidence: 'EXTRACTED', weight: 1.0, source_file: 'repo1/data.py' })

    const nodeCommunity = { a: 0, c: 0, b: 1, d: 1 }
    const ambiguous = _surpriseScore(graph, 'a', 'b', graph.edgeAttributes('a', 'b'), nodeCommunity, 'repo1/model.py', 'repo2/train.py')
    const extracted = _surpriseScore(graph, 'c', 'd', graph.edgeAttributes('c', 'd'), nodeCommunity, 'repo1/data.py', 'repo2/eval.py')
    expect(ambiguous[0]).toBeGreaterThan(extracted[0])
  })

  it('scores cross-type edges above same-type edges', () => {
    const graph = new KnowledgeGraph()
    for (const [nodeId, label, sourceFile] of [
      ['a', 'Transformer', 'code/model.py'],
      ['b', 'FlashAttn', 'papers/flash.pdf'],
      ['c', 'Trainer', 'code/train.py'],
      ['d', 'Dataset', 'code/data.py'],
    ] as const) {
      graph.addNode(nodeId, { label, source_file: sourceFile, file_type: 'code' })
    }
    graph.addEdge('a', 'b', { relation: 'references', confidence: 'EXTRACTED', weight: 1.0, source_file: 'code/model.py' })
    graph.addEdge('c', 'd', { relation: 'calls', confidence: 'EXTRACTED', weight: 1.0, source_file: 'code/train.py' })

    const nodeCommunity = { a: 0, b: 1, c: 0, d: 0 }
    const crossType = _surpriseScore(graph, 'a', 'b', graph.edgeAttributes('a', 'b'), nodeCommunity, 'code/model.py', 'papers/flash.pdf')
    const sameType = _surpriseScore(graph, 'c', 'd', graph.edgeAttributes('c', 'd'), nodeCommunity, 'code/train.py', 'code/data.py')
    expect(crossType[0]).toBeGreaterThan(sameType[0])
    expect(crossType[1].some((reason) => reason.includes('code') && reason.includes('paper'))).toBe(true)
  })

  it('categorizes file extensions correctly', () => {
    expect(_fileCategory('model.py')).toBe('code')
    expect(_fileCategory('flash.pdf')).toBe('paper')
    expect(_fileCategory('diagram.png')).toBe('image')
    expect(_fileCategory('notes.md')).toBe('doc')
    expect(_fileCategory('app.swift')).toBe('code')
    expect(_fileCategory('plugin.lua')).toBe('code')
    expect(_fileCategory('build.zig')).toBe('code')
  })

  it('identifies concept nodes by missing source files', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('c1', { source_file: '' })
    graph.addNode('n1', { source_file: 'model.py' })

    expect(_isConceptNode(graph, 'c1')).toBe(true)
    expect(_isConceptNode(graph, 'n1')).toBe(false)
  })

  it('reports graph diffs for nodes and edges', () => {
    const oldGraph = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
      ],
      [['n1', 'n2', 'calls', 'EXTRACTED']],
    )
    const newGraph = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
        ['n3', 'Gamma'],
      ],
      [
        ['n1', 'n2', 'calls', 'EXTRACTED'],
        ['n2', 'n3', 'uses', 'INFERRED'],
      ],
    )

    const diff = graphDiff(oldGraph, newGraph)

    expect(diff.new_nodes).toHaveLength(1)
    expect(diff.new_nodes[0]?.id).toBe('n3')
    expect(diff.new_edges).toHaveLength(1)
    expect(diff.new_edges[0]?.relation).toBe('uses')
    expect(diff.summary).toContain('new node')
    expect(diff.summary).toContain('new edge')
  })

  it('reports no changes for identical graphs', () => {
    const graphA = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
      ],
      [['n1', 'n2', 'calls', 'EXTRACTED']],
    )
    const graphB = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
      ],
      [['n1', 'n2', 'calls', 'EXTRACTED']],
    )

    expect(graphDiff(graphA, graphB).summary).toBe('no changes')
  })

  it('generates suggested questions from graph signals', () => {
    const graph = new KnowledgeGraph()
    for (const [nodeId, label, sourceFile] of [
      ['a1', 'Alpha One', 'alpha.py'],
      ['a2', 'Alpha Two', 'alpha.py'],
      ['a3', 'Alpha Three', 'alpha.py'],
      ['a4', 'Alpha Four', 'alpha.py'],
      ['a5', 'Alpha Five', 'alpha.py'],
      ['b1', 'Beta One', 'beta.py'],
      ['b2', 'Beta Two', 'beta.py'],
      ['b3', 'Beta Three', 'beta.py'],
      ['b4', 'Beta Four', 'beta.py'],
      ['b5', 'Beta Five', 'beta.py'],
      ['bridge', 'Bridge Layer', 'shared.py'],
      ['loner', 'Lone Node', 'loner.py'],
      ['c1', 'Gamma One', 'gamma.py'],
      ['c2', 'Gamma Two', 'gamma.py'],
      ['c3', 'Gamma Three', 'gamma.py'],
      ['c4', 'Gamma Four', 'gamma.py'],
      ['c5', 'Gamma Five', 'gamma.py'],
    ] as const) {
      graph.addNode(nodeId, { label, source_file: sourceFile, file_type: 'code' })
    }

    for (const [source, target, relation, confidence] of [
      ['a1', 'a2', 'calls', 'EXTRACTED'],
      ['a2', 'a3', 'calls', 'EXTRACTED'],
      ['a3', 'a4', 'calls', 'EXTRACTED'],
      ['a4', 'a5', 'calls', 'EXTRACTED'],
      ['b1', 'b2', 'calls', 'EXTRACTED'],
      ['b2', 'b3', 'calls', 'EXTRACTED'],
      ['b3', 'b4', 'calls', 'EXTRACTED'],
      ['b4', 'b5', 'calls', 'EXTRACTED'],
      ['a3', 'bridge', 'calls', 'EXTRACTED'],
      ['bridge', 'b3', 'calls', 'EXTRACTED'],
      ['bridge', 'a5', 'explains', 'INFERRED'],
      ['bridge', 'b5', 'explains', 'INFERRED'],
      ['a1', 'b1', 'relates_to', 'AMBIGUOUS'],
      ['c1', 'c2', 'calls', 'EXTRACTED'],
    ] as const) {
      graph.addEdge(source, target, { relation, confidence, source_file: 'test.py' })
    }

    const questions = suggestQuestions(
      graph,
      {
        0: ['a1', 'a2', 'a3', 'a4', 'a5'],
        1: ['b1', 'b2', 'b3', 'b4', 'b5'],
        2: ['bridge'],
        3: ['c1', 'c2', 'c3', 'c4', 'c5'],
      },
      {
        0: 'Alpha',
        1: 'Beta',
        2: 'Bridge',
        3: 'Gamma',
      },
      10,
    )

    const questionTypes = new Set(questions.map((question) => question.type))
    expect(questionTypes.has('ambiguous_edge')).toBe(true)
    expect(questionTypes.has('bridge_node')).toBe(true)
    expect(questionTypes.has('verify_inferred')).toBe(true)
    expect(questionTypes.has('isolated_nodes')).toBe(true)
    expect(questionTypes.has('low_cohesion')).toBe(true)
  })

  it('returns a no-signal fallback when the graph is too clean', () => {
    const graph = new KnowledgeGraph()
    for (const [nodeId, label] of [
      ['n1', 'One'],
      ['n2', 'Two'],
      ['n3', 'Three'],
      ['n4', 'Four'],
    ] as const) {
      graph.addNode(nodeId, { label, source_file: 'clean.py', file_type: 'code' })
    }
    for (const [source, target] of [
      ['n1', 'n2'],
      ['n1', 'n3'],
      ['n1', 'n4'],
      ['n2', 'n3'],
      ['n2', 'n4'],
      ['n3', 'n4'],
    ] as const) {
      graph.addEdge(source, target, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'clean.py' })
    }

    expect(suggestQuestions(graph, { 0: ['n1', 'n2', 'n3', 'n4'] }, { 0: 'Clean' })).toEqual([expect.objectContaining({ type: 'no_signal', question: null })])
  })
})
