import type { UrlType } from './types.js'
import { isTweetPostUrl } from '../ingest-social.js'

export function detectUrlType(url: string): UrlType {
  const hostname = new URL(url).hostname.toLowerCase()
  const lower = url.toLowerCase()
  if (isTweetPostUrl(url)) {
    return 'tweet'
  }
  if (lower.includes('arxiv.org')) {
    return 'arxiv'
  }
  if (hostname === 'github.com' || hostname === 'www.github.com') {
    return 'github'
  }
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
    return 'youtube'
  }

  const pathname = new URL(url).pathname.toLowerCase()
  if (pathname.endsWith('.pdf')) {
    return 'pdf'
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].some((extension) => pathname.endsWith(extension))) {
    return 'image'
  }
  return 'webpage'
}
