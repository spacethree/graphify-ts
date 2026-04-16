import type { IngestTextAsset } from './ingest/dispatch.js'
import type { IngestOptions } from './ingest/types.js'
import { safeFetchText } from '../shared/security.js'
import { buildWebpageAsset, extractCanonicalUrl, extractMetaContent, extractTitle, findCanonicalUrl, resolveContributor, safeFilename, stripHtml, yamlString } from './ingest-web.js'

type GitHubRouteKind = 'repository' | 'issue' | 'pull_request' | 'discussion' | 'commit'

interface GitHubRoute {
  owner: string
  repo: string
  kind: GitHubRouteKind
  number?: string
  commitSha?: string
}

function isGitHubCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value)
}

function parseGitHubRoute(url: string): GitHubRoute | null {
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return null
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    return null
  }

  const owner = segments[0] ?? ''
  const repo = segments[1] ?? ''
  if (!owner || !repo) {
    return null
  }

  if (segments.length === 2) {
    return { owner, repo, kind: 'repository' }
  }

  const section = segments[2]
  const number = segments[3]
  if (!number) {
    return null
  }

  if (section === 'issues' && /^\d+$/.test(number)) {
    return { owner, repo, kind: 'issue', number }
  }
  if (section === 'pull' && /^\d+$/.test(number)) {
    return { owner, repo, kind: 'pull_request', number }
  }
  if (section === 'discussions' && /^\d+$/.test(number)) {
    return { owner, repo, kind: 'discussion', number }
  }
  if (section === 'commit' && segments.length === 4 && isGitHubCommitSha(number)) {
    return { owner, repo, kind: 'commit', commitSha: number }
  }

  return null
}

function uniqueText(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function extractFirstMatch(html: string, patterns: readonly RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    const text = stripHtml(match?.[1] ?? '')
    if (text) {
      return text
    }
  }

  return ''
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

function extractAllMatches(html: string, pattern: RegExp): string[] {
  const values: string[] = []
  for (const match of html.matchAll(pattern)) {
    const text = stripHtml(match[1] ?? '')
    if (text) {
      values.push(text)
    }
  }
  return uniqueText(values)
}

function frontmatterList(key: string, values: string[]): string | null {
  const normalized = uniqueText(values)
  if (normalized.length === 0) {
    return null
  }

  return `${key}: [${normalized.map((value) => yamlString(value)).join(', ')}]`
}

function stripGitHubTitleSuffix(value: string): string {
  return value.replace(/\s+·\s+(Issue|Pull Request|Discussion)\s+#\d+\s+·\s+.+$/i, '').trim()
}

function stripGitHubCommitTitleSuffix(value: string): string {
  return value.replace(/\s+·\s+[^·]+\/[^·]+\s+·\s+GitHub$/i, '').trim()
}

function extractGitHubTitle(html: string, fallback: string): string {
  const title =
    extractFirstMatch(html, [/<span[^>]*class="[^"]*\bjs-issue-title\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i]) ||
    extractMetaContent(html, 'property', 'og:title') ||
    stripGitHubTitleSuffix(extractTitle(html, fallback))

  return title || fallback
}

function extractGitHubState(html: string): string {
  const rawState = extractFirstMatch(html, [/<span[^>]*class="[^"]*\bState\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i])
  return rawState.toLowerCase().replace(/\s+/g, '_')
}

function extractGitHubAuthor(html: string): string {
  return extractFirstMatch(html, [/<a[^>]*class="[^"]*\bauthor\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i])
}

