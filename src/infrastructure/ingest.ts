import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { builtinCapabilityRegistry } from './capabilities.js'
import { dispatchIngest, type IngestHandlerMap } from './ingest/dispatch.js'
import type { IngestOptions, UrlType } from './ingest/types.js'
import { detectUrlType } from './ingest/url-type.js'
import { safeFetch, safeFetchText, validateUrl } from '../shared/security.js'

export interface SaveQueryOptions {
  queryType?: string
  sourceNodes?: string[]
}
export type { IngestOptions, UrlType } from './ingest/types.js'
export { detectUrlType } from './ingest/url-type.js'
const MAX_EXTRACTED_TEXT_LENGTH = 12_000
const MAX_SOURCE_NODES = 10

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, ' '))
}

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

function safeFilename(url: string, suffix: string): string {
  const parsed = new URL(url)
  const base = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^\w-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

  return `${base || 'resource'}${suffix}`
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

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTextContent(html: string): string {
  return stripHtml(html).slice(0, MAX_EXTRACTED_TEXT_LENGTH)
}

function extractTitle(html: string, fallback: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? stripHtml(match[1] ?? fallback) : fallback
}

async function fetchTweet(url: string, options: IngestOptions): Promise<{ content: string; fileName: string }> {
  const parsed = new URL(url)
  if (parsed.hostname === 'x.com') {
    parsed.hostname = 'twitter.com'
  }
  const normalizedUrl = parsed.toString()
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(normalizedUrl)}&omit_script=true`
  let tweetText = `Tweet at ${url} (could not fetch content)`
  let tweetAuthor = 'unknown'

  try {
    const parsed = JSON.parse(await safeFetchText(oembedUrl)) as { html?: string; author_name?: string }
    tweetText = stripHtml(parsed.html ?? tweetText)
    tweetAuthor = parsed.author_name ?? tweetAuthor
  } catch {
    // Fall back to a URL stub if oEmbed fails.
  }

  const capturedAt = new Date().toISOString()
  return {
    fileName: safeFilename(url, '.md'),
    content: `---\nsource_url: ${yamlString(url)}\ntype: tweet\nauthor: ${yamlString(tweetAuthor)}\ncaptured_at: ${yamlString(capturedAt)}\ncontributor: ${yamlString(options.contributor ?? options.author ?? 'unknown')}\n---\n\n# Tweet by @${tweetAuthor}\n\n${tweetText}\n\nSource: ${url}\n`,
  }
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
    content: `---\nsource_url: ${yamlString(url)}\narxiv_id: ${yamlString(arxivId)}\ntype: paper\ntitle: ${yamlString(title)}\npaper_authors: ${yamlString(authors)}\ncaptured_at: ${yamlString(capturedAt)}\ncontributor: ${yamlString(options.contributor ?? options.author ?? 'unknown')}\n---\n\n# ${title}\n\n**Authors:** ${authors}\n**arXiv:** ${arxivId}\n\n## Abstract\n\n${abstract}\n\nSource: ${url}\n`,
  }
}

async function fetchWebpage(url: string, options: IngestOptions): Promise<{ content: string; fileName: string }> {
  const html = await safeFetchText(url)
  const title = extractTitle(html, url)
  const capturedAt = new Date().toISOString()
  return {
    fileName: safeFilename(url, '.md'),
    content: `---\nsource_url: ${yamlString(url)}\ntype: webpage\ntitle: ${yamlString(title)}\ncaptured_at: ${yamlString(capturedAt)}\ncontributor: ${yamlString(options.contributor ?? options.author ?? 'unknown')}\n---\n\n# ${title}\n\nSource: ${url}\n\n---\n\n${extractTextContent(html)}\n`,
  }
}

function imageSuffixFromUrl(url: string): string {
  const pathname = new URL(url).pathname
  return pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : '.jpg'
}

const INGEST_HANDLERS: IngestHandlerMap = {
  'builtin:ingest:tweet': async (url, options) => ({ kind: 'text', asset: await fetchTweet(url, options) }),
  'builtin:ingest:arxiv': async (url, options) => ({ kind: 'text', asset: await fetchArxiv(url, options) }),
  'builtin:ingest:github': async (url, options) => ({ kind: 'text', asset: await fetchWebpage(url, options) }),
  'builtin:ingest:youtube': async (url, options) => ({ kind: 'text', asset: await fetchWebpage(url, options) }),
  'builtin:ingest:webpage': async (url, options) => ({ kind: 'text', asset: await fetchWebpage(url, options) }),
  'builtin:ingest:pdf': async () => ({ kind: 'binary', suffix: '.pdf' }),
  'builtin:ingest:image': async (url) => ({ kind: 'binary', suffix: imageSuffixFromUrl(url) }),
}

async function downloadBinary(url: string, directory: string, suffix: string): Promise<string> {
  const bytes = await safeFetch(url)
  const outputPath = ensureUniquePath(directory, safeFilename(url, suffix))
  writeFileSync(outputPath, bytes)
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
    return downloadBinary(url, directory, dispatched.suffix)
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
