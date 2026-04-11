import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'

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
})