function extractGitHubBody(html: string): string {
  const nestedBody = extractBalancedElementInnerHtml(html, /<(div|td)\b[^>]*class=["'][^"']*\bcomment-body\b[^"']*["'][^>]*>/i)
  if (nestedBody) {
    return stripHtml(nestedBody)
  }

  return extractFirstMatch(html, [/<(?:div|td)[^>]*class=["'][^"']*\bcomment-body\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|td)>/i])
}

function extractGitHubLabels(html: string): string[] {
  return extractAllMatches(html, /<a[^>]*class="[^"]*\bIssueLabel\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)
}

function extractDiscussionCategory(html: string): string {
  return extractFirstMatch(html, [/<a[^>]*class="[^"]*\bdiscussion-category\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i])
}

function extractCommitSpecificTitle(html: string): string {
  return extractFirstMatch(html, [/<h1[^>]*class=["'][^"']*\bcommit-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i])
}

function extractCommitTitle(html: string, fallback: string): string {
  const title =
    extractCommitSpecificTitle(html) ||
    stripGitHubCommitTitleSuffix(extractMetaContent(html, 'property', 'og:title')) ||
    stripGitHubCommitTitleSuffix(extractTitle(html, fallback))

  return title || fallback
}

function extractCommitSpecificAuthor(html: string): string {
  return extractFirstMatch(html, [/<a[^>]*class=["'][^"']*\bcommit-author\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i])
}

function extractCommitAuthor(html: string): string {
  return extractCommitSpecificAuthor(html) || extractGitHubAuthor(html)
}

function extractCommitSha(html: string): string {
  return extractFirstMatch(html, [/<clipboard-copy[^>]*value=["']([0-9a-f]{7,40})["'][^>]*>/i])
}

function extractCommitSpecificBody(html: string): string {
  const nestedBody = extractBalancedElementInnerHtml(html, /<(div|pre)\b[^>]*class=["'][^"']*\bcommit-desc\b[^"']*["'][^>]*>/i)
  if (nestedBody) {
    return stripHtml(nestedBody)
  }

  return extractFirstMatch(html, [/<(?:div|pre)[^>]*class=["'][^"']*\bcommit-desc\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|pre)>/i])
}

function extractCommitBody(html: string): string {
  return extractCommitSpecificBody(html) || extractMetaContent(html, 'property', 'og:description')
}

function extractRepositoryDescription(html: string): string {
  return (
    extractFirstMatch(html, [/<p[^>]*id=["']repo-description["'][^>]*>([\s\S]*?)<\/p>/i]) ||
    extractMetaContent(html, 'property', 'og:description')
  )
}

function extractRepositoryTopics(html: string): string[] {
  return extractAllMatches(html, /<a[^>]*data-topic=["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)
}

function confirmRepositoryRoute(html: string, route: GitHubRoute): boolean {
  const repositoryNwo = extractMetaContent(html, 'name', 'octolytics-dimension-repository_nwo')
  return repositoryNwo.toLowerCase() === `${route.owner}/${route.repo}`.toLowerCase()
}

function confirmThreadRoute(html: string): boolean {
  return Boolean(
    extractFirstMatch(html, [/<span[^>]*class="[^"]*\bjs-issue-title\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i]) ||
      extractGitHubAuthor(html) ||
      extractGitHubBody(html) ||
      extractGitHubState(html),
  )
}

function commitShasMatch(expected: string, actual: string): boolean {
  const normalizedExpected = expected.toLowerCase()
  const normalizedActual = actual.toLowerCase()
  return normalizedExpected === normalizedActual ||
    normalizedExpected.startsWith(normalizedActual) ||
    normalizedActual.startsWith(normalizedExpected)
}

function confirmCommitRoute(html: string, route: GitHubRoute): boolean {
  const extractedCommitSha = extractCommitSha(html)
  if (extractedCommitSha && route.commitSha && !commitShasMatch(route.commitSha, extractedCommitSha)) {
    return false
  }

  return Boolean(
    extractedCommitSha ||
      extractCommitSpecificTitle(html) ||
      extractCommitSpecificAuthor(html) ||
      extractCommitSpecificBody(html),
  )
}

function buildRepositoryAsset(url: string, html: string, route: GitHubRoute, options: IngestOptions): IngestTextAsset {
  const canonicalUrl = extractCanonicalUrl(html, url)
  const repositoryFullName = `${route.owner}/${route.repo}`
  const title = extractMetaContent(html, 'name', 'octolytics-dimension-repository_nwo') || extractGitHubTitle(html, repositoryFullName)
  const description = extractRepositoryDescription(html)
  const topics = extractRepositoryTopics(html)
  const capturedAt = new Date().toISOString()
  const lines = [
    '---',
    `source_url: ${yamlString(canonicalUrl)}`,
    'type: github_repository',
    `title: ${yamlString(title)}`,
    `author: ${yamlString(route.owner)}`,
    `captured_at: ${yamlString(capturedAt)}`,
    `contributor: ${yamlString(resolveContributor(options))}`,
    `github_kind: ${yamlString('repository')}`,
    `github_owner: ${yamlString(route.owner)}`,
    `github_repo: ${yamlString(route.repo)}`,
    frontmatterList('github_topics', topics),
    '---',
    '',
    `# GitHub Repository: ${repositoryFullName}`,
    '',
    `**Repository:** ${repositoryFullName}`,
    '',
    '## About',
    '',
    description || 'No repository description captured.',
  ].filter((line): line is string => Boolean(line))

  if (topics.length > 0) {
    lines.push('', '## Topics', '')
    for (const topic of topics) {
      lines.push(`- ${topic}`)
    }
  }

  lines.push('', `Source: ${canonicalUrl}`, '')

  return {
    fileName: safeFilename(canonicalUrl, '.md'),
    content: `${lines.join('\n')}\n`,
  }
}

function buildCommitAsset(url: string, html: string, route: GitHubRoute, options: IngestOptions): IngestTextAsset {
  const canonicalUrl = extractCanonicalUrl(html, url)
  const repositoryFullName = `${route.owner}/${route.repo}`
  const commitSha = extractCommitSha(html) || route.commitSha || ''
  const shortSha = commitSha.slice(0, 7) || (route.commitSha ?? '').slice(0, 7) || 'unknown'
  const title = extractCommitTitle(html, `Commit ${shortSha}`)
  const author = extractCommitAuthor(html) || route.owner
  const body = extractCommitBody(html) || 'No commit message captured.'
  const capturedAt = new Date().toISOString()
  const lines = [
    '---',
    `source_url: ${yamlString(canonicalUrl)}`,
    'type: github_commit',
    `title: ${yamlString(title)}`,
    `author: ${yamlString(author)}`,
    `captured_at: ${yamlString(capturedAt)}`,
    `contributor: ${yamlString(resolveContributor(options))}`,
    `github_kind: ${yamlString('commit')}`,
    `github_owner: ${yamlString(route.owner)}`,
    `github_repo: ${yamlString(route.repo)}`,
    commitSha ? `github_commit_sha: ${yamlString(commitSha)}` : null,
    '---',
    '',
    `# GitHub Commit ${shortSha}: ${title}`,
    '',
    `**Repository:** ${repositoryFullName}`,
    `**Author:** ${author}`,
    ...(commitSha ? [`**Commit SHA:** ${commitSha}`] : []),
    '',
    '## Message',
    '',
    body,
    '',
    `Source: ${canonicalUrl}`,
    '',
  ].filter((line): line is string => Boolean(line))

  return {
    fileName: safeFilename(canonicalUrl, '.md'),
    content: `${lines.join('\n')}\n`,
  }
}

function githubContentType(kind: GitHubRouteKind): string {
  switch (kind) {
    case 'issue':
      return 'github_issue'
    case 'pull_request':
      return 'github_pull_request'
    case 'discussion':
      return 'github_discussion'
    default:
      return 'github_repository'
  }
}

function githubHeading(kind: GitHubRouteKind): string {
  switch (kind) {
    case 'issue':
      return 'Issue'
    case 'pull_request':
      return 'Pull Request'
    case 'discussion':
      return 'Discussion'
    default:
      return 'Repository'
  }
}

function buildThreadAsset(url: string, html: string, route: GitHubRoute, options: IngestOptions): IngestTextAsset {
  const canonicalUrl = extractCanonicalUrl(html, url)
  const repositoryFullName = `${route.owner}/${route.repo}`
  const title = extractGitHubTitle(html, `${githubHeading(route.kind)} #${route.number ?? ''}`.trim())
  const author = extractGitHubAuthor(html) || route.owner
  const state = extractGitHubState(html) || 'open'
  const labels = extractGitHubLabels(html)
  const category = route.kind === 'discussion' ? extractDiscussionCategory(html) : ''
  const body = extractGitHubBody(html) || extractMetaContent(html, 'property', 'og:description') || 'No body captured.'
  const capturedAt = new Date().toISOString()
  const lines = [
    '---',
    `source_url: ${yamlString(canonicalUrl)}`,
    `type: ${githubContentType(route.kind)}`,
    `title: ${yamlString(title)}`,
    `author: ${yamlString(author)}`,
    `captured_at: ${yamlString(capturedAt)}`,
    `contributor: ${yamlString(resolveContributor(options))}`,
    `github_kind: ${yamlString(route.kind)}`,
    `github_owner: ${yamlString(route.owner)}`,
    `github_repo: ${yamlString(route.repo)}`,
    route.number ? `github_number: ${yamlString(route.number)}` : null,
    `github_state: ${yamlString(state)}`,
    frontmatterList('github_labels', labels),
    category ? `github_category: ${yamlString(category)}` : null,
    '---',
    '',
    `# GitHub ${githubHeading(route.kind)} #${route.number ?? ''}: ${title}`,
    '',
    `**Repository:** ${repositoryFullName}`,
    `**Author:** ${author}`,
    `**State:** ${state}`,
  ].filter((line): line is string => Boolean(line))

  if (labels.length > 0) {
    lines.push(`**Labels:** ${labels.join(', ')}`)
  }
  if (category) {
    lines.push(`**Category:** ${category}`)
  }

  lines.push('', '## Body', '', body, '', `Source: ${canonicalUrl}`, '')

  return {
    fileName: safeFilename(canonicalUrl, '.md'),
    content: `${lines.join('\n')}\n`,
  }
}

export async function fetchGitHub(url: string, options: IngestOptions): Promise<IngestTextAsset> {
  const html = await safeFetchText(url)
  const canonicalUrl = findCanonicalUrl(html)
  if (!canonicalUrl) {
    return buildWebpageAsset(url, html, options)
  }

  const route = parseGitHubRoute(canonicalUrl)
  if (!route) {
    return buildWebpageAsset(url, html, options)
  }

  if (route.kind === 'repository') {
    if (!confirmRepositoryRoute(html, route)) {
      return buildWebpageAsset(url, html, options)
    }
    return buildRepositoryAsset(canonicalUrl, html, route, options)
  }

  if (route.kind === 'commit') {
    if (!confirmCommitRoute(html, route)) {
      return buildWebpageAsset(url, html, options)
    }
    return buildCommitAsset(canonicalUrl, html, route, options)
  }

  if (!confirmThreadRoute(html)) {
    return buildWebpageAsset(url, html, options)
  }

  return buildThreadAsset(canonicalUrl, html, route, options)
}
