import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { startGraphServer } from '../../src/runtime/http-server.js'

function withTempDir<T>(callback: (tempDir: string) => Promise<T> | T): Promise<T> | T {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-http-'))
  const finalize = (): void => {
    rmSync(tempDir, { recursive: true, force: true })
  }

  try {
    const result = callback(tempDir)
    if (result instanceof Promise) {
      return result.finally(finalize)
    }
    finalize()
    return result
  } catch (error) {
    finalize()
    throw error
  }
}

describe('startGraphServer', () => {
  test('serves graph artifacts and runtime query endpoints', async () => {
    await withTempDir(async (tempDir) => {
      const outputDir = join(tempDir, 'graphify-out')
      const graphPath = join(outputDir, 'graph.json')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(
        graphPath,
        `${JSON.stringify({
          nodes: [
            { id: 'n1', label: 'HttpClient', source_file: 'client.ts', file_type: 'code', community: 0 },
            { id: 'n2', label: 'buildHeaders', source_file: 'client.ts', file_type: 'code', community: 0 },
          ],
          links: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'client.ts' }],
          hyperedges: [],
        })}\n`,
        'utf8',
      )
      writeFileSync(join(outputDir, 'GRAPH_REPORT.md'), '# report\n', 'utf8')
      writeFileSync(join(outputDir, 'graph.html'), '<html><body>graph</body></html>\n', 'utf8')

      const handle = await startGraphServer({ graphPath, port: 0 })

      try {
        const health = await fetch(`${handle.url}health`)
        expect(health.status).toBe(200)
        expect(await health.json()).toEqual({ ok: true })

        const stats = await fetch(`${handle.url}stats`)
        expect(stats.status).toBe(200)
        expect(await stats.text()).toContain('Nodes: 2')

        const query = await fetch(`${handle.url}query?q=httpclient`)
        expect(query.status).toBe(200)
        expect(await query.text()).toContain('Traversal: BFS')

        const index = await fetch(handle.url)
        expect(index.status).toBe(200)
        expect(await index.text()).toContain('graph')
      } finally {
        await handle.close()
      }
    })
  })

  test('rejects oversized query parameters with a 400 response', async () => {
    await withTempDir(async (tempDir) => {
      const outputDir = join(tempDir, 'graphify-out')
      const graphPath = join(outputDir, 'graph.json')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(
        graphPath,
        `${JSON.stringify({
          nodes: [{ id: 'n1', label: 'HttpClient', source_file: 'client.ts', file_type: 'code', community: 0 }],
          links: [],
          hyperedges: [],
        })}\n`,
        'utf8',
      )

      const handle = await startGraphServer({ graphPath, port: 0 })

      try {
        const response = await fetch(`${handle.url}query?q=${'x'.repeat(2501)}`)
        expect(response.status).toBe(400)
        expect(await response.text()).toContain('exceeds maximum length')
      } finally {
        await handle.close()
      }
    })
  })
})
