import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

function binaryIngestSidecarPath(assetPath: string): string {
  return join(dirname(assetPath), `.${basename(assetPath)}.graphify-ingest.json`)
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
    expect(detectUrlType('https://notx.com/user/status/1')).toBe('webpage')
    expect(detectUrlType('https://x.com/home')).toBe('webpage')
    expect(detectUrlType('https://twitter.com/explore')).toBe('webpage')
    expect(detectUrlType('https://x.com/user/status/1/photo/1')).toBe('webpage')
    expect(detectUrlType('https://twitter.com/i/web/status/1/analytics')).toBe('webpage')
    expect(detectUrlType('https://twitter.com/i/status/1')).toBe('webpage')
    expect(detectUrlType('https://x.com/user/status/not-a-post-id')).toBe('webpage')
    expect(detectUrlType('https://arxiv.org/abs/1706.03762')).toBe('arxiv')
    expect(detectUrlType('https://github.com/mohanagy/graphify-ts')).toBe('github')
    expect(detectUrlType('https://notgithub.com/mohanagy/graphify-ts')).toBe('webpage')
    expect(detectUrlType('https://old.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/?utm_source=share')).toBe('reddit')
    expect(detectUrlType('https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/jkl456/?context=3')).toBe('reddit')
    expect(detectUrlType('https://redd.it/abc123')).toBe('reddit')
    expect(detectUrlType('https://www.reddit.com/comments/abc123?utm_source=share')).toBe('reddit')
    expect(detectUrlType('https://notreddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/graphify/about')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/graphify/comments/abc123/.json')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/graphify/comments/abc123/.json/')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/jkl456/.json')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/jkl456/more')).toBe('webpage')
    expect(detectUrlType('https://redd.it/abc123.json')).toBe('webpage')
    expect(detectUrlType('https://www.reddit.com/comments/abc123/more')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube')
    expect(detectUrlType('https://youtu.be/dQw4w9WgXcQ?si=graphify')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share')).toBe('youtube')
    expect(detectUrlType('https://www.youtube.com/embed/dQw4w9WgXcQ?start=30')).toBe('youtube')
    expect(detectUrlType('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/playlist?list=PLgraphify')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/shorts/dQw4w9WgXcQ/clips')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/embed/dQw4w9WgXcQ/live_chat')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/shorts/short')).toBe('webpage')
    expect(detectUrlType('https://www.youtube.com/watch?v=short')).toBe('webpage')
    expect(detectUrlType('https://example.com/file.pdf')).toBe('pdf')
    expect(detectUrlType('https://example.com/diagram.png')).toBe('image')
    expect(detectUrlType('https://example.com/post')).toBe('webpage')
  })
})

