import { buildFromJson } from '../../src/pipeline/build.js'
import { buildCommunityLabels } from '../../src/pipeline/community-naming.js'

describe('buildCommunityLabels', () => {
  it('derives stable semantic labels from dominant directories and file themes', () => {
    const graph = buildFromJson({
      nodes: [
        { id: 'a', label: 'claudeInstall()', file_type: 'code', source_file: '/repo/src/infrastructure/install.ts' },
        { id: 'b', label: 'cursorInstall()', file_type: 'code', source_file: '/repo/src/infrastructure/install.ts' },
        { id: 'c', label: 'toHtml()', file_type: 'code', source_file: '/repo/src/pipeline/export.ts' },
        { id: 'd', label: 'toSvg()', file_type: 'code', source_file: '/repo/src/pipeline/export.ts' },
      ],
      edges: [
        { source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/src/infrastructure/install.ts' },
        { source: 'c', target: 'd', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/src/pipeline/export.ts' },
      ],
    })

    const communities = { 0: ['a', 'b'], 1: ['c', 'd'] }

    expect(buildCommunityLabels(graph, communities, { rootPath: '/repo' })).toEqual({
      0: 'Infrastructure Install',
      1: 'Pipeline Export',
    })
  })

  it('uses a meaningful singleton label when a community has only one member', () => {
    const graph = buildFromJson({
      nodes: [{ id: 'knowledge-graph', label: 'KnowledgeGraph', file_type: 'code', source_file: '/repo/src/contracts/graph.ts' }],
      edges: [],
    })

    expect(buildCommunityLabels(graph, { 0: ['knowledge-graph'] }, { rootPath: '/repo' })).toEqual({
      0: 'Knowledge Graph',
    })
  })

  it('disambiguates duplicate labels with the originating community id suffix', () => {
    const graph = buildFromJson({
      nodes: [
        { id: 'a', label: 'KnowledgeGraph', file_type: 'code', source_file: '/repo/src/contracts/graph.ts' },
        { id: 'b', label: 'KnowledgeGraph', file_type: 'code', source_file: '/repo/src/contracts/graph.ts' },
      ],
      edges: [],
    })

    expect(buildCommunityLabels(graph, { 0: ['a'], 5: ['b'] }, { rootPath: '/repo' })).toEqual({
      0: 'Knowledge Graph',
      5: 'Knowledge Graph (5)',
    })
  })
})
