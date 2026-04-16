import type { IngestTextAsset } from './ingest/dispatch.js'
import type { IngestOptions } from './ingest/types.js'
import { safeFetchText } from '../shared/security.js'

const MAX_EXTRACTED_TEXT_LENGTH = 12_000
const HTML_ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

interface LinkReference {
  label: string
  url: string
}

interface StructuredSection {
  title: string
  content: string
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeMarkdown(value: string): string {
  const lines = value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => normalizeWhitespace(line))

  const normalized: string[] = []
  for (const line of lines) {
    if (!line) {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== '') {
        normalized.push('')
      }
      continue
    }

    normalized.push(line)
  }

  while (normalized[0] === '') {
    normalized.shift()
  }
  while (normalized[normalized.length - 1] === '') {
    normalized.pop()
  }

  return normalized.join('\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function yamlString(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, ' '))
}

export function safeFilename(url: string, suffix: string): string {
  const parsed = new URL(url)
  const base = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^\w-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

  return `${base || 'resource'}${suffix}`
}

export function resolveContributor(options: IngestOptions): string {
  return options.contributor ?? options.author ?? 'unknown'
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized.startsWith('#x')) {
      const parsed = Number.parseInt(normalized.slice(2), 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    }

    if (normalized.startsWith('#')) {
      const parsed = Number.parseInt(normalized.slice(1), 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    }

    return HTML_ENTITY_MAP[normalized] ?? match
  })
}

export function stripHtml(value: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(
      value
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
}

function stripHtmlPreservingNewlines(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
}

function extractTagAttribute(tag: string, attribute: string): string {
  const pattern = new RegExp(`${escapeRegExp(attribute)}=["']([\\s\\S]*?)["']`, 'i')
  const match = pattern.exec(tag)
  return normalizeWhitespace(decodeHtmlEntities(match?.[1] ?? ''))
}

export function extractMetaContent(html: string, attribute: 'name' | 'property' | 'itemprop', key: string): string {
  const patterns = [
    new RegExp(`<meta\\b[^>]*${attribute}=["']${escapeRegExp(key)}["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b[^>]*content=["'][\\s\\S]*?["'][^>]*${attribute}=["']${escapeRegExp(key)}["'][^>]*>`, 'i'),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[0]) {
      const content = extractTagAttribute(match[0], 'content')
      if (content) {
        return stripHtml(content)
      }
    }
  }

  return ''
}

export function findCanonicalUrl(html: string): string {
  const patterns = [
    /<link\b[^>]*rel=["']canonical["'][^>]*>/i,
    /<link\b[^>]*href=["'][\s\S]*?["'][^>]*rel=["']canonical["'][^>]*>/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[0]) {
      const href = extractTagAttribute(match[0], 'href')
      if (href) {
        return href
      }
    }
  }

  return extractMetaContent(html, 'property', 'og:url')
}

export function extractCanonicalUrl(html: string, fallback: string): string {
  const rawCanonicalUrl = findCanonicalUrl(html)
  if (!rawCanonicalUrl) {
    return fallback
  }

  try {
    const resolved = new URL(rawCanonicalUrl, fallback)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return fallback
    }
    return resolved.toString()
  } catch {
    return fallback
  }
}

export function extractTitle(html: string, fallback: string): string {
  const ogTitle = extractMetaContent(html, 'property', 'og:title')
  if (ogTitle) {
    return ogTitle
  }

  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match?.[1] ? stripHtml(match[1]) : fallback
}

export function extractTextContent(html: string): string {
  return stripHtml(html).slice(0, MAX_EXTRACTED_TEXT_LENGTH)
}

function extractMetaAuthor(html: string): string {
  return extractMetaContent(html, 'name', 'author') || extractMetaContent(html, 'property', 'article:author') || extractMetaContent(html, 'name', 'byl')
}

function extractMetaDescription(html: string): string {
  return extractMetaContent(html, 'name', 'description') || extractMetaContent(html, 'property', 'og:description')
}

function normalizeComparableText(value: string): string {
  return normalizeWhitespace(value).toLowerCase()
}

function resolveHttpUrl(href: string, baseUrl: string): string {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#')) {
    return ''
  }

  const lower = trimmed.toLowerCase()
  if (lower.startsWith('mailto:') || lower.startsWith('javascript:') || lower.startsWith('tel:')) {
    return ''
  }

  try {
    const resolved = new URL(trimmed, baseUrl)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return ''
    }
    return resolved.toString()
  } catch {
    return ''
  }
}

function orderedUniqueLinks(links: LinkReference[]): LinkReference[] {
  const seen = new Set<string>()
  const unique: LinkReference[] = []
  for (const link of links) {
    if (seen.has(link.url)) {
      continue
    }
    seen.add(link.url)
    unique.push(link)
  }
  return unique
}

