import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { godNodes, suggestQuestions, surprisingConnections } from '../../src/pipeline/analyze.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { cluster, scoreAll } from '../../src/pipeline/cluster.js'
import { generate } from '../../src/pipeline/report.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function makeInputs() {
  const extraction = JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8'))
  const graph = buildFromJson(extraction)
  const communities = cluster(graph)
  const cohesion = scoreAll(graph, communities)
  const labels = Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Community ${communityId}`]))
  const gods = godNodes(graph)
  const surprises = surprisingConnections(graph, communities)
  const questions = suggestQuestions(graph, communities, labels)
  const detection = { total_files: 4, total_words: 62400, needs_graph: true, warning: null }
  const tokens = { input: extraction.input_tokens, output: extraction.output_tokens }

  return { graph, communities, cohesion, labels, gods, surprises, questions, detection, tokens }
}

describe('report', () => {
  it('generates the expected report sections', () => {
    const { graph, communities, cohesion, labels, gods, surprises, questions, detection, tokens } = makeInputs()
    const report = generate(graph, communities, cohesion, labels, gods, surprises, detection, tokens, './project', questions)

    expect(report).toContain('# Graph Report')
    expect(report).toContain('## Corpus Check')
    expect(report).toContain('## God Nodes')
    expect(report).toContain('## Surprising Connections')
    expect(report).toContain('## Communities')
    expect(report).toContain('## Ambiguous Edges')
    expect(report).toContain('## Suggested Questions')
    expect(report).toContain('## Knowledge Gaps')
  })

  it('shows token cost and raw cohesion values', () => {
    const { graph, communities, cohesion, labels, gods, surprises, questions, detection, tokens } = makeInputs()
    const report = generate(graph, communities, cohesion, labels, gods, surprises, detection, tokens, './project', questions)

    expect(report).toContain('Token cost')
    expect(report).toContain('1,200')
    expect(report).toContain('Cohesion:')
    expect(report).not.toContain('✓')
    expect(report).not.toContain('⚠')
  })

  it('renders no-signal suggestions as explanatory prose', () => {
    const { graph, communities, cohesion, labels, gods, surprises, detection, tokens } = makeInputs()
    const report = generate(graph, communities, cohesion, labels, gods, surprises, detection, tokens, './project', [
      { type: 'no_signal', question: null, why: 'Nothing weird here.' },
    ])

    expect(report).toContain('## Suggested Questions')
    expect(report).toContain('Nothing weird here.')
    expect(report).not.toContain('Questions this graph is uniquely positioned to answer')
  })

  it('escapes markdown-sensitive content and reports hyperedges', () => {
    const { graph, communities, cohesion, labels, detection, tokens } = makeInputs()
    const report = generate(
      graph,
      communities,
      cohesion,
      labels,
      [{ id: 'n1', label: '[trap](javascript:alert(1))', edges: 3 }],
      [
        {
          source: '[source](javascript:alert(1))',
          target: '`target`',
          source_files: ['a.md', 'b.md'],
          confidence: 'INFERRED',
          confidence_score: 0.75,
          relation: ']] exploit',
          why: 'Tries to break markdown.',
        },
      ],
      detection,
      tokens,
      './project',
      [],
    )

    graph.graph.hyperedges = [
      {
        id: 'h1',
        label: 'Cross-cutting flow',
        nodes: ['alpha', 'beta', 'gamma'],
        confidence: 'INFERRED',
        confidence_score: 0.9,
      },
    ]

    const hyperedgeReport = generate(graph, communities, cohesion, labels, [], [], detection, tokens, './project', [])

    expect(report).not.toContain('[source](javascript:alert(1))')
    expect(report).toContain('INFERRED 0.75')
    expect(hyperedgeReport).toContain('## Hyperedges (group relationships)')
    expect(hyperedgeReport).toContain('Cross\-cutting flow')
  })
})
