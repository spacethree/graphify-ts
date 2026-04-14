import type { IngestTextAsset } from './ingest/dispatch.js'
import type { IngestOptions } from './ingest/types.js'
import { buildWebpageAsset, extractCanonicalUrl, extractMetaContent, extractTitle, fetchWebpage, findCanonicalUrl, resolveContributor, yamlString } from './ingest-web.js'
import { safeFetchText, safeFetchTextWithMetadata } from '../shared/security.js'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])

type YouTubeRouteKind = 'video' | 'playlist' | 'channel'

interface YouTubeBaseMetadata {
  route: YouTubeRouteKind
  sourceUrl: string
  platform: 'youtube'
}

interface YouTubeVideoUrlMetadata extends YouTubeBaseMetadata {
  route: 'video'
  videoId: string
  embedUrl: string
  oembedUrl: string
}

interface YouTubePlaylistUrlMetadata extends YouTubeBaseMetadata {
  route: 'playlist'
  playlistId: string
}

interface YouTubeChannelUrlMetadata extends YouTubeBaseMetadata {
  route: 'channel'
  handle: string | null
  channelId: string | null
  customSlug: string | null
}

interface YouTubeCapture {
  title: string
  authorName: string
  authorUrl: string | null
  providerName: string
  thumbnailUrl: string | null
  chapters: YouTubeVideoChapter[]
  captureStatus: 'oembed' | 'fallback'
}

interface YouTubePlaylistCapture {
  title: string
  authorName: string
  description: string
  thumbnailUrl: string | null
  captureStatus: 'html' | 'fallback'
}

interface YouTubeVideoChapter {
  title: string
  startMillis: number
}

interface YouTubeChannelCapture {
  title: string
  authorName: string
  description: string
  handle: string | null
  channelId: string | null
  customSlug: string | null
  thumbnailUrl: string | null
  captureStatus: 'html' | 'fallback'
}

type YouTubeUrlMetadata = YouTubeVideoUrlMetadata | YouTubePlaylistUrlMetadata | YouTubeChannelUrlMetadata

function isYouTubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.has(hostname.toLowerCase())
}

function isYouTubeVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(value)
}

function isYouTubePlaylistId(value: string): boolean {
  return /^[A-Za-z0-9_-]{2,}$/.test(value)
}

function isYouTubeHandle(value: string): boolean {
  return /^@[A-Za-z0-9._-]{3,30}$/.test(value)
}

function isYouTubeChannelId(value: string): boolean {
  return /^UC[A-Za-z0-9_-]{22}$/.test(value)
}

function isYouTubeCustomSlug(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(value)
}

function normalizeYouTubeHandle(handle: string): string {
  return handle.toLowerCase()
}

function normalizeYouTubeCustomSlug(customSlug: string): string {
  return customSlug.toLowerCase()
}

function trimOptional(value?: string): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function canonicalPlaylistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
}

function canonicalChannelUrl(handle: string): string {
  return `https://www.youtube.com/@${encodeURIComponent(normalizeYouTubeHandle(handle))}`
}

function canonicalChannelIdUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`
}

function canonicalCustomChannelUrl(customSlug: string): string {
  return `https://www.youtube.com/c/${encodeURIComponent(normalizeYouTubeCustomSlug(customSlug))}`
}

function extractPlaylistIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (!isYouTubeHost(hostname) || hostname === 'youtu.be') {
      return null
    }

    const playlistId = parsed.searchParams.get('list')
    return parsed.pathname === '/playlist' && playlistId && isYouTubePlaylistId(playlistId) ? playlistId : null
  } catch {
    return null
  }
}

function extractChannelHandleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (!isYouTubeHost(hostname) || hostname === 'youtu.be') {
      return null
    }

    const handleMatch = /^\/(@[A-Za-z0-9._-]{3,30})$/.exec(parsed.pathname)
    return handleMatch?.[1] && isYouTubeHandle(handleMatch[1]) ? normalizeYouTubeHandle(handleMatch[1].slice(1)) : null
  } catch {
    return null
  }
}

function extractChannelIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (!isYouTubeHost(hostname) || hostname === 'youtu.be') {
      return null
    }

    const channelIdMatch = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(parsed.pathname)
    return channelIdMatch?.[1] && isYouTubeChannelId(channelIdMatch[1]) ? channelIdMatch[1] : null
  } catch {
    return null
  }
}

function extractCustomChannelSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (!isYouTubeHost(hostname) || hostname === 'youtu.be') {
      return null
    }

    const customSlugMatch = /^\/c\/([A-Za-z0-9._-]{1,100})$/.exec(parsed.pathname)
    return customSlugMatch?.[1] && isYouTubeCustomSlug(customSlugMatch[1])
      ? normalizeYouTubeCustomSlug(customSlugMatch[1])
      : null
  } catch {
    return null
  }
}

function parseYouTubeUrl(url: string): YouTubeUrlMetadata | null {
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase()
  if (!isYouTubeHost(hostname)) {
    return null
  }

  const channelHandle = extractChannelHandleFromUrl(url)
  if (channelHandle) {
    return {
      route: 'channel',
      sourceUrl: canonicalChannelUrl(channelHandle),
      handle: channelHandle,
      channelId: null,
      customSlug: null,
      platform: 'youtube',
    }
  }

  const channelId = extractChannelIdFromUrl(url)
  if (channelId) {
    return {
      route: 'channel',
      sourceUrl: canonicalChannelIdUrl(channelId),
      handle: null,
      channelId,
      customSlug: null,
      platform: 'youtube',
    }
  }

  const customSlug = extractCustomChannelSlugFromUrl(url)
  if (customSlug) {
    return {
      route: 'channel',
      sourceUrl: canonicalCustomChannelUrl(customSlug),
      handle: null,
      channelId: null,
      customSlug,
      platform: 'youtube',
    }
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  const segments = normalizedPath.split('/').filter(Boolean)
  let videoId: string | null = null
  if (hostname === 'youtu.be') {
    if (segments.length === 1 && isYouTubeVideoId(segments[0] ?? '')) {
      videoId = segments[0] ?? null
    }
  } else if (parsed.pathname === '/playlist') {
    const playlistId = parsed.searchParams.get('list')
    if (playlistId && isYouTubePlaylistId(playlistId)) {
      return {
        route: 'playlist',
        sourceUrl: canonicalPlaylistUrl(playlistId),
        playlistId,
        platform: 'youtube',
      }
    }
  } else if (normalizedPath === '/watch') {
    const candidate = parsed.searchParams.get('v')
    if (candidate && isYouTubeVideoId(candidate)) {
      videoId = candidate
    }
  } else if ((segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live') && segments.length === 2 && isYouTubeVideoId(segments[1] ?? '')) {
    videoId = segments[1] ?? null
  }

  if (!videoId) {
    return null
  }

  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`
  return {
    route: 'video',
    sourceUrl,
    videoId,
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    oembedUrl: `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`,
    platform: 'youtube',
  }
}

export function isYouTubeContentUrl(url: string): boolean {
  return parseYouTubeUrl(url) !== null
}

function extractYouTubeVideoIdFromUrl(url: string): string | null {
  const metadata = parseYouTubeUrl(url)
  return metadata?.route === 'video' ? metadata.videoId : null
}

function extractYouTubeVideoChaptersFromHtml(html: string): YouTubeVideoChapter[] {
  const chapters: YouTubeVideoChapter[] = []
  const seen = new Set<string>()
  const chapterPattern =
    /"chapterRenderer"\s*:\s*\{[\s\S]*?"title"\s*:\s*\{[\s\S]*?(?:"simpleText"\s*:\s*"([^"]+)"|"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)")[\s\S]*?"timeRangeStartMillis"\s*:\s*(\d+)/gi

  for (const match of html.matchAll(chapterPattern)) {
    const title = trimOptional(match[1] ?? match[2])
    const startMillis = Number.parseInt(match[3] ?? '', 10)
    if (!title || Number.isNaN(startMillis)) {
      continue
    }

    const key = `${startMillis}:${title}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    chapters.push({ title, startMillis })
  }

  return chapters.sort((left, right) => left.startMillis - right.startMillis)
}

function confirmVideoRoute(html: string, metadata: YouTubeVideoUrlMetadata, finalUrl: string): boolean {
  const canonicalVideoId = extractYouTubeVideoIdFromUrl(extractCanonicalUrl(html, finalUrl))
  const finalVideoId = extractYouTubeVideoIdFromUrl(finalUrl)
  return canonicalVideoId === metadata.videoId || finalVideoId === metadata.videoId
}

async function captureYouTubeVideo(metadata: YouTubeVideoUrlMetadata): Promise<YouTubeCapture> {
  const fallbackTitle = `YouTube Video: ${metadata.videoId}`
  let title = fallbackTitle
  let authorName = 'unknown'
  let authorUrl: string | null = null
  let providerName = 'YouTube'
  let thumbnailUrl: string | null = null
  let chapters: YouTubeVideoChapter[] = []
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

    if (captureStatus === 'oembed') {
      try {
        const { text: html, finalUrl } = await safeFetchTextWithMetadata(metadata.sourceUrl)
        if (confirmVideoRoute(html, metadata, finalUrl)) {
          chapters = extractYouTubeVideoChaptersFromHtml(html)
        }
      } catch {
        // Keep chapter context optional so successful oEmbed metadata still lands.
      }
    }
  } catch {
    // Keep the explicit fallback payload below.
  }

  return { title, authorName, authorUrl, providerName, thumbnailUrl, chapters, captureStatus }
}

