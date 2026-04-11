import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildFromJson } from '../../src/pipeline/build.js'
import { cluster } from '../../src/pipeline/cluster.js'
import { toCypher, toGraphml, toHtml, toJson, toObsidian } from '../../src/pipeline/export.js'

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
      expect(content).toContain('Group 0')
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