describe('ingest', () => {
  function readIngestFixture(name: string): string {
    return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ingest', name), 'utf8')
  }

  function stubHtmlFetch(html: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
    )
  }

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
      expect(existsSync(binaryIngestSidecarPath(output))).toBe(false)
    })
  })

  test('captures structured article metadata and sections for generic webpage ingest', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('webpage-article.html'))

      const output = await ingest('https://example.com/articles/structured-graphs?utm_source=test', join(tempDir, 'raw'), {
        contributor: 'graphify-ts',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('source_url: "https://example.com/articles/structured-graphs"')
      expect(content).toContain('author: "Ada Lovelace"')
      expect(content).toContain('description: "Deterministic article ingestion for graphify-ts."')
      expect(content).toContain(
        'outbound_links: ["https://example.com/docs/schema", "https://external.example.com/guide", "https://example.com/blog/provenance"]',
      )
      expect(content).toContain('# Structured Graph Ingestion')
      expect(content).toContain('## Summary')
      expect(content).toContain('## Overview')
      expect(content).toContain('[schema metadata](https://example.com/docs/schema)')
      expect(content).toContain('## Further Reading')
      expect(content).toContain('[this guide](https://external.example.com/guide)')
      expect(content).toContain('[provenance notes](https://example.com/blog/provenance)')
      expect(content).toContain('## Outbound Links')
      expect(content).not.toContain('mailto:hello@example.com')
      expect(content).not.toContain('Source: https://example.com/articles/structured-graphs?utm_source=test')
    })
  })

  test('saves GitHub repository URLs as structured repository markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-repository.html'))

      const output = await ingest('https://github.com/mohanagy/graphify-ts?tab=readme', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_repository')
      expect(content).toContain('source_url: "https://github.com/mohanagy/graphify-ts"')
      expect(content).toContain('github_kind: "repository"')
      expect(content).toContain('github_owner: "mohanagy"')
      expect(content).toContain('github_repo: "graphify-ts"')
      expect(content).toContain('github_topics: ["typescript", "knowledge-graph"]')
      expect(content).toContain('contributor: "graphify-ts"')
      expect(content).toContain('# GitHub Repository: mohanagy/graphify-ts')
      expect(content).toContain('## About')
      expect(content).toContain('TypeScript-native graph extraction for code and docs.')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves GitHub issue URLs as structured issue markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-issue.html'))

      const output = await ingest('https://github.com/mohanagy/graphify-ts/issues/123', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_issue')
      expect(content).toContain('source_url: "https://github.com/mohanagy/graphify-ts/issues/123"')
      expect(content).toContain('github_kind: "issue"')
      expect(content).toContain('github_owner: "mohanagy"')
      expect(content).toContain('github_repo: "graphify-ts"')
      expect(content).toContain('github_number: "123"')
      expect(content).toContain('github_state: "open"')
      expect(content).toContain('github_labels: ["bug", "triage"]')
      expect(content).toContain('author: "octocat"')
      expect(content).toContain('# GitHub Issue #123: Parser crashes on sidecar fallback')
      expect(content).toContain('## Body')
      expect(content).toContain('Hidden DOCX sidecars should still lift metadata on fallback.')
    })
  })

  test('preserves GitHub issue body text when the issue body contains nested div wrappers', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-issue-nested-body.html'))

      const output = await ingest('https://github.com/mohanagy/graphify-ts/issues/321', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('Before code block.')
      expect(content).toContain('const value = 1')
      expect(content).toContain('After code block.')
    })
  })

  test('saves GitHub pull request URLs as structured pull request markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-pull-request.html'))

      const output = await ingest('https://github.com/mohanagy/graphify-ts/pull/456', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_pull_request')
      expect(content).toContain('source_url: "https://github.com/mohanagy/graphify-ts/pull/456"')
      expect(content).toContain('github_kind: "pull_request"')
      expect(content).toContain('github_number: "456"')
      expect(content).toContain('github_state: "merged"')
      expect(content).toContain('github_labels: ["enhancement", "tests"]')
      expect(content).toContain('author: "graphify-maintainer"')
      expect(content).toContain('# GitHub Pull Request #456: Add structured GitHub ingest')
      expect(content).toContain('This adds route-aware GitHub ingestion without changing non-GitHub handlers.')
    })
  })

  test('saves GitHub discussion URLs as structured discussion markdown', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(readIngestFixture('github-discussion.html'))

      const output = await ingest('https://github.com/mohanagy/graphify-ts/discussions/789', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: github_discussion')
      expect(content).toContain('source_url: "https://github.com/mohanagy/graphify-ts/discussions/789"')
      expect(content).toContain('github_kind: "discussion"')
      expect(content).toContain('github_number: "789"')
      expect(content).toContain('github_state: "open"')
      expect(content).toContain('github_category: "Ideas"')
      expect(content).toContain('author: "mohanagy"')
      expect(content).toContain('# GitHub Discussion #789: Roadmap for structured GitHub ingest')
      expect(content).toContain('Capture repository, issue, pull request, and discussion context as first-class markdown sections.')
    })
  })

  test('falls back to generic webpage capture for unsupported GitHub page kinds', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch('<html><head><title>Commit abc123</title></head><body><p>Generic commit page.</p></body></html>')

      const output = await ingest('https://github.com/mohanagy/graphify-ts/commit/abc123', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('Source: https://github.com/mohanagy/graphify-ts/commit/abc123')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('falls back to generic webpage capture for non-repository github.com top-level routes', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>GitHub Copilot</title><link rel="canonical" href="https://github.com/features/copilot" /></head><body><main><h1>GitHub Copilot</h1><p>Build faster.</p></main></body></html>',
      )

      const output = await ingest('https://github.com/features/copilot', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('Source: https://github.com/features/copilot')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('falls back to generic webpage capture when fetched GitHub HTML resolves to an interstitial page', async () => {
    await withTempDir(async (tempDir) => {
      stubHtmlFetch(
        '<html><head><title>Sign in to GitHub</title><link rel="canonical" href="https://github.com/login" /></head><body><main><p>Sign in to continue.</p></main></body></html>',
      )

      const output = await ingest('https://github.com/mohanagy/graphify-ts/issues/999', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: webpage')
      expect(content).toContain('source_url: "https://github.com/login"')
      expect(content).not.toContain('github_kind:')
    })
  })

  test('saves Reddit thread URLs as structured thread markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe(
            'https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update.json?limit=3&depth=1&raw_json=1',
          )
          return new Response(readIngestFixture('reddit-thread.json'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest(
        'https://old.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/?utm_source=share',
        join(tempDir, 'raw'),
        { contributor: 'graphify-ts' },
      )
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update"')
      expect(content).toContain('title: "Structured ingest roadmap update"')
      expect(content).toContain('author: "graph_builder"')
      expect(content).toContain('contributor: "graphify-ts"')
      expect(content).toContain('reddit_subreddit: "graphify"')
      expect(content).toContain('reddit_post_id: "abc123"')
      expect(content).toContain('reddit_score: "128"')
      expect(content).toContain('reddit_comment_count: "42"')
      expect(content).toContain('reddit_capture_status: "json"')
      expect(content).toContain('# Reddit Thread: Structured ingest roadmap update')
      expect(content).toContain('## Post')
      expect(content).toContain('Graphify-ts now captures richer structured inputs.')
      expect(content).toContain('## Thread Highlights')
      expect(content).toContain('### Comment by u/helper_bot')
      expect(content).toContain('Nice direction. Capture fallback boundaries explicitly.')
      expect(content).toContain('### Comment by u/schema_fan')
      expect(content).toContain('The capability registry work is paying off.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/graphify')
      expect(content).toContain('- Post ID: abc123')
      expect(content).toContain('- Score: 128')
      expect(content).toContain('- Comment Count: 42')
      expect(content).toContain('- Capture Status: json')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update)')
      expect(content).toContain('[Linked URL](https://github.com/mohanagy/graphify-ts)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('saves Reddit short thread URLs as structured thread markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe('https://www.reddit.com/comments/abc123.json?limit=3&depth=1&raw_json=1')
          return new Response(readIngestFixture('reddit-thread.json'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest('https://redd.it/abc123', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('reddit_graphify_abc123.md')
      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update"')
      expect(content).toContain('title: "Structured ingest roadmap update"')
      expect(content).toContain('author: "graph_builder"')
      expect(content).toContain('reddit_subreddit: "graphify"')
      expect(content).toContain('reddit_post_id: "abc123"')
      expect(content).toContain('reddit_capture_status: "json"')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update)')
      expect(content).toContain('[Linked URL](https://github.com/mohanagy/graphify-ts)')
    })
  })

  test('saves Reddit comment permalink URLs as structured comment markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe(
            'https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/jkl456.json?limit=3&depth=1&raw_json=1',
          )
          return new Response(readIngestFixture('reddit-comment.json'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest(
        'https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/jkl456/?context=3',
        join(tempDir, 'raw'),
        { contributor: 'graphify-ts' },
      )
      const content = readFileSync(output, 'utf8')

      expect(basename(output)).toBe('reddit_graphify_abc123_jkl456.md')
      expect(content).toContain('type: reddit_comment')
      expect(content).toContain('source_url: "https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/jkl456"')
      expect(content).toContain('title: "Comment on: Structured ingest roadmap update"')
      expect(content).toContain('author: "helper_bot"')
      expect(content).toContain('contributor: "graphify-ts"')
      expect(content).toContain('reddit_subreddit: "graphify"')
      expect(content).toContain('reddit_post_id: "abc123"')
      expect(content).toContain('reddit_comment_id: "jkl456"')
      expect(content).toContain('reddit_comment_score: "30"')
      expect(content).toContain('reddit_capture_status: "json"')
      expect(content).toContain('# Reddit Comment: Structured ingest roadmap update')
      expect(content).toContain('## Comment')
      expect(content).toContain('Nice direction. Capture fallback boundaries explicitly.')
      expect(content).toContain('## Thread')
      expect(content).toContain('Graphify-ts now captures richer structured inputs.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/graphify')
      expect(content).toContain('- Post ID: abc123')
      expect(content).toContain('- Comment ID: jkl456')
      expect(content).toContain('- Thread Author: graph_builder')
      expect(content).toContain('- Comment Score: 30')
      expect(content).toContain('- Thread Score: 128')
      expect(content).toContain('- Comment Count: 42')
      expect(content).toContain('- Capture Status: json')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Comment](https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update/jkl456)')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/graphify/comments/abc123/structured_ingest_roadmap_update)')
      expect(content).toContain('[Linked URL](https://github.com/mohanagy/graphify-ts)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes reddit thread fallback behavior explicit when thread JSON fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.reddit.com/r/graphify/comments/def456/social_thread_roadmap/?utm_source=share', join(tempDir, 'raw'), {
        contributor: 'graphify-ts',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/r/graphify/comments/def456/social_thread_roadmap"')
      expect(content).toContain('title: "Reddit Thread: def456"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('reddit_subreddit: "graphify"')
      expect(content).toContain('reddit_post_id: "def456"')
      expect(content).toContain('reddit_capture_status: "fallback"')
      expect(content).toContain('## Post')
      expect(content).toContain('Reddit thread metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/graphify')
      expect(content).toContain('- Post ID: def456')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: thread JSON unavailable; preserved canonical thread URL and derived Reddit metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/graphify/comments/def456/social_thread_roadmap)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes reddit short thread fallback behavior explicit when thread JSON fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.reddit.com/comments/def456?utm_source=share', join(tempDir, 'raw'), {
        contributor: 'graphify-ts',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_thread')
      expect(content).toContain('source_url: "https://www.reddit.com/comments/def456"')
      expect(content).toContain('title: "Reddit Thread: def456"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('reddit_post_id: "def456"')
      expect(content).not.toContain('reddit_subreddit:')
      expect(content).toContain('reddit_capture_status: "fallback"')
      expect(content).toContain('## Post')
      expect(content).toContain('Reddit thread metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).not.toContain('- Subreddit: ')
      expect(content).toContain('- Post ID: def456')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: thread JSON unavailable; preserved canonical thread URL and derived Reddit metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Thread](https://www.reddit.com/comments/def456)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes reddit comment fallback behavior explicit when comment JSON fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.reddit.com/r/graphify/comments/def456/social_thread_roadmap/jkl456/?context=3', join(tempDir, 'raw'), {
        contributor: 'graphify-ts',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: reddit_comment')
      expect(content).toContain('source_url: "https://www.reddit.com/r/graphify/comments/def456/social_thread_roadmap/jkl456"')
      expect(content).toContain('title: "Reddit Comment: def456/jkl456"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('reddit_subreddit: "graphify"')
      expect(content).toContain('reddit_post_id: "def456"')
      expect(content).toContain('reddit_comment_id: "jkl456"')
      expect(content).toContain('reddit_capture_status: "fallback"')
      expect(content).toContain('## Comment')
      expect(content).toContain('Reddit comment metadata could not be fetched.')
      expect(content).toContain('## Thread')
      expect(content).toContain('Reddit thread metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: reddit')
      expect(content).toContain('- Subreddit: r/graphify')
      expect(content).toContain('- Post ID: def456')
      expect(content).toContain('- Comment ID: jkl456')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: comment JSON unavailable; preserved canonical comment URL and derived Reddit metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Open Comment](https://www.reddit.com/r/graphify/comments/def456/social_thread_roadmap/jkl456)')
      expect(content).toContain('[Open Thread](https://www.reddit.com/r/graphify/comments/def456/social_thread_roadmap)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('does not emit a fake linked url when reddit self-post JSON points back to the same thread', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify([
              {
                kind: 'Listing',
                data: {
                  children: [
                    {
                      kind: 't3',
                      data: {
                        subreddit: 'graphify',
                        author: 'thread_author',
                        title: 'Self post example',
                        selftext: 'This thread should not render a duplicate Reddit self-link.',
                        score: 12,
                        num_comments: 3,
                        permalink: '/r/graphify/comments/ghi789/self_post_example/',
                        url: 'https://old.reddit.com/r/graphify/comments/ghi789/self_post_example/',
                      },
                    },
                  ],
                },
              },
              {
                kind: 'Listing',
                data: {
                  children: [],
                },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )

      const output = await ingest('https://www.reddit.com/r/graphify/comments/ghi789/self_post_example/', join(tempDir, 'raw'))
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('[Open Thread](https://www.reddit.com/r/graphify/comments/ghi789/self_post_example)')
      expect(content).not.toContain('[Linked URL](https://old.reddit.com/r/graphify/comments/ghi789/self_post_example/)')
    })
  })

  test('saves YouTube video URLs as structured video markdown', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toBe(
            'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
          )
          return new Response(
            JSON.stringify({
              title: 'Graphify Demo Walkthrough',
              author_name: 'Graphify Channel',
              author_url: 'https://www.youtube.com/@graphify',
              provider_name: 'YouTube',
              thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }),
      )

      const output = await ingest('https://youtu.be/dQw4w9WgXcQ?si=graphify', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('title: "Graphify Demo Walkthrough"')
      expect(content).toContain('author: "Graphify Channel"')
      expect(content).toContain('contributor: "graphify-ts"')
      expect(content).toContain('video_platform: "youtube"')
      expect(content).toContain('video_id: "dQw4w9WgXcQ"')
      expect(content).toContain('video_provider: "YouTube"')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).toContain('video_channel_url: "https://www.youtube.com/@graphify"')
      expect(content).toContain('video_thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"')
      expect(content).toContain('video_embed_url: "https://www.youtube.com/embed/dQw4w9WgXcQ"')
      expect(content).toContain('# YouTube Video: Graphify Demo Walkthrough')
      expect(content).toContain('## Video')
      expect(content).toContain('[Graphify Channel](https://www.youtube.com/@graphify)')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: youtube')
      expect(content).toContain('- Video ID: dQw4w9WgXcQ')
      expect(content).toContain('- Capture Status: oembed')
      expect(content).toContain('## Links')
      expect(content).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
      expect(content).toContain('[Embed Player](https://www.youtube.com/embed/dQw4w9WgXcQ)')
      expect(content).toContain('[Thumbnail](https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('canonicalizes YouTube shorts and embed URLs to the same structured video asset', async () => {
    await withTempDir(async (tempDir) => {
      const requestUrls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          requestUrls.push(requestUrl)
          return new Response(
            JSON.stringify({
              title: 'Graphify Demo Walkthrough',
              author_name: 'Graphify Channel',
              author_url: 'https://www.youtube.com/@graphify',
              provider_name: 'YouTube',
              thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }),
      )

      const shortsOutput = await ingest('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share', join(tempDir, 'raw'))
      const embedOutput = await ingest('https://www.youtube.com/embed/dQw4w9WgXcQ?start=30', join(tempDir, 'raw'))
      const content = readFileSync(embedOutput, 'utf8')

      expect(requestUrls).toEqual([
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
        'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
      ])
      expect(basename(shortsOutput)).toBe('youtube_dQw4w9WgXcQ.md')
      expect(basename(embedOutput)).toMatch(/^youtube_dQw4w9WgXcQ(?:_\d+)?\.md$/)
      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('video_id: "dQw4w9WgXcQ"')
      expect(content).toContain('video_capture_status: "oembed"')
      expect(content).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
      expect(content).toContain('[Embed Player](https://www.youtube.com/embed/dQw4w9WgXcQ)')
    })
  })

  test('makes youtube fallback behavior explicit when oEmbed fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLgraphify', join(tempDir, 'raw'), {
        contributor: 'graphify-ts',
      })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: youtube_video')
      expect(content).toContain('source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
      expect(content).toContain('title: "YouTube Video: dQw4w9WgXcQ"')
      expect(content).toContain('author: "unknown"')
      expect(content).toContain('video_platform: "youtube"')
      expect(content).toContain('video_id: "dQw4w9WgXcQ"')
      expect(content).toContain('video_capture_status: "fallback"')
      expect(content).toContain('video_embed_url: "https://www.youtube.com/embed/dQw4w9WgXcQ"')
      expect(content).toContain('# YouTube Video: dQw4w9WgXcQ')
      expect(content).toContain('## Video')
      expect(content).toContain('Video metadata could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: oEmbed unavailable; preserved canonical video URL and derived video metadata only.')
      expect(content).toContain('## Links')
      expect(content).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=dQw4w9WgXcQ)')
      expect(content).toContain('[Embed Player](https://www.youtube.com/embed/dQw4w9WgXcQ)')
      expect(content).not.toContain('provenance:')
    })
  })

  test('uses stable per-video filenames for structured YouTube ingest', async () => {
    await withTempDir(async (tempDir) => {
      const responses = [
        {
          title: 'Graphify Demo Walkthrough',
          author_name: 'Graphify Channel',
          provider_name: 'YouTube',
        },
        {
          title: 'Graphify Roadmap Update',
          author_name: 'Graphify Channel',
          provider_name: 'YouTube',
        },
      ]

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })),
      )

      const firstOutput = await ingest('https://youtu.be/dQw4w9WgXcQ', join(tempDir, 'raw'))
      const secondOutput = await ingest('https://www.youtube.com/watch?v=9bZkp7q19f0', join(tempDir, 'raw'))

      expect(basename(firstOutput)).toBe('youtube_dQw4w9WgXcQ.md')
      expect(basename(secondOutput)).toBe('youtube_9bZkp7q19f0.md')
      expect(firstOutput).not.toBe(secondOutput)
    })
  })

  test('saves tweets as structured social markdown without nested provenance', async () => {
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
      expect(content).toContain('title: "Tweet by @graphify"')
      expect(content).toContain('author: "Graphify Bot"')
      expect(content).toContain('contributor: "graphify-ts"')
      expect(content).toContain('social_platform: "x"')
      expect(content).toContain('social_author_handle: "graphify"')
      expect(content).toContain('social_post_id: "1"')
      expect(content).toContain('social_capture_status: "oembed"')
      expect(content).toContain('# Tweet by @graphify')
      expect(content).toContain('## Post')
      expect(content).toContain('Graph edges everywhere')
      expect(content).toContain('## Context')
      expect(content).toContain('- Platform: x')
      expect(content).toContain('- Handle: @graphify')
      expect(content).toContain('- Post ID: 1')
      expect(content).toContain('- Capture Status: oembed')
      expect(content).not.toContain('provenance:')
    })
  })

  test('makes tweet fallback behavior explicit when oEmbed fetch fails', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } })),
      )

      const output = await ingest('https://x.com/graphify/status/2', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://x.com/graphify/status/2"')
      expect(content).toContain('title: "Tweet by @graphify"')
      expect(content).toContain('author: "graphify"')
      expect(content).toContain('social_author_handle: "graphify"')
      expect(content).toContain('social_post_id: "2"')
      expect(content).toContain('social_capture_status: "fallback"')
      expect(content).toContain('## Post')
      expect(content).toContain('Tweet content could not be fetched.')
      expect(content).toContain('## Context')
      expect(content).toContain('- Capture Status: fallback')
      expect(content).toContain('- Note: oEmbed unavailable; preserved source URL and derived social metadata only.')
      expect(content).not.toContain('provenance:')
    })
  })

  test('uses a neutral title for handle-less status urls instead of inventing a handle', async () => {
    await withTempDir(async (tempDir) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          expect(requestUrl).toContain('publish.twitter.com/oembed?url=')
          expect(decodeURIComponent(requestUrl)).toContain('https://twitter.com/i/web/status/3')
          return new Response(JSON.stringify({ html: '<blockquote>Handle-less status capture</blockquote>', author_name: 'Graphify Bot' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }),
      )

      const output = await ingest('https://twitter.com/i/web/status/3', join(tempDir, 'raw'), { contributor: 'graphify-ts' })
      const content = readFileSync(output, 'utf8')

      expect(content).toContain('type: tweet')
      expect(content).toContain('source_url: "https://twitter.com/i/web/status/3"')
      expect(content).toContain('title: "Tweet by Graphify Bot"')
      expect(content).toContain('author: "Graphify Bot"')
      expect(content).toContain('social_platform: "twitter"')
      expect(content).toContain('social_post_id: "3"')
      expect(content).not.toContain('social_author_handle:')
      expect(content).toContain('# Tweet by Graphify Bot')
      expect(content).toContain('Handle-less status capture')
      expect(content).not.toContain('@Graphify Bot')
      expect(content).not.toContain('- Handle:')
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

  test('downloads binary assets directly and persists hidden ingest metadata sidecars', async () => {
    await withTempDir(async (tempDir) => {
      const payload = Uint8Array.from([1, 2, 3, 4])
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(payload, { status: 200 })),
      )

      const cases = [
        {
          url: 'https://example.com/file.pdf',
          expectedSuffix: '.pdf',
        },
        {
          url: 'https://example.com/diagram.png',
          expectedSuffix: '.png',
        },
      ]

      for (const testCase of cases) {
        const output = await ingest(testCase.url, join(tempDir, 'raw'), { contributor: 'graphify-ts' })
        const sidecarPath = binaryIngestSidecarPath(output)
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>

        expect(output.endsWith(testCase.expectedSuffix)).toBe(true)
        expect(readFileSync(output)).toEqual(Buffer.from(payload))
        expect(existsSync(sidecarPath)).toBe(true)
        expect(sidecar).toEqual(
          expect.objectContaining({
            source_url: testCase.url,
            captured_at: expect.any(String),
            contributor: 'graphify-ts',
          }),
        )
        expect(typeof sidecar.captured_at).toBe('string')
      }
    })
  })

  test('rejects disallowed urls', async () => {
    await withTempDir(async (tempDir) => {
      await expect(ingest('file:///etc/passwd', join(tempDir, 'raw'))).rejects.toThrow(/file/i)
    })
  })
})
