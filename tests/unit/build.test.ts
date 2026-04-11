import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { build, buildFromJson } from '../../src/pipeline/build.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function loadExtraction(): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8'))
}

describe('build', () => {
  it('defaults to an undirected graph', () => {
    const graph = buildFromJson(loadExtraction())

    expect(graph.isDirected()).toBe(false)
  })

  it('preserves opposite directions as separate edges in directed mode', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [
          { source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
          { source: 'n2', target: 'n1', relation: 'returns_to', confidence: 'INFERRED', source_file: 'b.py' },
        ],
      },
      { directed: true },
    )

    expect(graph.isDirected()).toBe(true)
    expect(graph.numberOfEdges()).toBe(2)
    expect(graph.neighbors('n1')).toEqual(['n2'])
    expect(graph.neighbors('n2')).toEqual(['n1'])
    expect(graph.edgeAttributes('n1', 'n2').relation).toBe('calls')
    expect(graph.edgeAttributes('n2', 'n1').relation).toBe('returns_to')
  })

  it('keeps undirected builds backward compatible when opposite directions appear', () => {
    const graph = buildFromJson({
      nodes: [
        { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
        { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
      ],
      edges: [
        { source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
        { source: 'n2', target: 'n1', relation: 'returns_to', confidence: 'INFERRED', source_file: 'b.py' },
      ],
    })

    expect(graph.isDirected()).toBe(false)
    expect(graph.numberOfEdges()).toBe(1)
    expect(graph.neighbors('n1')).toEqual(['n2'])
    expect(graph.neighbors('n2')).toEqual(['n1'])
  })

  it('builds the expected node count from extraction json', () => {
    const graph = buildFromJson(loadExtraction())
    expect(graph.numberOfNodes()).toBe(4)
  })

  it('builds the expected edge count from extraction json', () => {
    const graph = buildFromJson(loadExtraction())
    expect(graph.numberOfEdges()).toBe(4)
  })

  it('preserves node labels', () => {
    const graph = buildFromJson(loadExtraction())
    expect(graph.nodeAttributes('n_transformer').label).toBe('Transformer')
  })

  it('preserves inferred edge confidence', () => {
    const graph = buildFromJson(loadExtraction())
    expect(graph.edgeAttributes('n_attention', 'n_concept_attn').confidence).toBe('INFERRED')
  })

  it('preserves ambiguous edge confidence', () => {
    const graph = buildFromJson(loadExtraction())
    expect(graph.edgeAttributes('n_layernorm', 'n_concept_attn').confidence).toBe('AMBIGUOUS')
  })

  it('merges multiple extractions into one graph', () => {
    const graph = build([
      {
        nodes: [{ id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' }],
        edges: [],
        input_tokens: 0,
        output_tokens: 0,
      },
      {
        nodes: [{ id: 'n2', label: 'B', file_type: 'document', source_file: 'b.md' }],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            relation: 'references',
            confidence: 'INFERRED',
            source_file: 'b.md',
            weight: 1.0,
          },
        ],
        input_tokens: 0,
        output_tokens: 0,
      },
    ])

    expect(graph.numberOfNodes()).toBe(2)
    expect(graph.numberOfEdges()).toBe(1)
  })

  it('merges multiple extractions into a directed graph when requested', () => {
    const graph = build(
      [
        {
          nodes: [
            { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
            { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
          ],
          edges: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' }],
          input_tokens: 0,
          output_tokens: 0,
        },
        {
          nodes: [],
          edges: [{ source: 'n2', target: 'n1', relation: 'responds_to', confidence: 'INFERRED', source_file: 'b.py' }],
          input_tokens: 0,
          output_tokens: 0,
        },
      ],
      { directed: true },
    )

    expect(graph.isDirected()).toBe(true)
    expect(graph.numberOfEdges()).toBe(2)
    expect(graph.edgeAttributes('n1', 'n2').relation).toBe('calls')
    expect(graph.edgeAttributes('n2', 'n1').relation).toBe('responds_to')
  })
})
