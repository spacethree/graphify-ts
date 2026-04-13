import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { detectUrlType, ingest, saveQueryResult } from '../../src/infrastructure/ingest.js'

async function withTempDir(callback: (tempDir: string) => void | Promise<void>): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-ingest-'))
  try {
    await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saveQueryResult', () => {
  test('creates a markdown file with frontmatter and answer body', () => {
    return withTempDir((tempDir) => {
      const output = saveQueryResult('what is attention?', 'Attention is softmax.', join(tempDir, 'memory'))
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('question:')
      expect(content).toContain('Attention is softmax.')
      expect(output.endsWith('.md')).toBe(true)
    })
  })

  test('stores query type and capped source nodes', () => {
    return withTempDir((tempDir) => {
      const output = saveQueryResult('q', 'a', join(tempDir, 'memory'), {
        queryType: 'path_query',
        sourceNodes: Array.from({ length: 20 }, (_, index) => `Node${index}`),
      })
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('type: "path_query"')
      const line = content.split('\n').find((entry) => entry.startsWith('source_nodes:'))
      expect(line?.match(/"Node/g)?.length ?? 0).toBe(10)
    })
  })
})

describe('detectUrlType', () => {
  test('classifies supported url shapes', () => {
    expect(detectUrlType('https://x.com/user/status/1')).toBe('tweet')
    expect(detectUrlType('https://arxiv.org/abs/1706.03762')).toBe('arxiv')
    expect(detectUrlType('https://example.com/file.pdf')).toBe('pdf')
    expect(detectUrlType('https://example.com/diagram.png')).toBe('image')
    expect(detectUrlType('https://example.com/post')).toBe('webpage')
  })
})

describe('ingest', () => {
  test('saves webpages as annotated markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html><head><title>Example Page</title></head><body><h1>Hello</h1><p>World</p></body></html>', { status: 200 })),
      )

      const output = await ingest('https://example.com/post', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')
      expect(content).toContain('type: webpage')
      expect(content).toContain('Example Page')
      expect(content).toContain('Source: https://example.com/post')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves tweets as flat annotated markdown without nested provenance', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toContain('publish.twitter.com/oembed?url=')
          return new Response(JSON.stringify({ html: '<blockquote>Graph edges everywhere</blockquote>', author_name: 'Graphify Bot' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest('https://x.com/graphify/status/1', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://x.com/graphify/status/1"')
      expect(content).toContain('author: "Graphify Bot"')
      expect(content).toContain('contributor: "graphify-ts"')
      expect(content).toContain('# Tweet by @Graphify Bot')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves arxiv papers as flat annotated markdown without nested provenance', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://export.arxiv.org/abs/1706.03762')
          return new Response(
            [
              '<html>',
              '<h1 class="title mathjax">Attention Is All You Need</h1>',
              '<div class="authors">Ashish Vaswani</div>',
              '<blockquote class="abstract mathjax">Sequence modeling with attention.</blockquote>',
              '</html>',
            ].join(''),
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          )
        }),
      )

      const output = await ingest('https://arxiv.org/abs/1706.03762', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: paper')
      expect(content).toContain('source_url: "https://arxiv.org/abs/1706.03762"')
      expect(content).toContain('arxiv_id: "1706.03762"')
      expect(content).toContain('title: "Attention Is All You Need"')
      expect(content).toContain('paper_authors: "Ashish Vaswani"')
      expect(content).toContain('contributor: "graphify-ts"')
      expect(content).not.toContain('provenance:')
    })
  })

  test('downloads binary assets directly', async () => {
    await withTempDir(async (tempDir) => {
      const payload = Uint8Array.from([1, 2, 3, 4])
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(payload, { status: 200 })),
      )

      const output = await ingest('https://example.com/file.pdf', join(tempDir, 'raw'))
      expect(output.endsWith('.pdf')).toBe(true)
      expect(readFileSync(output)).toEqual(Buffer.from(payload))
    })
  })

  test('rejects disallowed urls', async () => {
    await withTempDir(async (tempDir) => {
      await expect(ingest('file:///etc/passwd', join(tempDir, 'raw'))).rejects.toThrow(/file/i)
    })
  })
})
