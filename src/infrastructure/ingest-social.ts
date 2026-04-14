import type { IngestTextAsset } from './ingest/dispatch.js'
import type { IngestOptions } from './ingest/types.js'
import { resolveContributor, safeFilename, stripHtml, yamlString } from './ingest-web.js'
import { safeFetchText } from '../shared/security.js'

const TWEET_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'x.com', 'www.x.com'])

interface TweetUrlMetadata {
  sourceUrl: string
  oembedUrl: string
  handle: string | null
  postId: string | null
  platform: 'x' | 'twitter'
}

interface TweetCapture {
  text: string
  authorName: string
  captureStatus: 'oembed' | 'fallback'
}

interface TweetPathMetadata {
  handle: string | null
  postId: string
}

function platformForHostname(hostname: string): 'x' | 'twitter' {
  return hostname.includes('twitter.com') ? 'twitter' : 'x'
}

export function isTweetHost(hostname: string): boolean {
  return TWEET_HOSTS.has(hostname.toLowerCase())
}

function isTweetPostId(value: string): boolean {
  return /^\d+$/.test(value)
}

function isTweetMediaIndex(value: string): boolean {
  return /^[1-9]\d*$/.test(value)
}

function parseTweetPath(pathname: string): TweetPathMetadata | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 3 && segments[0] !== 'i' && segments[1] === 'status' && isTweetPostId(segments[2] ?? '')) {
    return { handle: segments[0] ?? null, postId: segments[2] ?? '' }
  }
  if (
    segments.length === 5 &&
    segments[0] !== 'i' &&
    segments[1] === 'status' &&
    isTweetPostId(segments[2] ?? '') &&
    (segments[3] === 'photo' || segments[3] === 'video') &&
    isTweetMediaIndex(segments[4] ?? '')
  ) {
    return { handle: segments[0] ?? null, postId: segments[2] ?? '' }
  }
  if (segments.length === 4 && segments[0] === 'i' && segments[1] === 'web' && segments[2] === 'status' && isTweetPostId(segments[3] ?? '')) {
    return { handle: null, postId: segments[3] ?? '' }
  }
  if (
    segments.length === 6 &&
    segments[0] === 'i' &&
    segments[1] === 'web' &&
    segments[2] === 'status' &&
    isTweetPostId(segments[3] ?? '') &&
    (segments[4] === 'photo' || segments[4] === 'video') &&
    isTweetMediaIndex(segments[5] ?? '')
  ) {
    return { handle: null, postId: segments[3] ?? '' }
  }
  return null
}

export function isTweetPostUrl(url: string): boolean {
  const parsed = new URL(url)
  return isTweetHost(parsed.hostname) && parseTweetPath(parsed.pathname) !== null
}

function parseTweetUrl(url: string): TweetUrlMetadata {
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase()
  const platform = platformForHostname(hostname)
  const pathMetadata = parseTweetPath(parsed.pathname)
  const handle = pathMetadata?.handle ?? null
  const postId = pathMetadata?.postId ?? null
  parsed.search = ''
  parsed.hash = ''
  if (postId && handle) {
    parsed.pathname = `/${handle}/status/${postId}`
  } else if (postId) {
    parsed.pathname = `/i/web/status/${postId}`
  }
  const sourceUrl = parsed.toString()

  const oembedTarget = new URL(sourceUrl)
  oembedTarget.hostname = 'twitter.com'
  if (postId && handle) {
    oembedTarget.pathname = `/${handle}/status/${postId}`
  } else if (postId) {
    oembedTarget.pathname = `/i/web/status/${postId}`
  }

  return {
    sourceUrl,
    oembedUrl: `https://publish.twitter.com/oembed?url=${encodeURIComponent(oembedTarget.toString())}&omit_script=true`,
    handle,
    postId,
    platform,
  }
}

async function captureTweet(metadata: TweetUrlMetadata): Promise<TweetCapture> {
  let text = 'Tweet content could not be fetched.'
  let authorName = metadata.handle ?? 'unknown'
  let captureStatus: 'oembed' | 'fallback' = 'fallback'

  try {
    const parsed = JSON.parse(await safeFetchText(metadata.oembedUrl)) as { html?: string; author_name?: string }
    const extractedText = stripHtml(parsed.html ?? '')
    if (extractedText) {
      text = extractedText
      captureStatus = 'oembed'
    }
    if (parsed.author_name?.trim()) {
      authorName = parsed.author_name.trim()
    }
  } catch {
    // Keep the explicit fallback payload below.
  }

  return { text, authorName, captureStatus }
}

function tweetTitle(handle: string | null, authorName: string): string {
  if (handle) {
    return `Tweet by @${handle}`
  }
  if (authorName && authorName !== 'unknown') {
    return `Tweet by ${authorName}`
  }
  return 'Tweet'
}

export async function fetchTweet(url: string, options: IngestOptions): Promise<IngestTextAsset> {
  const metadata = parseTweetUrl(url)
  const captured = await captureTweet(metadata)
  const title = tweetTitle(metadata.handle, captured.authorName)
  const author = captured.authorName || metadata.handle || 'unknown'
  const capturedAt = new Date().toISOString()
  const contextLines = [
    `- Platform: ${metadata.platform}`,
    ...(metadata.handle ? [`- Handle: @${metadata.handle}`] : []),
    ...(metadata.postId ? [`- Post ID: ${metadata.postId}`] : []),
    `- Capture Status: ${captured.captureStatus}`,
    ...(captured.captureStatus === 'fallback' ? ['- Note: oEmbed unavailable; preserved source URL and derived social metadata only.'] : []),
  ]

  return {
    fileName: safeFilename(metadata.sourceUrl, '.md'),
    content: [
      '---',
      `source_url: ${yamlString(metadata.sourceUrl)}`,
      'type: tweet',
      `title: ${yamlString(title)}`,
      `author: ${yamlString(author)}`,
      `captured_at: ${yamlString(capturedAt)}`,
      `contributor: ${yamlString(resolveContributor(options))}`,
      `social_platform: ${yamlString(metadata.platform)}`,
      ...(metadata.handle ? [`social_author_handle: ${yamlString(metadata.handle)}`] : []),
      ...(metadata.postId ? [`social_post_id: ${yamlString(metadata.postId)}`] : []),
      `social_capture_status: ${yamlString(captured.captureStatus)}`,
      '---',
      '',
      `# ${title}`,
      '',
      '## Post',
      '',
      captured.text,
      '',
      '## Context',
      '',
      ...contextLines,
      '',
      `Source: ${metadata.sourceUrl}`,
      '',
    ].join('\n'),
  }
}
