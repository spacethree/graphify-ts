import type { IngestTextAsset } from './ingest/dispatch.js'
import type { IngestOptions } from './ingest/types.js'
import { fetchWebpage, resolveContributor, yamlString } from './ingest-web.js'
import { safeFetchText } from '../shared/security.js'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])

interface YouTubeUrlMetadata {
  sourceUrl: string
  videoId: string
  embedUrl: string
  oembedUrl: string
  platform: 'youtube'
}

interface YouTubeCapture {
  title: string
  authorName: string
  authorUrl: string | null
  providerName: string
  thumbnailUrl: string | null
  captureStatus: 'oembed' | 'fallback'
}

function isYouTubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.has(hostname.toLowerCase())
}

function isYouTubeVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(value)
}

function trimOptional(value?: string): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function parseYouTubeUrl(url: string): YouTubeUrlMetadata | null {
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase()
  if (!isYouTubeHost(hostname)) {
    return null
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  const segments = normalizedPath.split('/').filter(Boolean)
  let videoId: string | null = null
  if (hostname === 'youtu.be') {
    if (segments.length === 1 && isYouTubeVideoId(segments[0] ?? '')) {
      videoId = segments[0] ?? null
    }
  } else if (normalizedPath === '/watch') {
    const candidate = parsed.searchParams.get('v')
    if (candidate && isYouTubeVideoId(candidate)) {
      videoId = candidate
    }
  } else if ((segments[0] === 'shorts' || segments[0] === 'embed') && segments.length === 2 && isYouTubeVideoId(segments[1] ?? '')) {
    videoId = segments[1] ?? null
  }

  if (!videoId) {
    return null
  }

  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`
  return {
    sourceUrl,
    videoId,
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    oembedUrl: `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`,
    platform: 'youtube',
  }
}

export function isYouTubeVideoUrl(url: string): boolean {
  return parseYouTubeUrl(url) !== null
}

async function captureYouTubeVideo(metadata: YouTubeUrlMetadata): Promise<YouTubeCapture> {
  const fallbackTitle = `YouTube Video: ${metadata.videoId}`
  let title = fallbackTitle
  let authorName = 'unknown'
  let authorUrl: string | null = null
  let providerName = 'YouTube'
  let thumbnailUrl: string | null = null
  let captureStatus: 'oembed' | 'fallback' = 'fallback'

  try {
    const parsed = JSON.parse(await safeFetchText(metadata.oembedUrl)) as {
      title?: string
      author_name?: string
      author_url?: string
      provider_name?: string
      thumbnail_url?: string
    }

    const parsedTitle = trimOptional(parsed.title)
    if (parsedTitle) {
      title = parsedTitle
      captureStatus = 'oembed'
    }

    authorName = trimOptional(parsed.author_name) ?? authorName
    authorUrl = trimOptional(parsed.author_url)
    providerName = trimOptional(parsed.provider_name) ?? providerName
    thumbnailUrl = trimOptional(parsed.thumbnail_url)
  } catch {
    // Keep the explicit fallback payload below.
  }

  return { title, authorName, authorUrl, providerName, thumbnailUrl, captureStatus }
}

function youTubeHeading(title: string): string {
  return title.startsWith('YouTube Video: ') ? `# ${title}` : `# YouTube Video: ${title}`
}

function youTubeFilename(videoId: string): string {
  return `youtube_${videoId}.md`
}

function renderVideoSummary(captured: YouTubeCapture): string {
  if (captured.captureStatus === 'fallback') {
    return 'Video metadata could not be fetched.'
  }

  if (captured.authorUrl) {
    return `Video by [${captured.authorName}](${captured.authorUrl}).`
  }
  if (captured.authorName !== 'unknown') {
    return `Video by ${captured.authorName}.`
  }
  return 'YouTube video metadata captured via oEmbed.'
}

export async function fetchYouTubeVideo(url: string, options: IngestOptions): Promise<IngestTextAsset> {
  const metadata = parseYouTubeUrl(url)
  if (!metadata) {
    return fetchWebpage(url, options)
  }

  const captured = await captureYouTubeVideo(metadata)
  const capturedAt = new Date().toISOString()
  const contextLines = [
    `- Platform: ${metadata.platform}`,
    `- Video ID: ${metadata.videoId}`,
    ...(captured.authorName !== 'unknown' ? [`- Channel: ${captured.authorName}`] : []),
    `- Capture Status: ${captured.captureStatus}`,
    ...(captured.captureStatus === 'fallback' ? ['- Note: oEmbed unavailable; preserved canonical video URL and derived video metadata only.'] : []),
  ]
  const linkLines = [
    `- [Watch on YouTube](${metadata.sourceUrl})`,
    `- [Embed Player](${metadata.embedUrl})`,
    ...(captured.authorUrl ? [`- [Channel](${captured.authorUrl})`] : []),
    ...(captured.thumbnailUrl ? [`- [Thumbnail](${captured.thumbnailUrl})`] : []),
  ]

  return {
    fileName: youTubeFilename(metadata.videoId),
    content: [
      '---',
      `source_url: ${yamlString(metadata.sourceUrl)}`,
      'type: youtube_video',
      `title: ${yamlString(captured.title)}`,
      `author: ${yamlString(captured.authorName)}`,
      `captured_at: ${yamlString(capturedAt)}`,
      `contributor: ${yamlString(resolveContributor(options))}`,
      `video_platform: ${yamlString(metadata.platform)}`,
      `video_id: ${yamlString(metadata.videoId)}`,
      `video_provider: ${yamlString(captured.providerName)}`,
      `video_capture_status: ${yamlString(captured.captureStatus)}`,
      ...(captured.authorUrl ? [`video_channel_url: ${yamlString(captured.authorUrl)}`] : []),
      ...(captured.thumbnailUrl ? [`video_thumbnail_url: ${yamlString(captured.thumbnailUrl)}`] : []),
      `video_embed_url: ${yamlString(metadata.embedUrl)}`,
      '---',
      '',
      youTubeHeading(captured.title),
      '',
      '## Video',
      '',
      renderVideoSummary(captured),
      '',
      '## Context',
      '',
      ...contextLines,
      '',
      '## Links',
      '',
      ...linkLines,
      '',
      `Source: ${metadata.sourceUrl}`,
      '',
    ].join('\n'),
  }
}
