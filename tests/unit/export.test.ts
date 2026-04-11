import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildFromJson } from '../../src/pipeline/build.js'
import { cluster } from '../../src/pipeline/cluster.js'
import { toCypher, toGraphml, toHtml, toJson, toObsidian, toSvg } from '../../src/pipeline/export.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function makeGraph() {
  return buildFromJson(JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8')))
}

describe('export', () => {
  function withTempDir(callback: (tempDir: string) => void): void {
    const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-export-'))
    try {
      callback(tempDir)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  it('writes valid graph JSON with community annotations', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.json')
      toJson(graph, communities, outputPath)
      const data = JSON.parse(readFileSync(outputPath, 'utf8'))

      expect(Array.isArray(data.nodes)).toBe(true)
      expect(Array.isArray(data.links)).toBe(true)
      for (const node of data.nodes) {
        expect(node).toHaveProperty('community')
      }
    })
  })

  it('writes directed graph JSON metadata and preserves opposite links', () => {
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

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.json')
      toJson(graph, { 0: ['n1', 'n2'] }, outputPath)
      const data = JSON.parse(readFileSync(outputPath, 'utf8'))

      expect(data.directed).toBe(true)
      expect(data.links).toHaveLength(2)
      expect(data.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'n1', target: 'n2', relation: 'calls' }),
          expect.objectContaining({ source: 'n2', target: 'n1', relation: 'returns_to' }),
        ]),
      )
    })
  })

  it('writes cypher with merge statements', () => {
    const graph = makeGraph()

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.cypher')
      toCypher(graph, outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('MERGE')
    })
  })

  it('writes graphml with node and community fields', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.graphml')
      toGraphml(graph, communities, outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('<graphml')
      expect(content).toContain('<node')
      expect(content).toContain('community')
    })
  })

  it('writes directed graphml exports with directed edge defaults', () => {
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

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.graphml')
      toGraphml(graph, { 0: ['n1', 'n2'] }, outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('edgedefault="directed"')
      expect(content).toContain('source="n1" target="n2"')
      expect(content).toContain('source="n2" target="n1"')
    })
  })

  it('writes svg with node labels and community legend content', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.svg')
      toSvg(graph, communities, outputPath, { 0: 'Group 0' })
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('<svg')
      expect(content).toContain('Group 0')
      expect(content).toContain('Transformer')
      expect(content).toContain('<circle')
      expect(content).toContain('<line')
    })
  })

  it('writes html with richer exploration controls and embedded data', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, communities, outputPath, { 0: 'Group 0' })
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('vis-network')
      expect(content.toLowerCase()).toContain('search')
      expect(content).toContain('RAW_NODES')
      expect(content).toContain('RAW_EDGES')
      expect(content).toContain('Selected node')
      expect(content).toContain('Focus neighborhood')
      expect(content).toContain('Communities')
      expect(content).toContain('selectNodeById')
      expect(content).toContain('focusCommunity')
      expect(content).toContain('arrows: EDGE_ARROWS')
      expect(content).toContain('return [...deduped.values()].sort((left, right) => {')
      expect(content).toContain('Group 0')
    })
  })

  it('writes html edge arrow config that matches graph directedness', () => {
    const undirectedGraph = makeGraph()
    const directedGraph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' }],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const undirectedPath = join(tempDir, 'undirected.html')
      const directedPath = join(tempDir, 'directed.html')
      toHtml(undirectedGraph, cluster(undirectedGraph), undirectedPath)
      toHtml(directedGraph, { 0: ['n1', 'n2'] }, directedPath)

      const undirectedContent = readFileSync(undirectedPath, 'utf8')
      const directedContent = readFileSync(directedPath, 'utf8')

      expect(undirectedContent).toContain('const IS_DIRECTED = false;')
      expect(undirectedContent).toContain('const EDGE_ARROWS = {};')
      expect(directedContent).toContain('const IS_DIRECTED = true;')
      expect(directedContent).toContain('const EDGE_ARROWS = {"to":{"enabled":true,"scaleFactor":0.45}};')
    })
  })

  it('writes an Obsidian-style vault with community notes and graph config', () => {
    const graph = makeGraph()
    const communities = cluster(graph)
    const labels = Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Group ${communityId}`]))

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'obsidian')
      const noteCount = toObsidian(graph, communities, outputPath, labels, { 0: 0.75 })
      const files = readdirSync(outputPath)

      expect(noteCount).toBeGreaterThan(0)
      expect(files.some((fileName) => fileName.endsWith('.md'))).toBe(true)
      expect(files.some((fileName) => fileName.startsWith('_COMMUNITY_'))).toBe(true)
      expect(readFileSync(join(outputPath, '.obsidian', 'graph.json'), 'utf8')).toContain('colorGroups')
    })
  })

  it('writes directed Obsidian notes with incoming and outgoing connections', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'Beta', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [
          { source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
          { source: 'n2', target: 'n1', relation: 'returns_to', confidence: 'INFERRED', source_file: 'b.py' },
        ],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'obsidian')
      toObsidian(graph, { 0: ['n1', 'n2'] }, outputPath, { 0: 'Group 0' })

      const note = readFileSync(join(outputPath, 'Alpha.md'), 'utf8')
      expect(note).toContain('→ [[Beta]] - `calls` [EXTRACTED]')
      expect(note).toContain('← [[Beta]] - `returns\\_to` [INFERRED]')
    })
  })

  it('escapes inline-script payloads in html exports', () => {
    const graph = makeGraph()
    graph.addNode('malicious', {
      label: '</script><script>alert("xss")</script>',
      source_file: 'evil.md',
      file_type: 'document',
    })

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, cluster(graph), outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).not.toContain('</script><script>alert("xss")</script>')
      expect(content).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert')
    })
  })
})
