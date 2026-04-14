import type { UrlType } from './types.js'
import { isHackerNewsItemUrl } from '../ingest-hackernews.js'
import { isRedditContentUrl } from '../ingest-reddit.js'
import { isTweetPostUrl } from '../ingest-social.js'
import { isYouTubeContentUrl } from '../ingest-youtube.js'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../pipeline/detect.js'

export function detectUrlType(url: string): UrlType {
  const hostname = new URL(url).hostname.toLowerCase()
  const lower = url.toLowerCase()
  if (isTweetPostUrl(url)) {
    return 'tweet'
  }
  if (isRedditContentUrl(url)) {
    return 'reddit'
  }
  if (isHackerNewsItemUrl(url)) {
    return 'hackernews'
  }
  if (lower.includes('arxiv.org')) {
    return 'arxiv'
  }
  if (hostname === 'github.com' || hostname === 'www.github.com') {
    return 'github'
  }
  if (isYouTubeContentUrl(url)) {
    return 'youtube'
  }

  const pathname = new URL(url).pathname.toLowerCase()
  if (pathname.endsWith('.pdf')) {
    return 'pdf'
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].some((extension) => pathname.endsWith(extension))) {
    return 'image'
  }
  if (Array.from(AUDIO_EXTENSIONS).some((extension) => pathname.endsWith(extension))) {
    return 'audio'
  }
  if (Array.from(VIDEO_EXTENSIONS).some((extension) => pathname.endsWith(extension))) {
    return 'video'
  }
  return 'webpage'
}
