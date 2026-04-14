import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { builtinCapabilityRegistry } from './capabilities.js'
import { dispatchIngest, type IngestHandlerMap } from './ingest/dispatch.js'
import type { IngestOptions, UrlType } from './ingest/types.js'
import { fetchHackerNews } from './ingest-hackernews.js'
import { detectUrlType } from './ingest/url-type.js'
import { fetchGitHub } from './ingest-github.js'
import { fetchReddit } from './ingest-reddit.js'
import { fetchTweet } from './ingest-social.js'
import { fetchYouTubeAsset } from './ingest-youtube.js'
import { fetchWebpage, resolveContributor, safeFilename, stripHtml, yamlString } from './ingest-web.js'
import { writeBinaryIngestSidecar } from '../shared/binary-ingest-sidecar.js'
import { safeFetch, safeFetchText, validateUrl } from '../shared/security.js'

export interface SaveQueryOptions {
  queryType?: string
  sourceNodes?: string[]
}
export type { IngestOptions, UrlType } from './ingest/types.js'
export { detectUrlType } from './ingest/url-type.js'
const MAX_SOURCE_NODES = 10

function timestampSlug(date: Date): string {
  const parts = [date.getUTCFullYear().toString().padStart(4, '0'), (date.getUTCMonth() + 1).toString().padStart(2, '0'), date.getUTCDate().toString().padStart(2, '0')]
  const time = [date.getUTCHours().toString().padStart(2, '0'), date.getUTCMinutes().toString().padStart(2, '0'), date.getUTCSeconds().toString().padStart(2, '0')]
  return `${parts.join('')}_${time.join('')}`
}

function questionSlug(question: string): string {
  return (
    question
      .toLowerCase()
      .replace(/[^\w]/g, '_')
      .slice(0, 50)
      .replace(/^_+|_+$/g, '') || 'query'
  )
}

function ensureUniquePath(directory: string, fileName: string): string {
  let candidate = join(directory, fileName)
  let counter = 1
  while (existsSync(candidate)) {
    const extensionIndex = fileName.lastIndexOf('.')
    const stem = extensionIndex >= 0 ? fileName.slice(0, extensionIndex) : fileName
    const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex) : ''
    candidate = join(directory, `${stem}_${counter}${extension}`)
    counter += 1
  }
  return candidate
}

async function fetchArxiv(url: string, options: IngestOptions): Promise<{ content: string; fileName: string }> {
  const match = /(\d{4}\.\d{4,5})/.exec(url)
  if (!match) {
    return fetchWebpage(url, options)
  }

  const arxivId = match[1] ?? ''
  const html = await safeFetchText(`https://export.arxiv.org/abs/${arxivId}`)
  const titleMatch = /class="title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  const abstractMatch = /class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i.exec(html)
  const authorsMatch = /class="authors"[^>]*>([\s\S]*?)<\/div>/i.exec(html)
  const title = stripHtml(titleMatch?.[1] ?? arxivId)
  const abstract = stripHtml(abstractMatch?.[1] ?? '')
  const authors = stripHtml(authorsMatch?.[1] ?? '')
  const capturedAt = new Date().toISOString()

  return {
    fileName: `arxiv_${arxivId.replace('.', '_')}.md`,
    content: `---\nsource_url: ${yamlString(url)}\narxiv_id: ${yamlString(arxivId)}\ntype: paper\ntitle: ${yamlString(title)}\npaper_authors: ${yamlString(authors)}\ncaptured_at: ${yamlString(capturedAt)}\ncontributor: ${yamlString(resolveContributor(options))}\n---\n\n# ${title}\n\n**Authors:** ${authors}\n**arXiv:** ${arxivId}\n\n## Abstract\n\n${abstract}\n\nSource: ${url}\n`,
  }
}

function imageSuffixFromUrl(url: string): string {
  const pathname = new URL(url).pathname
  return pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : '.jpg'
}

const INGEST_HANDLERS: IngestHandlerMap = {
  'builtin:ingest:tweet': async (url, options) => ({ kind: 'text', asset: await fetchTweet(url, options) }),
  'builtin:ingest:reddit': async (url, options) => ({ kind: 'text', asset: await fetchReddit(url, options) }),
  'builtin:ingest:hackernews': async (url, options) => ({ kind: 'text', asset: await fetchHackerNews(url, options) }),
  'builtin:ingest:arxiv': async (url, options) => ({ kind: 'text', asset: await fetchArxiv(url, options) }),
  'builtin:ingest:github': async (url, options) => ({ kind: 'text', asset: await fetchGitHub(url, options) }),
  'builtin:ingest:youtube': async (url, options) => ({ kind: 'text', asset: await fetchYouTubeAsset(url, options) }),
  'builtin:ingest:webpage': async (url, options) => ({ kind: 'text', asset: await fetchWebpage(url, options) }),
  'builtin:ingest:pdf': async () => ({ kind: 'binary', suffix: '.pdf' }),
  'builtin:ingest:image': async (url) => ({ kind: 'binary', suffix: imageSuffixFromUrl(url) }),
}

async function downloadBinary(url: string, directory: string, suffix: string, options: IngestOptions): Promise<string> {
  const bytes = await safeFetch(url)
  const outputPath = ensureUniquePath(directory, safeFilename(url, suffix))
  writeFileSync(outputPath, bytes)

  try {
    writeBinaryIngestSidecar(outputPath, {
      source_url: url,
      captured_at: new Date().toISOString(),
      contributor: resolveContributor(options),
    })
  } catch (error) {
    rmSync(outputPath, { force: true })
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to persist binary ingest metadata for '${url}': ${message}`)
  }

  return outputPath
}

export async function ingest(url: string, targetDir: string, options: IngestOptions = {}): Promise<string> {
  validateUrl(url)
  const directory = resolve(targetDir)
  mkdirSync(directory, { recursive: true })

  const urlType = detectUrlType(url)
  const dispatched = await dispatchIngest(urlType, url, options, INGEST_HANDLERS, {
    registry: builtinCapabilityRegistry,
  })
  if (dispatched.kind === 'binary') {
    return downloadBinary(url, directory, dispatched.suffix, options)
  }

  const asset = dispatched.asset
  const outputPath = ensureUniquePath(directory, asset.fileName)
  writeFileSync(outputPath, asset.content, 'utf8')
  return outputPath
}

export function saveQueryResult(question: string, answer: string, memoryDir: string, options: SaveQueryOptions = {}): string {
  const directory = resolve(memoryDir)
  mkdirSync(directory, { recursive: true })

  const now = new Date()
  const outputPath = join(directory, `query_${timestampSlug(now)}_${questionSlug(question)}.md`)
  const sourceNodes = options.sourceNodes?.slice(0, MAX_SOURCE_NODES) ?? []
  const lines = [
    '---',
    `type: ${yamlString(options.queryType ?? 'query')}`,
    `date: ${yamlString(now.toISOString())}`,
    `question: ${yamlString(question)}`,
    `contributor: ${yamlString('graphify-ts')}`,
    ...(sourceNodes.length > 0 ? [`source_nodes: [${sourceNodes.map((node) => yamlString(node)).join(', ')}]`] : []),
    '---',
    '',
    `# Q: ${question}`,
    '',
    '## Answer',
    '',
    answer,
  ]

  if (sourceNodes.length > 0) {
    lines.push('', '## Source Nodes', '')
    for (const node of sourceNodes) {
      lines.push(`- ${node}`)
    }
  }

  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
  return outputPath
}
