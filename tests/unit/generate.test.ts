import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'

function withTempDir<T>(callback: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-generate-'))
  try {
    return callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function withTempDirAsync<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-generate-'))
  try {
    return await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('generateGraph', () => {
  test('builds graph artifacts for a code corpus', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return 1\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# Notes\nSee [Guide](guide.md)\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'graphify-out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.mode).toBe('generate')
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(result.edgeCount).toBeGreaterThan(0)
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'GRAPH_REPORT.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.html'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'manifest.json'))).toBe(true)
      expect(readFileSync(join(tempDir, 'graphify-out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## God Nodes')
      expect(result.notes.join('\n')).not.toContain('semantic extraction')
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
    })
  })

  test('builds graph artifacts for a docs-and-images corpus without code', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'README.md'), '# Overview\n![Diagram](diagram.svg)\nSee [Guide](guide.md)\n## Details\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')
      writeFileSync(join(tempDir, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>Diagram</title></svg>', 'utf8')

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'graphify-out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.codeFiles).toBe(0)
      expect(result.nonCodeFiles).toBeGreaterThan(0)
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(result.notes.join('\n')).not.toContain('semantic extraction')
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
      expect(graphData.nodes.some((node) => node.file_type === 'image')).toBe(true)
    })
  })

  test('includes saved memory notes from graphify-out/memory with frontmatter metadata and references', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'auth.ts'), 'export function authenticate() {\n  return true\n}\n', 'utf8')
      mkdirSync(join(tempDir, 'graphify-out', 'memory'), { recursive: true })
      writeFileSync(
        join(tempDir, 'graphify-out', 'memory', 'query_auth.md'),
        [
          '---',
          'title: "Auth result"',
          'source_url: "https://example.com/auth"',
          'captured_at: "2026-04-11T00:00:00Z"',
          'source_nodes: ["authenticate()"]',
          '---',
          '',
          '# Q: How does auth work?',
          '',
          '## Answer',
          '',
          'Authentication starts in authenticate().',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
      }
      const noteNode = graphData.nodes.find((node) => node.label === 'query_auth.md')
      const authNode = graphData.nodes.find((node) => node.label === 'authenticate()')

      expect(noteNode).toMatchObject({
        title: 'Auth result',
        source_url: 'https://example.com/auth',
        captured_at: '2026-04-11T00:00:00Z',
      })
      expect(authNode).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === noteNode?.id && edge.target === authNode?.id && edge.relation === 'references')).toBe(true)
    })
  })

  test('supports cluster-only regeneration from an existing graph', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def greet():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      const result = generateGraph(tempDir, { clusterOnly: true })

      expect(result.mode).toBe('cluster-only')
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(readFileSync(join(tempDir, 'graphify-out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## Communities')
    })
  })

  test('tracks incremental update changes after a manifest exists', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      writeFileSync(sourcePath, 'def greet():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return 2\n\ndef other():\n    return greet()\n', 'utf8')

      const result = generateGraph(tempDir, { update: true })

      expect(result.mode).toBe('update')
      expect(result.changedFiles).toBeGreaterThan(0)
      expect(result.deletedFiles).toBe(0)
      expect(existsSync(join(tempDir, 'graphify-out', 'manifest.json'))).toBe(true)
    })
  })

  test('re-extracts only changed files during update while retaining unchanged graph context', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      const helperPath = join(tempDir, 'helper.py')
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n', 'utf8')
      writeFileSync(helperPath, 'def helper():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n\ndef other():\n    return greet()\n', 'utf8')

      vi.resetModules()
      const actualExtractModule = await vi.importActual<typeof import('../../src/pipeline/extract.js')>('../../src/pipeline/extract.js')
      const extractSpy = vi.fn(actualExtractModule.extract)
      vi.doMock('../../src/pipeline/extract.js', () => ({
        ...actualExtractModule,
        extract: extractSpy,
      }))

      try {
        const generateModule = await import('../../src/infrastructure/generate.js')
        const result = generateModule.generateGraph(tempDir, { update: true, noHtml: true })
        const graph = loadGraph(result.graphPath)

        expect(extractSpy).toHaveBeenCalledTimes(1)
        expect(extractSpy.mock.calls[0]?.[0]).toEqual([sourcePath])
        expect(graph.nodeEntries().some(([, attributes]) => attributes.label === 'helper()')).toBe(true)
        expect(graph.nodeEntries().some(([, attributes]) => attributes.label === 'other()')).toBe(true)
      } finally {
        vi.doUnmock('../../src/pipeline/extract.js')
        vi.resetModules()
      }
    })
  })

  test('writes optional wiki, obsidian, svg, graphml, and cypher artifacts when requested', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return 1\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# Notes\nSee [Guide](guide.md)\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')

      const obsidianDir = join(tempDir, 'vault')
      const result = generateGraph(tempDir, {
        wiki: true,
        obsidian: true,
        obsidianDir,
        svg: true,
        graphml: true,
        neo4j: true,
      })

      expect(existsSync(join(tempDir, 'graphify-out', 'wiki', 'index.md'))).toBe(true)
      expect(existsSync(join(obsidianDir, '.obsidian', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.svg'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.graphml'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'cypher.txt'))).toBe(true)
      expect(result.wikiPath).toBe(join(tempDir, 'graphify-out', 'wiki'))
      expect(result.obsidianPath).toBe(obsidianDir)
      expect(result.svgPath).toBe(join(tempDir, 'graphify-out', 'graph.svg'))
      expect(result.graphmlPath).toBe(join(tempDir, 'graphify-out', 'graph.graphml'))
      expect(result.cypherPath).toBe(join(tempDir, 'graphify-out', 'cypher.txt'))
    })
  })

  test('generates semantic community labels in reports and graph json metadata', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'src', 'infrastructure'), { recursive: true })
      mkdirSync(join(tempDir, 'src', 'pipeline'), { recursive: true })
      writeFileSync(
        join(tempDir, 'src', 'infrastructure', 'install.ts'),
        'export function claudeInstall() { return ensureArray() }\nexport function ensureArray() { return [] }\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'src', 'pipeline', 'export.ts'), 'export function toHtml() { return toSvg() }\nexport function toSvg() { return 1 }\n', 'utf8')

      const result = generateGraph(tempDir, { noHtml: true })
      const report = readFileSync(result.reportPath, 'utf8')
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        community_labels?: Record<string, string>
      }

      expect(report).toContain('Infrastructure Install')
      expect(report).toContain('Pipeline Export')
      expect(report).not.toContain('Community 0 - "Community 0"')
      expect(graphData.community_labels).toMatchObject({
        0: expect.any(String),
      })
      expect(Object.values(graphData.community_labels ?? {})).toEqual(expect.arrayContaining(['Infrastructure Install', 'Pipeline Export']))
    })
  })

  test('propagates forced overview html mode through generateGraph', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'src', 'infrastructure'), { recursive: true })
      mkdirSync(join(tempDir, 'src', 'pipeline'), { recursive: true })
      writeFileSync(
        join(tempDir, 'src', 'infrastructure', 'install.ts'),
        'export function claudeInstall() { return ensureArray() }\nexport function ensureArray() { return [] }\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'src', 'pipeline', 'export.ts'), 'export function toHtml() { return toSvg() }\nexport function toSvg() { return 1 }\n', 'utf8')

      const result = generateGraph(tempDir, { htmlMode: 'overview' })
      expect(result.htmlPath).not.toBeNull()
      if (!result.htmlPath) {
        throw new Error('Expected htmlPath to be written when HTML export is enabled')
      }

      const overview = readFileSync(result.htmlPath, 'utf8')

      expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining('Large graph mode enabled')]))
      expect(overview).toContain('Overview-first large-graph mode')
      expect(readFileSync(join(tempDir, 'graphify-out', 'graph-pages', 'community-0.html'), 'utf8')).toContain('Back to overview')
    })
  })

  test('writes and reloads directed graphs when requested', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return helper()\n\ndef helper():\n    return 1\n', 'utf8')

      const result = generateGraph(tempDir, { directed: true, noHtml: true })
      const graph = loadGraph(result.graphPath)

      expect(graph.isDirected()).toBe(true)
    })
  })
})
