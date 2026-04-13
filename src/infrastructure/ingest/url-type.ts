import type { UrlType } from './types.js'

export function detectUrlType(url: string): UrlType {
  const lower = url.toLowerCase()
  if (lower.includes('twitter.com') || lower.includes('x.com')) {
    return 'tweet'
  }
  if (lower.includes('arxiv.org')) {
    return 'arxiv'
  }
  if (lower.includes('github.com')) {
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