function extractAnchorLinks(html: string, baseUrl: string): LinkReference[] {
  const links: LinkReference[] = []
  for (const match of html.matchAll(/<a\b[^>]*href=["']([\s\S]*?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = resolveHttpUrl(match[1] ?? '', baseUrl)
    const label = stripHtml(match[2] ?? '')
    if (!url || !label) {
      continue
    }
    links.push({ label, url })
  }
  return orderedUniqueLinks(links)
}

function replaceAnchorsWithMarkdown(html: string, baseUrl: string): string {
  return html.replace(/<a\b[^>]*href=["']([\s\S]*?)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, rawHref: string, rawLabel: string) => {
    const label = stripHtml(rawLabel)
    if (!label) {
      return ''
    }

    const url = resolveHttpUrl(rawHref, baseUrl)
    return url ? `[${label}](${url})` : label
  })
}

function extractBalancedElementInnerHtml(html: string, pattern: RegExp): string {
  const match = pattern.exec(html)
  if (!match?.[0] || match.index < 0) {
    return ''
  }

  const tagName = (match[1] ?? '').toLowerCase()
  if (!tagName) {
    return ''
  }

  const startIndex = match.index + match[0].length
  const tokenPattern = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, 'gi')
  tokenPattern.lastIndex = startIndex
  let depth = 1

  for (let token = tokenPattern.exec(html); token; token = tokenPattern.exec(html)) {
    const source = token[0].toLowerCase()
    if (source.startsWith(`</${tagName}`)) {
      depth -= 1
    } else if (!source.endsWith('/>')) {
      depth += 1
    }

    if (depth === 0) {
      return html.slice(startIndex, token.index)
    }
  }

  return ''
}

function extractContentHtml(html: string): string {
  return extractBalancedElementInnerHtml(html, /<(article)\b[^>]*>/i) || extractBalancedElementInnerHtml(html, /<(main)\b[^>]*>/i)
}

function renderHtmlFragmentAsMarkdown(html: string): string {
  const withStructure = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|section|article|main|header|footer|aside|blockquote)[^>]*>/gi, '\n\n')
    .replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')

  return normalizeMarkdown(stripHtmlPreservingNewlines(withStructure))
}

function extractStructuredSections(contentHtml: string, pageTitle: string, baseUrl: string): { intro: string; sections: StructuredSection[] } {
  const linkedHtml = replaceAnchorsWithMarkdown(contentHtml, baseUrl)
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  const headings = [...linkedHtml.matchAll(headingPattern)].map((match) => ({
    title: stripHtml(match[2] ?? ''),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }))

  if (headings.length === 0) {
    return {
      intro: renderHtmlFragmentAsMarkdown(linkedHtml),
      sections: [],
    }
  }

  const introParts: string[] = []
  const beforeFirstHeading = renderHtmlFragmentAsMarkdown(linkedHtml.slice(0, headings[0]!.start))
  if (beforeFirstHeading) {
    introParts.push(beforeFirstHeading)
  }

  const sections: StructuredSection[] = []
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    const nextStart = headings[index + 1]?.start ?? linkedHtml.length
    const content = renderHtmlFragmentAsMarkdown(linkedHtml.slice(heading.end, nextStart))

    if (index === 0 && normalizeComparableText(heading.title) === normalizeComparableText(pageTitle)) {
      if (content) {
        introParts.push(content)
      }
      continue
    }

    if (!heading.title) {
      continue
    }

    sections.push({
      title: heading.title,
      content,
    })
  }

  return {
    intro: normalizeMarkdown(introParts.join('\n\n')),
    sections,
  }
}

export function buildWebpageAsset(url: string, html: string, options: IngestOptions): IngestTextAsset {
  const canonicalUrl = extractCanonicalUrl(html, url)
  const title = extractTitle(html, canonicalUrl)
  const author = extractMetaAuthor(html)
  const description = extractMetaDescription(html)
  const contentHtml = extractContentHtml(html)
  const outboundLinks = contentHtml ? extractAnchorLinks(contentHtml, canonicalUrl) : []
  const structuredContent = contentHtml ? extractStructuredSections(contentHtml, title, canonicalUrl) : { intro: '', sections: [] }
  const capturedAt = new Date().toISOString()

  if (contentHtml && (author || description || outboundLinks.length > 0 || structuredContent.sections.length > 0)) {
    const lines = [
      '---',
      `source_url: ${yamlString(canonicalUrl)}`,
      'type: webpage',
      `title: ${yamlString(title)}`,
      ...(author ? [`author: ${yamlString(author)}`] : []),
      ...(description ? [`description: ${yamlString(description)}`] : []),
      `captured_at: ${yamlString(capturedAt)}`,
      `contributor: ${yamlString(resolveContributor(options))}`,
      ...(outboundLinks.length > 0 ? [`outbound_links: [${outboundLinks.map((link) => yamlString(link.url)).join(', ')}]`] : []),
      '---',
      '',
      `# ${title}`,
      '',
      `Source: ${canonicalUrl}`,
      ...(author ? ['', `**Author:** ${author}`] : []),
      ...(description ? ['', '## Summary', '', description] : []),
      ...(structuredContent.intro ? ['', structuredContent.intro] : []),
    ]

    for (const section of structuredContent.sections) {
      lines.push('', `## ${section.title}`)
      if (section.content) {
        lines.push('', section.content)
      }
    }

    if (outboundLinks.length > 0) {
      lines.push('', '## Outbound Links', '')
      for (const link of outboundLinks) {
        lines.push(`- [${link.label}](${link.url})`)
      }
    }

    return {
      fileName: safeFilename(canonicalUrl, '.md'),
      content: `${lines.join('\n')}\n`,
    }
  }

  return {
    fileName: safeFilename(canonicalUrl, '.md'),
    content: `---\nsource_url: ${yamlString(canonicalUrl)}\ntype: webpage\ntitle: ${yamlString(title)}\ncaptured_at: ${yamlString(capturedAt)}\ncontributor: ${yamlString(resolveContributor(options))}\n---\n\n# ${title}\n\nSource: ${canonicalUrl}\n\n---\n\n${extractTextContent(html)}\n`,
  }
}

export async function fetchWebpage(url: string, options: IngestOptions): Promise<IngestTextAsset> {
  const html = await safeFetchText(url)
  return buildWebpageAsset(url, html, options)
}