function stripYouTubeTitleSuffix(value: string): string {
  return value.replace(/\s*-\s*YouTube$/i, '').trim()
}

function hasPlaylistPageMarker(html: string): boolean {
  return (
    /"playlistSidebarPrimaryInfoRenderer"\s*:/i.test(html) ||
    /"playlistMetadataRenderer"\s*:/i.test(html) ||
    /<ytd-playlist-sidebar-primary-info-renderer\b/i.test(html) ||
    /<ytd-playlist-header-renderer\b/i.test(html)
  )
}

function confirmPlaylistRoute(html: string, metadata: YouTubePlaylistUrlMetadata): boolean {
  const canonicalPlaylistId = extractPlaylistIdFromUrl(extractCanonicalUrl(html, metadata.sourceUrl))
  return canonicalPlaylistId === metadata.playlistId && hasPlaylistPageMarker(html)
}

function hasChannelPageMarker(html: string): boolean {
  return (
    /"channelMetadataRenderer"\s*:/i.test(html) ||
    /"c4TabbedHeaderRenderer"\s*:/i.test(html) ||
    /<ytd-c4-tabbed-header-renderer\b/i.test(html)
  )
}

function extractChannelHandleFromHtml(html: string): string | null {
  const handleTextMatch = /"channelHandleText"\s*:\s*\{[\s\S]*?"simpleText"\s*:\s*"(@[A-Za-z0-9._-]{3,30})"/i.exec(html)
  if (handleTextMatch?.[1]) {
    return normalizeYouTubeHandle(handleTextMatch[1].slice(1))
  }

  const vanityUrlMatch = /"vanityChannelUrl"\s*:\s*"https?:\/\/www\.youtube\.com\/(@[A-Za-z0-9._-]{3,30})"/i.exec(html)
  return vanityUrlMatch?.[1] ? normalizeYouTubeHandle(vanityUrlMatch[1].slice(1)) : null
}

function extractChannelId(html: string): string | null {
  return /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/i.exec(html)?.[1] ?? null
}

function extractCustomChannelSlugFromHtml(html: string): string | null {
  const vanityUrlMatch = /"vanityChannelUrl"\s*:\s*"https?:\/\/www\.youtube\.com\/c\/([A-Za-z0-9._-]{1,100})"/i.exec(html)
  return vanityUrlMatch?.[1] ? normalizeYouTubeCustomSlug(vanityUrlMatch[1]) : null
}

function resolveConfirmedCustomSlug(html: string, metadata: YouTubeChannelUrlMetadata, finalUrl: string): string | null {
  if (metadata.customSlug === null) {
    return null
  }

  const canonicalUrl = findCanonicalUrl(html)
  const canonicalCustomSlug = canonicalUrl ? extractCustomChannelSlugFromUrl(canonicalUrl) : null
  const htmlCustomSlug = extractCustomChannelSlugFromHtml(html)
  const finalCustomSlug = extractCustomChannelSlugFromUrl(finalUrl)
  return canonicalCustomSlug === metadata.customSlug || htmlCustomSlug === metadata.customSlug || finalCustomSlug === metadata.customSlug
    ? metadata.customSlug
    : null
}

function confirmChannelRoute(html: string, metadata: YouTubeChannelUrlMetadata, finalUrl: string): boolean {
  if (!hasChannelPageMarker(html)) {
    return false
  }

  const canonicalUrl = findCanonicalUrl(html)
  const canonicalHandle = canonicalUrl ? extractChannelHandleFromUrl(canonicalUrl) : null
  const canonicalChannelId = canonicalUrl ? extractChannelIdFromUrl(canonicalUrl) : null
  const canonicalCustomSlug = canonicalUrl ? extractCustomChannelSlugFromUrl(canonicalUrl) : null
  if (canonicalUrl && !canonicalHandle && !canonicalChannelId && !canonicalCustomSlug) {
    return false
  }

  const finalHandle = extractChannelHandleFromUrl(finalUrl)
  const finalChannelId = extractChannelIdFromUrl(finalUrl)
  const finalCustomSlug = extractCustomChannelSlugFromUrl(finalUrl)
  if (metadata.customSlug !== null && finalHandle === null && finalChannelId === null && finalCustomSlug === null) {
    return false
  }

  const htmlHandle = extractChannelHandleFromHtml(html)
  const htmlChannelId = extractChannelId(html)
  const htmlCustomSlug = extractCustomChannelSlugFromHtml(html)
  const handleMatches = metadata.handle !== null && (canonicalHandle === metadata.handle || htmlHandle === metadata.handle || finalHandle === metadata.handle)
  const channelIdMatches =
    metadata.channelId !== null && (canonicalChannelId === metadata.channelId || htmlChannelId === metadata.channelId || finalChannelId === metadata.channelId)
  const customSlugMatches =
    metadata.customSlug !== null &&
    (canonicalCustomSlug === metadata.customSlug || htmlCustomSlug === metadata.customSlug || finalCustomSlug === metadata.customSlug)
  if (channelIdMatches || handleMatches || customSlugMatches) {
    return true
  }

  if (
    metadata.channelId !== null &&
    canonicalChannelId === null &&
    htmlChannelId === null &&
    finalChannelId === null &&
    (canonicalHandle !== null || htmlHandle !== null || finalHandle !== null)
  ) {
    return true
  }

  return metadata.customSlug !== null && finalCustomSlug === null && (finalHandle !== null || finalChannelId !== null)
}

async function captureYouTubePlaylist(
  metadata: YouTubePlaylistUrlMetadata,
): Promise<{ kind: 'playlist'; capture: YouTubePlaylistCapture } | { kind: 'webpage'; html: string }> {
  try {
    const html = await safeFetchText(metadata.sourceUrl)
    if (!confirmPlaylistRoute(html, metadata)) {
      return { kind: 'webpage', html }
    }

    const title = stripYouTubeTitleSuffix(extractMetaContent(html, 'property', 'og:title') || extractTitle(html, `YouTube Playlist: ${metadata.playlistId}`))
    return {
      kind: 'playlist',
      capture: {
        title: title || `YouTube Playlist: ${metadata.playlistId}`,
        authorName: trimOptional(extractMetaContent(html, 'name', 'author')) ?? 'unknown',
        description: trimOptional(extractMetaContent(html, 'name', 'description') || extractMetaContent(html, 'property', 'og:description')) ?? '',
        thumbnailUrl: trimOptional(extractMetaContent(html, 'property', 'og:image')),
        captureStatus: 'html',
      },
    }
  } catch {
    return {
      kind: 'playlist',
      capture: {
        title: `YouTube Playlist: ${metadata.playlistId}`,
        authorName: 'unknown',
        description: '',
        thumbnailUrl: null,
        captureStatus: 'fallback',
      },
    }
  }
}

async function captureYouTubeChannel(
  metadata: YouTubeChannelUrlMetadata,
): Promise<{ kind: 'channel'; capture: YouTubeChannelCapture } | { kind: 'webpage'; html: string }> {
  const fallbackTitle = metadata.handle
    ? `YouTube Channel: @${metadata.handle}`
    : metadata.channelId
      ? `YouTube Channel: ${metadata.channelId}`
      : metadata.customSlug
        ? `YouTube Channel: /c/${metadata.customSlug}`
        : `YouTube Channel: ${metadata.sourceUrl}`
  const fallbackAuthorName = metadata.handle ? `@${metadata.handle}` : 'unknown'

  try {
    const { text: html, finalUrl } = await safeFetchTextWithMetadata(metadata.sourceUrl)
    if (!confirmChannelRoute(html, metadata, finalUrl)) {
      return { kind: 'webpage', html }
    }

    const resolvedHandle = extractChannelHandleFromHtml(html) ?? metadata.handle
    const resolvedChannelId = extractChannelId(html) ?? metadata.channelId
    const resolvedCustomSlug = resolveConfirmedCustomSlug(html, metadata, finalUrl)
    const title = stripYouTubeTitleSuffix(extractMetaContent(html, 'property', 'og:title') || extractTitle(html, fallbackTitle))
    return {
      kind: 'channel',
      capture: {
        title: title || fallbackTitle,
        authorName: trimOptional(extractMetaContent(html, 'name', 'author')) ?? (title || fallbackAuthorName),
        description: trimOptional(extractMetaContent(html, 'name', 'description') || extractMetaContent(html, 'property', 'og:description')) ?? '',
        handle: resolvedHandle,
        channelId: resolvedChannelId,
        customSlug: resolvedCustomSlug,
        thumbnailUrl: trimOptional(extractMetaContent(html, 'property', 'og:image')),
        captureStatus: 'html',
      },
    }
  } catch {
    return {
      kind: 'channel',
      capture: {
        title: fallbackTitle,
        authorName: fallbackAuthorName,
        description: '',
        handle: metadata.handle,
        channelId: metadata.channelId,
        customSlug: metadata.customSlug,
        thumbnailUrl: null,
        captureStatus: 'fallback',
      },
    }
  }
}

function youTubeHeading(title: string): string {
  return title.startsWith('YouTube Video: ') ? `# ${title}` : `# YouTube Video: ${title}`
}

function youTubeFilename(videoId: string): string {
  return `youtube_${videoId}.md`
}

function formatYouTubeChapterTimestamp(startMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(startMillis / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function youTubePlaylistHeading(title: string): string {
  return title.startsWith('YouTube Playlist: ') ? `# ${title}` : `# YouTube Playlist: ${title}`
}

function youTubePlaylistFilename(playlistId: string): string {
  return `youtube_playlist_${playlistId}.md`
}

function youTubeChannelHeading(title: string): string {
  return title.startsWith('YouTube Channel: ') ? `# ${title}` : `# YouTube Channel: ${title}`
}

function youTubeChannelFilename(identifier: string): string {
  return `youtube_channel_${identifier}.md`
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

function renderPlaylistSummary(captured: YouTubePlaylistCapture): string {
  if (captured.captureStatus === 'fallback') {
    return 'Playlist metadata could not be fetched.'
  }

  if (captured.authorName !== 'unknown') {
    return `Playlist by ${captured.authorName}.`
  }

  return 'YouTube playlist metadata captured from the webpage.'
}

function renderChannelSummary(metadata: YouTubeChannelUrlMetadata, captured: YouTubeChannelCapture): string {
  if (captured.captureStatus === 'fallback') {
    return 'Channel metadata could not be fetched.'
  }

  const resolvedHandle = captured.handle ?? metadata.handle
  if (resolvedHandle) {
    return `YouTube channel @${resolvedHandle}.`
  }

  const resolvedChannelId = captured.channelId ?? metadata.channelId
  if (resolvedChannelId) {
    return `YouTube channel ${resolvedChannelId}.`
  }

  return 'YouTube channel metadata captured from the webpage.'
}

function channelFallbackMetadataLabel(handle: string | null, channelId: string | null, customSlug: string | null): string {
  const labels = [
    ...(handle ? ['handle'] : []),
    ...(channelId ? ['channel-id'] : []),
    ...(customSlug ? ['custom-channel'] : []),
  ]
  return labels.length > 0 ? labels.join('/') : 'channel'
}

async function fetchYouTubeVideoAsset(metadata: YouTubeVideoUrlMetadata, options: IngestOptions): Promise<IngestTextAsset> {
  const captured = await captureYouTubeVideo(metadata)
  const capturedAt = new Date().toISOString()
  const contextLines = [
    `- Platform: ${metadata.platform}`,
    `- Video ID: ${metadata.videoId}`,
    ...(captured.authorName !== 'unknown' ? [`- Channel: ${captured.authorName}`] : []),
    ...(captured.chapters.length > 0 ? [`- Chapters: ${captured.chapters.length}`] : []),
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
      ...(captured.chapters.length > 0 ? [`video_chapter_count: ${captured.chapters.length}`] : []),
      ...(captured.thumbnailUrl ? [`video_thumbnail_url: ${yamlString(captured.thumbnailUrl)}`] : []),
      `video_embed_url: ${yamlString(metadata.embedUrl)}`,
      '---',
      '',
      youTubeHeading(captured.title),
      '',
      '## Video',
      '',
      renderVideoSummary(captured),
      ...(captured.chapters.length > 0
        ? [
            '',
            '## Chapters',
            '',
            ...captured.chapters.map((chapter) => `- ${formatYouTubeChapterTimestamp(chapter.startMillis)} ${chapter.title}`),
          ]
        : []),
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

async function fetchYouTubePlaylistAsset(metadata: YouTubePlaylistUrlMetadata, options: IngestOptions): Promise<IngestTextAsset> {
  const capturedResult = await captureYouTubePlaylist(metadata)
  if (capturedResult.kind === 'webpage') {
    return buildWebpageAsset(metadata.sourceUrl, capturedResult.html, options)
  }

  const captured = capturedResult.capture
  const capturedAt = new Date().toISOString()
  const contextLines = [
    `- Platform: ${metadata.platform}`,
    '- Kind: playlist',
    `- Playlist ID: ${metadata.playlistId}`,
    `- Capture Status: ${captured.captureStatus}`,
    ...(captured.captureStatus === 'fallback' ? ['- Note: playlist metadata unavailable; preserved canonical playlist URL and derived playlist metadata only.'] : []),
  ]
  const linkLines = [
    `- [Open Playlist](${metadata.sourceUrl})`,
    ...(captured.thumbnailUrl ? [`- [Thumbnail](${captured.thumbnailUrl})`] : []),
  ]

  return {
    fileName: youTubePlaylistFilename(metadata.playlistId),
    content: [
      '---',
      `source_url: ${yamlString(metadata.sourceUrl)}`,
      'type: youtube_playlist',
      `title: ${yamlString(captured.title)}`,
      `author: ${yamlString(captured.authorName)}`,
      ...(captured.description ? [`description: ${yamlString(captured.description)}`] : []),
      `captured_at: ${yamlString(capturedAt)}`,
      `contributor: ${yamlString(resolveContributor(options))}`,
      `youtube_platform: ${yamlString(metadata.platform)}`,
      `youtube_kind: ${yamlString('playlist')}`,
      `youtube_playlist_id: ${yamlString(metadata.playlistId)}`,
      `youtube_capture_status: ${yamlString(captured.captureStatus)}`,
      ...(captured.thumbnailUrl ? [`youtube_thumbnail_url: ${yamlString(captured.thumbnailUrl)}`] : []),
      '---',
      '',
      youTubePlaylistHeading(captured.title),
      '',
      '## Playlist',
      '',
      renderPlaylistSummary(captured),
      ...(captured.description ? ['', captured.description] : []),
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

async function fetchYouTubeChannelAsset(metadata: YouTubeChannelUrlMetadata, options: IngestOptions): Promise<IngestTextAsset> {
  const capturedResult = await captureYouTubeChannel(metadata)
  if (capturedResult.kind === 'webpage') {
    return buildWebpageAsset(metadata.sourceUrl, capturedResult.html, options)
  }

  const captured = capturedResult.capture
  const resolvedHandle = captured.handle ?? metadata.handle
  const resolvedChannelId = captured.channelId ?? metadata.channelId
  const resolvedCustomSlug = captured.customSlug
  const sourceUrl = resolvedHandle ? canonicalChannelUrl(resolvedHandle) : metadata.sourceUrl
  const capturedAt = new Date().toISOString()
  const contextLines = [
    `- Platform: ${metadata.platform}`,
    '- Kind: channel',
    ...(resolvedHandle ? [`- Handle: @${resolvedHandle}`] : []),
    ...(resolvedChannelId ? [`- Channel ID: ${resolvedChannelId}`] : []),
    ...(resolvedCustomSlug ? [`- Custom URL: /c/${resolvedCustomSlug}`] : []),
    `- Capture Status: ${captured.captureStatus}`,
    ...(captured.captureStatus === 'fallback'
      ? [
          `- Note: channel metadata unavailable; preserved canonical channel URL and derived ${channelFallbackMetadataLabel(
            resolvedHandle,
            resolvedChannelId,
            resolvedCustomSlug,
          )} metadata only.`,
        ]
      : []),
  ]
  const linkLines = [
    `- [Open Channel](${sourceUrl})`,
    ...(captured.thumbnailUrl ? [`- [Thumbnail](${captured.thumbnailUrl})`] : []),
  ]

  return {
    fileName: youTubeChannelFilename(resolvedHandle ?? resolvedCustomSlug ?? resolvedChannelId ?? 'channel'),
    content: [
      '---',
      `source_url: ${yamlString(sourceUrl)}`,
      'type: youtube_channel',
      `title: ${yamlString(captured.title)}`,
      `author: ${yamlString(captured.authorName)}`,
      ...(captured.description ? [`description: ${yamlString(captured.description)}`] : []),
      `captured_at: ${yamlString(capturedAt)}`,
      `contributor: ${yamlString(resolveContributor(options))}`,
      `youtube_platform: ${yamlString(metadata.platform)}`,
      `youtube_kind: ${yamlString('channel')}`,
      ...(resolvedHandle ? [`youtube_channel_handle: ${yamlString(resolvedHandle)}`] : []),
      ...(resolvedChannelId ? [`youtube_channel_id: ${yamlString(resolvedChannelId)}`] : []),
      ...(resolvedCustomSlug ? [`youtube_channel_custom_slug: ${yamlString(resolvedCustomSlug)}`] : []),
      `youtube_capture_status: ${yamlString(captured.captureStatus)}`,
      ...(captured.thumbnailUrl ? [`youtube_thumbnail_url: ${yamlString(captured.thumbnailUrl)}`] : []),
      '---',
      '',
      youTubeChannelHeading(captured.title),
      '',
      '## Channel',
      '',
      renderChannelSummary(metadata, captured),
      ...(captured.description ? ['', captured.description] : []),
      '',
      '## Context',
      '',
      ...contextLines,
      '',
      '## Links',
      '',
      ...linkLines,
      '',
      `Source: ${sourceUrl}`,
      '',
    ].join('\n'),
  }
}

export async function fetchYouTubeAsset(url: string, options: IngestOptions): Promise<IngestTextAsset> {
  const metadata = parseYouTubeUrl(url)
  if (!metadata) {
    return fetchWebpage(url, options)
  }

  if (metadata.route === 'playlist') {
    return fetchYouTubePlaylistAsset(metadata, options)
  }
  if (metadata.route === 'channel') {
    return fetchYouTubeChannelAsset(metadata, options)
  }
  return fetchYouTubeVideoAsset(metadata, options)
}
