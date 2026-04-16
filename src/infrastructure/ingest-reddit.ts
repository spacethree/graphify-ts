import type { IngestTextAsset } from './ingest/dispatch.js'
import type { IngestOptions } from './ingest/types.js'
import { fetchWebpage, resolveContributor, yamlString } from './ingest-web.js'
import { safeFetchText } from '../shared/security.js'

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com', 'redd.it'])
const MAX_THREAD_HIGHLIGHTS = 3
const MAX_HIGHLIGHT_LENGTH = 280

interface RedditUrlMetadata {
  route: 'thread' | 'comment'
  sourceUrl: string
  threadUrl: string
  jsonUrl: string
  subreddit: string | null
  postId: string
  slug: string | null
  commentId: string | null
  platform: 'reddit'
}

interface RedditCommentHighlight {
  authorName: string
  body: string
}

interface RedditCapture {
  sourceUrl: string
  threadUrl: string
  subreddit: string | null
  title: string
  authorName: string
  body: string
  score: string | null
  threadScore: string | null
  commentCount: string | null
  externalUrl: string | null
  threadTitle: string
  threadAuthorName: string
  threadBody: string
  threadHighlights: RedditCommentHighlight[]
  captureStatus: 'json' | 'fallback'
}

interface RedditChild {
  kind: string | null
  data: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeCount(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function normalizeRedditText(value: string): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

function truncateHighlight(value: string): string {
  if (value.length <= MAX_HIGHLIGHT_LENGTH) {
    return value
  }
  return `${value.slice(0, MAX_HIGHLIGHT_LENGTH - 1).trimEnd()}…`
}

function isRedditHost(hostname: string): boolean {
  return REDDIT_HOSTS.has(hostname.toLowerCase())
}

function isRedditPostId(value: string): boolean {
  return /^[A-Za-z0-9]+$/.test(value)
}

function normalizeCanonicalRedditUrl(pathname: string): string {
  const trimmedPath = pathname.replace(/\/+$/, '')
  return `https://www.reddit.com${trimmedPath || '/'}`
}

function canonicalShortThreadUrl(postId: string): string {
  return normalizeCanonicalRedditUrl(`/comments/${postId}`)
}

function extractListingChildren(value: unknown): RedditChild[] {
  if (!isRecord(value)) {
    return []
  }
  const data = value.data
  if (!isRecord(data) || !Array.isArray(data.children)) {
    return []
  }

  return data.children
    .filter(isRecord)
    .map((child) => {
      const childData = child.data
      return {
        kind: typeof child.kind === 'string' ? child.kind : null,
        data: isRecord(childData) ? childData : {},
      }
    })
}

function parseRedditUrl(url: string): RedditUrlMetadata | null {
  const parsed = new URL(url)
  if (!isRedditHost(parsed.hostname)) {
    return null
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '').toLowerCase()
  if (normalizedPath.endsWith('.json')) {
    return null
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (parsed.hostname.toLowerCase() === 'redd.it') {
    const postId = segments[0] ?? ''
    if (segments.length !== 1 || !isRedditPostId(postId)) {
      return null
    }

    const sourceUrl = canonicalShortThreadUrl(postId)
    return {
      route: 'thread',
      sourceUrl,
      threadUrl: sourceUrl,
      jsonUrl: `${sourceUrl}.json?limit=3&depth=1&raw_json=1`,
      subreddit: null,
      postId,
      slug: null,
      commentId: null,
      platform: 'reddit',
    }
  }

  if (segments[0] === 'comments') {
    const postId = segments[1] ?? ''
    if (segments.length !== 2 || !isRedditPostId(postId)) {
      return null
    }

    const sourceUrl = canonicalShortThreadUrl(postId)
    return {
      route: 'thread',
      sourceUrl,
      threadUrl: sourceUrl,
      jsonUrl: `${sourceUrl}.json?limit=3&depth=1&raw_json=1`,
      subreddit: null,
      postId,
      slug: null,
      commentId: null,
      platform: 'reddit',
    }
  }

  if (segments.length < 4 || segments.length > 6 || segments[0] !== 'r' || segments[2] !== 'comments' || !isRedditPostId(segments[3] ?? '')) {
    return null
  }

  const subreddit = segments[1] ?? ''
  if (!subreddit) {
    return null
  }

  const postId = segments[3] ?? ''
  const slug = segments[4] ?? null
  const commentId = segments[5] ?? null
  if (commentId !== null && (!slug || !isRedditPostId(commentId))) {
    return null
  }

  const threadPath = `/r/${subreddit}/comments/${postId}${slug ? `/${slug}` : ''}`
  const threadUrl = normalizeCanonicalRedditUrl(threadPath)
  const sourceUrl = commentId ? normalizeCanonicalRedditUrl(`${threadPath}/${commentId}`) : threadUrl
  return {
    route: commentId ? 'comment' : 'thread',
    sourceUrl,
    threadUrl,
    jsonUrl: `${sourceUrl}.json?limit=3&depth=1&raw_json=1`,
    subreddit,
    postId,
    slug,
    commentId,
    platform: 'reddit',
  }
}

export function isRedditContentUrl(url: string): boolean {
  return parseRedditUrl(url) !== null
}

function canonicalUrlFromPermalink(permalink: string | null, fallback: string): string {
  if (!permalink) {
    return fallback
  }

  try {
    const parsed = new URL(permalink, 'https://www.reddit.com')
    return normalizeCanonicalRedditUrl(parsed.pathname)
  } catch {
    return fallback
  }
}

function normalizeExternalUrl(value: string | null, sourceUrl: string, metadata: Pick<RedditUrlMetadata, 'subreddit' | 'postId'>): string | null {
  if (!value) {
    return null
  }

  const candidateThread = parseRedditUrl(value)
  if (candidateThread && candidateThread.postId === metadata.postId && (metadata.subreddit === null || candidateThread.subreddit === metadata.subreddit)) {
    return null
  }

  try {
    const parsed = new URL(value)
    if (isRedditHost(parsed.hostname) && normalizeCanonicalRedditUrl(parsed.pathname) === sourceUrl) {
      return null
    }
  } catch {
    return value
  }

  return value
}

function extractThreadHighlights(children: RedditChild[]): RedditCommentHighlight[] {
  const highlights: RedditCommentHighlight[] = []
  for (const child of children) {
    if (child.kind !== 't1') {
      continue
    }

    const authorName = normalizeString(child.data.author) ?? '[deleted]'
    const body = normalizeString(child.data.body)
    if (!body) {
      continue
    }

    highlights.push({
      authorName,
      body: truncateHighlight(normalizeRedditText(body)),
    })

    if (highlights.length >= MAX_THREAD_HIGHLIGHTS) {
      break
    }
  }

  return highlights
}

function fallbackThreadTitle(metadata: RedditUrlMetadata): string {
  return `Reddit Thread: ${metadata.postId}`
}

function fallbackThreadBody(): string {
  return 'Reddit thread metadata could not be fetched.'
}

function fallbackCommentTitle(metadata: RedditUrlMetadata): string {
  return `Reddit Comment: ${metadata.postId}/${metadata.commentId ?? 'unknown'}`
}

function fallbackCommentBody(): string {
  return 'Reddit comment metadata could not be fetched.'
}

function extractReplyChildren(value: unknown): RedditChild[] {
  return extractListingChildren(value)
}

function findCommentById(children: RedditChild[], commentId: string): RedditChild | null {
  for (const child of children) {
    if (child.kind !== 't1') {
      continue
    }

    if (normalizeString(child.data.id) === commentId) {
      return child
    }

    const nestedMatch = findCommentById(extractReplyChildren(child.data.replies), commentId)
    if (nestedMatch) {
      return nestedMatch
    }
  }

  return null
}

function fallbackCapture(metadata: RedditUrlMetadata): RedditCapture {
  const isCommentRoute = metadata.route === 'comment'
  const threadTitle = fallbackThreadTitle(metadata)
  const threadBody = fallbackThreadBody()
  return {
    sourceUrl: metadata.sourceUrl,
    threadUrl: metadata.threadUrl,
    subreddit: metadata.subreddit,
    title: isCommentRoute ? fallbackCommentTitle(metadata) : threadTitle,
    authorName: 'unknown',
    body: isCommentRoute ? fallbackCommentBody() : threadBody,
    score: null,
    threadScore: null,
    commentCount: null,
    externalUrl: null,
    threadTitle,
    threadAuthorName: 'unknown',
    threadBody,
    threadHighlights: [],
    captureStatus: 'fallback',
  }
}

async function captureReddit(metadata: RedditUrlMetadata): Promise<RedditCapture> {
  const fallback = fallbackCapture(metadata)

  try {
    const parsed = JSON.parse(await safeFetchText(metadata.jsonUrl)) as unknown
    const listings = Array.isArray(parsed) ? parsed : []
    const postChildren = extractListingChildren(listings[0])
    const commentChildren = extractListingChildren(listings[1])
    const postData = postChildren.find((child) => child.kind === 't3')?.data
    if (!postData) {
      return fallback
    }

    const subreddit = normalizeString(postData.subreddit) ?? metadata.subreddit
    const threadTitle = normalizeString(postData.title) ?? fallback.threadTitle
    const threadAuthorName = normalizeString(postData.author) ?? 'unknown'
    const threadBody = normalizeString(postData.selftext) ? normalizeRedditText(String(postData.selftext)) : 'Reddit post body was empty.'
    const threadScore = normalizeCount(postData.score)
    const commentCount = normalizeCount(postData.num_comments)
    const permalink = normalizeString(postData.permalink)
    const threadUrl = canonicalUrlFromPermalink(permalink, metadata.threadUrl)
    const externalUrl = normalizeExternalUrl(normalizeString(postData.url), threadUrl, metadata)

    if (metadata.route === 'comment' && metadata.commentId) {
      const commentData = findCommentById(commentChildren, metadata.commentId)?.data
      if (!commentData) {
        return {
          ...fallback,
          subreddit,
          title: `Comment on: ${threadTitle}`,
          threadUrl,
          commentCount,
          externalUrl,
          threadTitle,
          threadAuthorName,
          threadBody,
          threadScore,
        }
      }

      const sourceUrl = canonicalUrlFromPermalink(normalizeString(commentData.permalink), metadata.sourceUrl)
      const authorName = normalizeString(commentData.author) ?? 'unknown'
      const body = normalizeString(commentData.body) ? normalizeRedditText(String(commentData.body)) : fallbackCommentBody()
      const score = normalizeCount(commentData.score)

      return {
        sourceUrl,
        threadUrl,
        subreddit,
        title: `Comment on: ${threadTitle}`,
        authorName,
        body,
        score,
        threadScore,
        commentCount,
        externalUrl,
        threadTitle,
        threadAuthorName,
        threadBody,
        threadHighlights: [],
        captureStatus: 'json',
      }
    }

    return {
      sourceUrl: threadUrl,
      threadUrl,
      subreddit,
      title: threadTitle,
      authorName: threadAuthorName,
      body: threadBody,
      score: threadScore,
      threadScore,
      commentCount,
      externalUrl,
      threadTitle,
      threadAuthorName,
      threadBody,
      threadHighlights: extractThreadHighlights(commentChildren),
      captureStatus: 'json',
    }
  } catch {
    return fallback
  }
}

function redditFilename(metadata: Pick<RedditUrlMetadata, 'postId' | 'commentId'>, subreddit: string | null): string {
  const prefix = subreddit ? `reddit_${subreddit.replace(/[^\w-]+/g, '_')}_${metadata.postId}` : `reddit_${metadata.postId}`
  return metadata.commentId ? `${prefix}_${metadata.commentId}.md` : `${prefix}.md`
}

function renderThreadHighlights(capture: RedditCapture): string[] {
  if (capture.threadHighlights.length === 0) {
    return ['No thread highlights captured.']
  }

  const lines: string[] = []
  for (const highlight of capture.threadHighlights) {
    lines.push(`### Comment by u/${highlight.authorName}`, '', highlight.body, '')
  }
  while (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

export async function fetchReddit(url: string, options: IngestOptions): Promise<IngestTextAsset> {
  const metadata = parseRedditUrl(url)
  if (!metadata) {
    return fetchWebpage(url, options)
  }

  const captured = await captureReddit(metadata)
  const resolvedSubreddit = captured.subreddit
  const capturedAt = new Date().toISOString()
  if (metadata.route === 'comment' && metadata.commentId) {
    const contextLines = [
      `- Platform: ${metadata.platform}`,
      ...(resolvedSubreddit ? [`- Subreddit: r/${resolvedSubreddit}`] : []),
      `- Post ID: ${metadata.postId}`,
      `- Comment ID: ${metadata.commentId}`,
      `- Thread Author: ${captured.threadAuthorName}`,
      ...(captured.score ? [`- Comment Score: ${captured.score}`] : []),
      ...(captured.threadScore ? [`- Thread Score: ${captured.threadScore}`] : []),
      ...(captured.commentCount ? [`- Comment Count: ${captured.commentCount}`] : []),
      `- Capture Status: ${captured.captureStatus}`,
      ...(captured.captureStatus === 'fallback' ? ['- Note: comment JSON unavailable; preserved canonical comment URL and derived Reddit metadata only.'] : []),
    ]
    const linkLines = [
      `- [Open Comment](${captured.sourceUrl})`,
      `- [Open Thread](${captured.threadUrl})`,
      ...(captured.externalUrl ? [`- [Linked URL](${captured.externalUrl})`] : []),
    ]
    const heading = captured.captureStatus === 'json' ? `Reddit Comment: ${captured.threadTitle}` : captured.title

    return {
      fileName: redditFilename(metadata, resolvedSubreddit),
      content: [
        '---',
        `source_url: ${yamlString(captured.sourceUrl)}`,
        'type: reddit_comment',
        `title: ${yamlString(captured.title)}`,
        `author: ${yamlString(captured.authorName)}`,
        `captured_at: ${yamlString(capturedAt)}`,
        `contributor: ${yamlString(resolveContributor(options))}`,
        ...(resolvedSubreddit ? [`reddit_subreddit: ${yamlString(resolvedSubreddit)}`] : []),
        `reddit_post_id: ${yamlString(metadata.postId)}`,
        `reddit_comment_id: ${yamlString(metadata.commentId)}`,
        ...(captured.score ? [`reddit_comment_score: ${yamlString(captured.score)}`] : []),
        `reddit_capture_status: ${yamlString(captured.captureStatus)}`,
        '---',
        '',
        `# ${heading}`,
        '',
        '## Comment',
        '',
        captured.body,
        '',
        '## Thread',
        '',
        captured.threadBody,
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

  const contextLines = [
    `- Platform: ${metadata.platform}`,
    ...(resolvedSubreddit ? [`- Subreddit: r/${resolvedSubreddit}`] : []),
    `- Post ID: ${metadata.postId}`,
    ...(captured.score ? [`- Score: ${captured.score}`] : []),
    ...(captured.commentCount ? [`- Comment Count: ${captured.commentCount}`] : []),
    `- Capture Status: ${captured.captureStatus}`,
    ...(captured.captureStatus === 'fallback' ? ['- Note: thread JSON unavailable; preserved canonical thread URL and derived Reddit metadata only.'] : []),
  ]
  const linkLines = [
    `- [Open Thread](${captured.sourceUrl})`,
    ...(captured.externalUrl ? [`- [Linked URL](${captured.externalUrl})`] : []),
  ]

  return {
    fileName: redditFilename(metadata, resolvedSubreddit),
    content: [
      '---',
      `source_url: ${yamlString(captured.sourceUrl)}`,
      'type: reddit_thread',
      `title: ${yamlString(captured.title)}`,
      `author: ${yamlString(captured.authorName)}`,
      `captured_at: ${yamlString(capturedAt)}`,
      `contributor: ${yamlString(resolveContributor(options))}`,
      ...(resolvedSubreddit ? [`reddit_subreddit: ${yamlString(resolvedSubreddit)}`] : []),
      `reddit_post_id: ${yamlString(metadata.postId)}`,
      ...(captured.score ? [`reddit_score: ${yamlString(captured.score)}`] : []),
      ...(captured.commentCount ? [`reddit_comment_count: ${yamlString(captured.commentCount)}`] : []),
      `reddit_capture_status: ${yamlString(captured.captureStatus)}`,
      '---',
      '',
      `# Reddit Thread: ${captured.title}`,
      '',
      '## Post',
      '',
      captured.body,
      '',
      '## Thread Highlights',
      '',
      ...renderThreadHighlights(captured),
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
