import type { IngestTextAsset } from './ingest/dispatch.js'
import type { IngestOptions } from './ingest/types.js'
import { fetchWebpage, resolveContributor, stripHtml, yamlString } from './ingest-web.js'
import { safeFetchText } from '../shared/security.js'

const HACKER_NEWS_HOSTS = new Set(['news.ycombinator.com'])
const HACKER_NEWS_API_BASE = 'https://hacker-news.firebaseio.com/v0/item'
const MAX_DISCUSSION_HIGHLIGHTS = 3

interface HackerNewsUrlMetadata {
  sourceUrl: string
  apiUrl: string
  itemId: string
  platform: 'hackernews'
}

interface HackerNewsItemRecord {
  by?: string
  descendants?: number
  id?: number
  kids?: unknown
  score?: number
  text?: string
  title?: string
  url?: string
}

interface HackerNewsDiscussionHighlight {
  authorName: string
  body: string
}

interface HackerNewsCapture {
  sourceUrl: string
  title: string
  authorName: string
  body: string
  score: string | null
  commentCount: string | null
  externalUrl: string | null
  discussionHighlights: HackerNewsDiscussionHighlight[]
  captureStatus: 'api' | 'fallback'
}

function trimString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeCount(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function normalizeHackerNewsText(value: string): string {
  return stripHtml(value).trim()
}

function isHackerNewsHost(hostname: string): boolean {
  return HACKER_NEWS_HOSTS.has(hostname.toLowerCase())
}

function parseHackerNewsUrl(url: string): HackerNewsUrlMetadata | null {
  const parsed = new URL(url)
  if (!isHackerNewsHost(parsed.hostname) || parsed.pathname !== '/item') {
    return null
  }

  const itemId = parsed.searchParams.get('id')?.trim() ?? ''
  if (!/^\d+$/.test(itemId)) {
    return null
  }

  const sourceUrl = `https://news.ycombinator.com/item?id=${itemId}`
  return {
    sourceUrl,
    apiUrl: `${HACKER_NEWS_API_BASE}/${itemId}.json`,
    itemId,
    platform: 'hackernews',
  }
}

export function isHackerNewsItemUrl(url: string): boolean {
  return parseHackerNewsUrl(url) !== null
}

async function fetchHackerNewsItemRecord(apiUrl: string): Promise<HackerNewsItemRecord> {
  return JSON.parse(await safeFetchText(apiUrl)) as HackerNewsItemRecord
}

function normalizeExternalUrl(value: string | null, sourceUrl: string): string | null {
  if (!value) {
    return null
  }

  try {
    const parsed = new URL(value)
    return parsed.toString() === sourceUrl ? null : parsed.toString()
  } catch {
    return null
  }
}

function commentApiUrl(id: number): string {
  return `${HACKER_NEWS_API_BASE}/${id}.json`
}

async function extractDiscussionHighlights(item: HackerNewsItemRecord): Promise<HackerNewsDiscussionHighlight[]> {
  if (!Array.isArray(item.kids)) {
    return []
  }

  const kidIds = item.kids
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const highlights: HackerNewsDiscussionHighlight[] = []
  for (const kidId of kidIds) {
    if (highlights.length >= MAX_DISCUSSION_HIGHLIGHTS) {
      break
    }

    try {
      const item = await fetchHackerNewsItemRecord(commentApiUrl(kidId))
      const authorName = trimString(item.by) ?? 'unknown'
      const body = trimString(item.text)
      if (!body) {
        continue
      }

      const normalizedBody = normalizeHackerNewsText(body)
      if (!normalizedBody) {
        continue
      }

      highlights.push({ authorName, body: normalizedBody })
    } catch {
      continue
    }
  }

  return highlights
}

function fallbackTitle(metadata: HackerNewsUrlMetadata): string {
  return `Hacker News Item: ${metadata.itemId}`
}

function fallbackBody(): string {
  return 'Hacker News item metadata could not be fetched.'
}

async function captureHackerNews(metadata: HackerNewsUrlMetadata): Promise<HackerNewsCapture> {
  try {
    const item = await fetchHackerNewsItemRecord(metadata.apiUrl)
    const title = trimString(item.title) ?? fallbackTitle(metadata)
    const authorName = trimString(item.by) ?? 'unknown'
    const bodyText = trimString(item.text)
    const body = bodyText ? normalizeHackerNewsText(bodyText) || 'Hacker News item body was empty.' : 'Hacker News item body was empty.'

    return {
      sourceUrl: metadata.sourceUrl,
      title,
      authorName,
      body,
      score: normalizeCount(item.score),
      commentCount: normalizeCount(item.descendants),
      externalUrl: normalizeExternalUrl(trimString(item.url), metadata.sourceUrl),
      discussionHighlights: await extractDiscussionHighlights(item),
      captureStatus: 'api',
    }
  } catch {
    return {
      sourceUrl: metadata.sourceUrl,
      title: fallbackTitle(metadata),
      authorName: 'unknown',
      body: fallbackBody(),
      score: null,
      commentCount: null,
      externalUrl: null,
      discussionHighlights: [],
      captureStatus: 'fallback',
    }
  }
}

function hackerNewsHeading(title: string): string {
  return title.startsWith('Hacker News Item: ') ? `# ${title}` : `# Hacker News Item: ${title}`
}

function hackerNewsFilename(itemId: string): string {
  return `hackernews_${itemId}.md`
}

function renderDiscussionHighlights(capture: HackerNewsCapture): string[] {
  if (capture.discussionHighlights.length === 0) {
    return ['No discussion highlights captured.']
  }

  const lines: string[] = []
  for (const highlight of capture.discussionHighlights) {
    lines.push(`### Comment by ${highlight.authorName}`, '', highlight.body, '')
  }
  while (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

export async function fetchHackerNews(url: string, options: IngestOptions): Promise<IngestTextAsset> {
  const metadata = parseHackerNewsUrl(url)
  if (!metadata) {
    return fetchWebpage(url, options)
  }

  const captured = await captureHackerNews(metadata)
  const capturedAt = new Date().toISOString()
  const contextLines = [
    `- Platform: ${metadata.platform}`,
    `- Item ID: ${metadata.itemId}`,
    ...(captured.score ? [`- Score: ${captured.score}`] : []),
    ...(captured.commentCount ? [`- Comment Count: ${captured.commentCount}`] : []),
    `- Capture Status: ${captured.captureStatus}`,
    ...(captured.captureStatus === 'fallback'
      ? ['- Note: Hacker News API unavailable; preserved canonical discussion URL and derived item metadata only.']
      : []),
  ]
  const linkLines = [
    `- [Open Discussion](${captured.sourceUrl})`,
    ...(captured.externalUrl ? [`- [Linked URL](${captured.externalUrl})`] : []),
  ]

  return {
    fileName: hackerNewsFilename(metadata.itemId),
    content: [
      '---',
      `source_url: ${yamlString(captured.sourceUrl)}`,
      'type: hackernews_item',
      `title: ${yamlString(captured.title)}`,
      `author: ${yamlString(captured.authorName)}`,
      `captured_at: ${yamlString(capturedAt)}`,
      `contributor: ${yamlString(resolveContributor(options))}`,
      `hackernews_item_id: ${yamlString(metadata.itemId)}`,
      ...(captured.score ? [`hackernews_score: ${yamlString(captured.score)}`] : []),
      ...(captured.commentCount ? [`hackernews_comment_count: ${yamlString(captured.commentCount)}`] : []),
      `hackernews_capture_status: ${yamlString(captured.captureStatus)}`,
      '---',
      '',
      hackerNewsHeading(captured.title),
      '',
      '## Item',
      '',
      captured.body,
      '',
      '## Discussion Highlights',
      '',
      ...renderDiscussionHighlights(captured),
      '',
      '## Context',
      '',
      ...contextLines,
      '',
      '## Links',
      '',
      ...linkLines,
      '',
      `Source: ${captured.sourceUrl}`,
      '',
    ].join('\n'),
  }
}
