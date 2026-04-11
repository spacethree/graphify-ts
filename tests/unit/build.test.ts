import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { build, buildFromJson } from '../../src/pipeline/build.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function loadExtraction(): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8'))
}

describe('build', () => {
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
})
