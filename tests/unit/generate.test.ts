import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  test('writes and reloads directed graphs when requested', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return helper()\n\ndef helper():\n    return 1\n', 'utf8')

      const result = generateGraph(tempDir, { directed: true, noHtml: true })
      const graph = loadGraph(result.graphPath)

      expect(graph.isDirected()).toBe(true)
    })
  })
})
