import { basename, dirname, extname, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate'

import type { ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { MAX_TEXT_BYTES, sanitizeLabel } from '../../shared/security.js'
import { FileType, classifyFile } from '../detect.js'
import { _makeId, addEdge, addNode, addUniqueEdge, createEdge, createFileNode, createNode, normalizeLabel } from './core.js'

interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
}

interface PendingReferenceCitation {
  sourceId: string
  lineNumber: number
  referenceIndices: number[]
}

type NonCodeFileType = Extract<ExtractionNode['file_type'], 'document' | 'paper' | 'image'>

const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT_H1_PATTERN = /^={3,}\s*$/
const SETEXT_H2_PATTERN = /^-{3,}\s*$/
const LOCAL_LINK_PATTERN = /(!)?\[[^\]]{0,2048}\]\(([^)]{1,2048})\)/g
const PDF_METADATA_TITLE_PATTERN = /\/Title\s*\(([^)]{1,300})\)/i
const PDF_METADATA_AUTHOR_PATTERN = /\/Author\s*\(([^)]{1,300})\)/i
const PDF_METADATA_SUBJECT_PATTERN = /\/Subject\s*\(([^)]{1,300})\)/i
const PDF_TEXT_OPERATOR_PATTERN = /\((?:\\.|[^()\\]){1,2000}\)\s*Tj/g
const PDF_TEXT_ARRAY_OPERATOR_PATTERN = /\[((?:\\.|[^\]\\]){1,4000})\]\s*TJ/g
const PDF_COMMON_SECTION_LABELS = new Set([
  'abstract',
  'introduction',
  'background',
  'method',
  'methods',
  'approach',
  'results',
  'discussion',
  'conclusion',
  'conclusions',
  'references',
])
const DOCX_TEXT_PATTERN = /<w:t(?:\s[^>]*)?>([\s\S]{0,8192}?)<\/w:t>/g
const OOXML_TITLE_PATTERN = /<dc:title>([\s\S]*?)<\/dc:title>/i
const OOXML_CREATOR_PATTERN = /<dc:creator>([\s\S]*?)<\/dc:creator>/i
const OOXML_SUBJECT_PATTERN = /<dc:subject>([\s\S]*?)<\/dc:subject>/i
const OOXML_DESCRIPTION_PATTERN = /<dc:description>([\s\S]*?)<\/dc:description>/i
const DOCX_PARAGRAPH_PATTERN = /<w:p\b[\s\S]{0,65536}?<\/w:p>/g
const DOCX_PARAGRAPH_STYLE_PATTERN = /<w:pStyle[^>]*w:val="([^"]+)"[^>]*\/>/i
const DOCX_MAX_COMPRESSED_ENTRY_BYTES = 2_097_152
const DOCX_MAX_ENTRY_ORIGINAL_BYTES = 4_194_304
const DOCX_MAX_TOTAL_ORIGINAL_BYTES = 6_291_456
const DOCX_MAX_PARAGRAPHS = 5_000
const DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH = 256
const DOCX_MAX_PARAGRAPH_TEXT_CHARS = 32_768
const XLSX_SHEET_PATTERN = /<sheet\b[^>]*name="([^"]{1,256})"[^>]*\/?/gi
const XLSX_SHARED_STRING_ITEM_PATTERN = /<si\b[\s\S]{0,65536}?<\/si>/g
const DOI_CITATION_PATTERN = /\b10\.\d{4,9}\/[\-._;()/:A-Za-z0-9]{1,200}\b/gi
const ARXIV_CITATION_PATTERN = /(?:\barxiv\s{0,5}:?\s{0,5}|arxiv\.org\/abs\/)([A-Za-z\-.]{1,50}\/\d{7}|\d{4}\.\d{4,5}(?:v\d{1,3})?)/gi
const LATEX_CITATION_PATTERN = /\\cite\w{0,20}\{([^}]{1,512})\}/g
const MAX_REFERENCE_LABEL_CHARS = 220
const MAX_CITATION_KEYS_PER_LINE = 16
const REFERENCE_SECTION_LABELS = new Set(['references', 'bibliography', 'works cited', 'citations'])
const MAX_STRUCTURED_TEXT_LINES = 100_000

function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) {
    return trimmed
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\(["'])/g, '$1')
  }

  return trimmed
}

function parseFrontmatterList(value: string): string[] {
  const inner = value.trim().slice(1, -1)
  const entries: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (!character) {
      continue
    }

    if (quote) {
      if (character === '\\' && index + 1 < inner.length) {
        current += inner[index + 1] ?? ''
        index += 1
        continue
      }

      if (character === quote) {
        quote = null
        continue
      }

      current += character
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === ',') {
      const parsed = parseFrontmatterScalar(current)
      if (parsed) {
        entries.push(parsed)
      }
      current = ''
      continue
    }

    current += character
  }

  const parsed = parseFrontmatterScalar(current)
  if (parsed) {
    entries.push(parsed)
  }

  return entries
}

function parseFrontmatterValue(rawValue: string): string | string[] {
  const trimmed = rawValue.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseFrontmatterList(trimmed)
  }

  return parseFrontmatterScalar(trimmed)
}

function parseStructuredTextFrontmatter(lines: string[]): { metadata: Record<string, unknown>; contentStartIndex: number } {
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, contentStartIndex: 0 }
  }

  const metadata: Record<string, unknown> = {}
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (trimmed === '---') {
      return { metadata, contentStartIndex: index + 1 }
    }

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!key) {
      continue
    }

    metadata[key] = parseFrontmatterValue(line.slice(separatorIndex + 1))
  }

  return { metadata, contentStartIndex: lines.length }
}

function normalizeSectionLabel(label: string): string {
  return sanitizeLabel(
    label
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[\*_`~]/g, '')
      .trim(),
  )
}

function sectionNodeId(filePath: string, label: string, line: number): string {
  return _makeId(basename(filePath, extname(filePath)), label, String(line))
}

function parseMarkdownHeading(lines: string[], index: number): { level: number; text: string; consumedLines: number } | null {
  const currentLine = lines[index]?.trim() ?? ''
  if (!currentLine) {
    return null
  }

  const atxMatch = currentLine.match(MARKDOWN_HEADING_PATTERN)
  if (atxMatch?.[1] && atxMatch[2]) {
    const headingText = normalizeSectionLabel(atxMatch[2])
    if (!headingText) {
      return null
    }

    return {
      level: atxMatch[1].length,
      text: headingText,
      consumedLines: 1,
    }
  }

  const nextLine = lines[index + 1]?.trim() ?? ''
  if (!nextLine) {
    return null
  }

  if (SETEXT_H1_PATTERN.test(nextLine)) {
    return {
      level: 1,
      text: normalizeSectionLabel(currentLine),
      consumedLines: 2,
    }
  }

  if (SETEXT_H2_PATTERN.test(nextLine)) {
    return {
      level: 2,
      text: normalizeSectionLabel(currentLine),
      consumedLines: 2,
    }
  }

  return null
}

function targetNodeId(targetPath: string): string {
  return _makeId(basename(targetPath, extname(targetPath)))
}

function isExternalReference(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)
}

function cleanReferenceTarget(rawTarget: string): string {
  return rawTarget.trim().replace(/^<|>$/g, '').split('#')[0]?.split('?')[0] ?? ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function addCorpusReferenceEdge(
  edges: ExtractionEdge[],
  sourceId: string,
  targetPath: string,
  relation: 'references' | 'embeds',
  filePath: string,
  lineNumber: number,
  seenEdges?: Set<string>,
): void {
  const targetId = targetNodeId(targetPath)
  if (sourceId === targetId) {
    return
  }

  const edge = createEdge(sourceId, targetId, relation, filePath, lineNumber)
  if (seenEdges) {
    addUniqueEdge(edges, seenEdges, edge)
    return
  }

  addEdge(edges, edge)
}

function addLocalReferenceEdges(
  edges: ExtractionEdge[],
  line: string,
  filePath: string,
  sourceId: string,
  lineNumber: number,
  allowedTargets: ReadonlySet<string>,
  seenEdges?: Set<string>,
): void {
  for (const match of line.matchAll(LOCAL_LINK_PATTERN)) {
    const isImage = Boolean(match[1])
    const rawTarget = match[2]
    if (!rawTarget || isExternalReference(rawTarget)) {
      continue
    }

    const cleanedTarget = cleanReferenceTarget(rawTarget)
    if (!cleanedTarget) {
      continue
    }

    const resolvedTarget = resolve(dirname(filePath), cleanedTarget)
    if (!allowedTargets.has(resolvedTarget) || !existsSync(resolvedTarget)) {
      continue
    }

    const relationTargetType = classifyFile(resolvedTarget)
    if (!relationTargetType) {
      continue
    }

    const relation = isImage || relationTargetType === FileType.IMAGE ? 'embeds' : 'references'
    addCorpusReferenceEdge(edges, sourceId, resolvedTarget, relation, filePath, lineNumber, seenEdges)
  }
}

function addMentionReferenceEdges(
  edges: ExtractionEdge[],
  line: string,
  filePath: string,
  sourceId: string,
  lineNumber: number,
  allowedTargets: ReadonlySet<string>,
  seenEdges?: Set<string>,
): void {
  const normalizedLine = line.toLowerCase()

  for (const targetPath of allowedTargets) {
    if (resolve(targetPath) === resolve(filePath) || !existsSync(targetPath)) {
      continue
    }

    const relationTargetType = classifyFile(targetPath)
    if (!relationTargetType) {
      continue
    }

    const targetName = basename(targetPath).toLowerCase()
    if (!targetName) {
      continue
    }

    const mentionPattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(targetName)}(?=[^a-z0-9_]|$)`, 'i')
    if (!mentionPattern.test(normalizedLine)) {
      continue
    }

    const relation = relationTargetType === FileType.IMAGE ? 'embeds' : 'references'
    addCorpusReferenceEdge(edges, sourceId, targetPath, relation, filePath, lineNumber, seenEdges)
  }
}

function trimCitationValue(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.,;]+$/g, '')
}

function citationSourceUrl(kind: 'doi' | 'arxiv' | 'citation_key', value: string): string | null {
  if (kind === 'doi') {
    return `https://doi.org/${value}`
  }

  if (kind === 'arxiv') {
    return `https://arxiv.org/abs/${value}`
  }

  return null
}

function stripInlineCodeSpans(text: string): string {
  return text.replace(/`[^`\n]{1,200}`/g, ' ')
}

function createSemanticPaperNode(
  id: string,
  label: string,
  sourceFile: string,
  line: number,
  semanticKind: 'citation' | 'reference',
  extra: Record<string, unknown> = {},
): ExtractionNode {
  return {
    ...createNode(id, label, sourceFile, line, 'paper'),
    virtual: true,
    semantic_kind: semanticKind,
    ...extra,
  }
}

function addPaperCitationNode(
  nodes: ExtractionNode[],
  seenIds: Set<string>,
  kind: 'doi' | 'arxiv' | 'citation_key',
  value: string,
  filePath: string,
  lineNumber: number,
): string | null {
  const normalizedValue = trimCitationValue(value)
  if (!normalizedValue) {
    return null
  }

  const label = kind === 'doi' ? `DOI:${normalizedValue}` : kind === 'arxiv' ? `arXiv:${normalizedValue}` : `cite:${normalizedValue}`
  const nodeId = _makeId('citation', kind, normalizedValue)
  const sourceUrl = citationSourceUrl(kind, normalizedValue)
  addNode(
    nodes,
    seenIds,
    createSemanticPaperNode(nodeId, label, filePath, lineNumber, 'citation', {
      citation_kind: kind,
      citation_value: normalizedValue,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    }),
  )
  return nodeId
}

function parseInlineReferenceCitationIndices(text: string): number[] {
  const citationText = stripInlineCodeSpans(text)
  if (/^\[(\d{1,3})\]\s+/.test(citationText.trim())) {
    return []
  }

  const indices: number[] = []
  const seen = new Set<number>()
  for (const match of citationText.matchAll(/\[(\d{1,3}(?:\s*(?:,|-)\s*\d{1,3})*)\](?!\()/g)) {
    const rawBlock = match[1]
    if (!rawBlock) {
      continue
    }

    for (const rawPart of rawBlock.split(',')) {
      const part = rawPart.trim()
      if (!part) {
        continue
      }

      if (part.includes('-')) {
        const [startPart, endPart] = part.split('-', 2)
        const startRaw = startPart ? Number.parseInt(startPart.trim(), 10) : Number.NaN
        const endRaw = endPart ? Number.parseInt(endPart.trim(), 10) : Number.NaN
        if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw) || startRaw < 1 || endRaw < startRaw) {
          continue
        }

        for (let index = startRaw; index <= endRaw && indices.length < 32; index += 1) {
          if (seen.has(index)) {
            continue
          }
          seen.add(index)
          indices.push(index)
        }
        continue
      }

      const referenceIndex = Number.parseInt(part, 10)
      if (!Number.isFinite(referenceIndex) || referenceIndex < 1 || seen.has(referenceIndex)) {
        continue
      }

      seen.add(referenceIndex)
      indices.push(referenceIndex)
      if (indices.length >= 32) {
        break
      }
    }
  }

  return indices
}

function addInlineReferenceCitationEdgesFromText(
  edges: ExtractionEdge[],
  seenEdges: Set<string>,
  text: string,
  sourceId: string,
  filePath: string,
  lineNumber: number,
  referenceNodeIdsByIndex: ReadonlyMap<number, string>,
  pendingReferenceCitations: PendingReferenceCitation[],
): void {
  const unresolvedIndices: number[] = []
  for (const referenceIndex of parseInlineReferenceCitationIndices(text)) {
    const referenceNodeId = referenceNodeIdsByIndex.get(referenceIndex)
    if (referenceNodeId) {
      addUniqueEdge(edges, seenEdges, createEdge(sourceId, referenceNodeId, 'cites', filePath, lineNumber))
      continue
    }
    unresolvedIndices.push(referenceIndex)
  }

  if (unresolvedIndices.length > 0) {
    pendingReferenceCitations.push({ sourceId, lineNumber, referenceIndices: unresolvedIndices })
  }
}

function flushPendingReferenceCitations(
  edges: ExtractionEdge[],
  seenEdges: Set<string>,
  filePath: string,
  referenceNodeIdsByIndex: ReadonlyMap<number, string>,
  pendingReferenceCitations: readonly PendingReferenceCitation[],
): void {
  for (const pending of pendingReferenceCitations) {
    for (const referenceIndex of pending.referenceIndices) {
      const referenceNodeId = referenceNodeIdsByIndex.get(referenceIndex)
      if (!referenceNodeId) {
        continue
      }
      addUniqueEdge(edges, seenEdges, createEdge(pending.sourceId, referenceNodeId, 'cites', filePath, pending.lineNumber))
    }
  }
}

function parseNumberedReferenceEntry(text: string): { rawIndex: string; referenceIndex: number; summary: string } | null {
  const normalizedText = text.trim()
  const match = normalizedText.match(/^\[(\d{1,3})\]\s+(.{1,400})$/)
  if (!match?.[1] || !match[2]) {
    return null
  }

  const referenceIndex = Number.parseInt(match[1], 10)
  if (Number.isNaN(referenceIndex) || referenceIndex < 1 || referenceIndex > 999) {
    return null
  }

  const summary = sanitizeLabel(match[2].replace(/\s+/g, ' ').trim()).slice(0, MAX_REFERENCE_LABEL_CHARS)
  if (!summary) {
    return null
  }

  return { rawIndex: match[1], referenceIndex, summary }
}

function parseReferenceMetadata(summary: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const doi = summary.match(/\b10\.\d{4,9}\/[\-._;()/:A-Za-z0-9]{1,200}\b/i)?.[0]
  const arxivId = summary.match(/(?:\barxiv\s{0,5}:?\s{0,5}|arxiv\.org\/abs\/)([A-Za-z\-.]{1,50}\/\d{7}|\d{4}\.\d{4,5}(?:v\d{1,3})?)/i)?.[1]
  const yearMatch = summary.match(/\b(19|20)\d{2}\b/)

  if (doi) {
    metadata.doi = trimCitationValue(doi)
    metadata.source_url = citationSourceUrl('doi', trimCitationValue(doi))
  }
  if (arxivId) {
    metadata.arxiv_id = trimCitationValue(arxivId)
    metadata.source_url ??= citationSourceUrl('arxiv', trimCitationValue(arxivId))
  }
  if (yearMatch?.[0]) {
    const parsedYear = Number.parseInt(yearMatch[0], 10)
    if (Number.isFinite(parsedYear)) {
      metadata.reference_year = parsedYear
    }

    const authors = sanitizeLabel(summary.slice(0, yearMatch.index ?? 0).replace(/[\s.,;:-]+$/g, ''))
    if (authors) {
      metadata.reference_authors = authors
    }

    const titleSource = summary
      .slice((yearMatch.index ?? 0) + yearMatch[0].length)
      .replace(/^[\])}.:;\s-]+/, '')
      .replace(/\b(?:doi|arxiv)\s*:?[\s\S]*$/i, '')
      .trim()
    const title = sanitizeLabel(titleSource.split(/\.(?:\s|$)/, 1)[0] ?? '')
    if (title) {
      metadata.reference_title = title
    }
  }

  return metadata
}

function addCitationEdgesFromText(
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
  seenEdges: Set<string>,
  text: string,
  sourceId: string,
  filePath: string,
  lineNumber: number,
): void {
  const citationText = stripInlineCodeSpans(text)

  for (const match of citationText.matchAll(DOI_CITATION_PATTERN)) {
    const doi = match[0]
    if (!doi) {
      continue
    }

    const citationId = addPaperCitationNode(nodes, seenIds, 'doi', doi, filePath, lineNumber)
    if (!citationId) {
      continue
    }
    addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
  }

  for (const match of citationText.matchAll(ARXIV_CITATION_PATTERN)) {
    const arxivId = match[1]
    if (!arxivId) {
      continue
    }

    const citationId = addPaperCitationNode(nodes, seenIds, 'arxiv', arxivId, filePath, lineNumber)
    if (!citationId) {
      continue
    }
    addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
  }

  for (const match of citationText.matchAll(LATEX_CITATION_PATTERN)) {
    const rawKeys = match[1]
    if (!rawKeys) {
      continue
    }

    for (const key of rawKeys
      .split(',')
      .map((value) => trimCitationValue(value))
      .filter(Boolean)
      .slice(0, MAX_CITATION_KEYS_PER_LINE)) {
      const citationId = addPaperCitationNode(nodes, seenIds, 'citation_key', key, filePath, lineNumber)
      if (!citationId) {
        continue
      }
      addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
    }
  }
}

function addReferenceNodeFromText(
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
  seenEdges: Set<string>,
  text: string,
  filePath: string,
  lineNumber: number,
  containerId: string,
): string | null {
  const entry = parseNumberedReferenceEntry(text)
  if (!entry) {
    return null
  }

  const referenceId = _makeId(basename(filePath, extname(filePath)), 'reference', entry.rawIndex)
  addNode(
    nodes,
    seenIds,
    createSemanticPaperNode(referenceId, `[${entry.rawIndex}] ${entry.summary}`, filePath, lineNumber, 'reference', {
      reference_index: entry.referenceIndex,
      ...parseReferenceMetadata(entry.summary),
    }),
  )
  addUniqueEdge(edges, seenEdges, createEdge(containerId, referenceId, 'contains', filePath, lineNumber))
  return referenceId
}

function decodeXmlText(text: string): string {
  return sanitizeLabel(
    text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractCoreMetadata(coreXml: string): Record<string, unknown> {
  const title = decodeXmlText(coreXml.match(OOXML_TITLE_PATTERN)?.[1] ?? '')
  const author = decodeXmlText(coreXml.match(OOXML_CREATOR_PATTERN)?.[1] ?? '')
  const subject = decodeXmlText(coreXml.match(OOXML_SUBJECT_PATTERN)?.[1] ?? '')
  const description = decodeXmlText(coreXml.match(OOXML_DESCRIPTION_PATTERN)?.[1] ?? '')

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(subject ? { subject } : {}),
    ...(description ? { description } : {}),
  }
}

function extractStructuredText(filePath: string, fileType: Extract<NonCodeFileType, 'document' | 'paper'>, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = createFileNode(filePath, fileType)

  addNode(nodes, seenIds, fileNode)

  try {
    if (statSync(filePath).size > MAX_TEXT_BYTES) {
      return { nodes, edges }
    }
  } catch {
    return { nodes, edges }
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  if (lines.length > MAX_STRUCTURED_TEXT_LINES) {
    return { nodes, edges }
  }
  const { metadata: frontmatterMetadata, contentStartIndex } = parseStructuredTextFrontmatter(lines)

  if (Object.keys(frontmatterMetadata).length > 0) {
    nodes[0] = { ...fileNode, ...frontmatterMetadata }
  }

  const headingStack: Array<{ level: number; id: string; label: string }> = []
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  let fenceMarker: '```' | '~~~' | null = null

  for (let index = contentStartIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const marker = trimmed.startsWith('```') ? '```' : '~~~'
      fenceMarker = fenceMarker === marker ? null : marker
      continue
    }

    if (fenceMarker) {
      continue
    }

    const heading = parseMarkdownHeading(lines, index)
    if (heading && heading.text) {
      const nodeId = sectionNodeId(filePath, heading.text, lineNumber)
      addNode(nodes, seenIds, createNode(nodeId, heading.text, filePath, lineNumber, fileType))

      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= heading.level) {
        headingStack.pop()
      }

      const parentId = headingStack[headingStack.length - 1]?.id ?? fileNode.id
      addEdge(edges, createEdge(parentId, nodeId, 'contains', filePath, lineNumber))
      headingStack.push({ level: heading.level, id: nodeId, label: normalizeLabel(heading.text) })

      addLocalReferenceEdges(edges, line, filePath, nodeId, lineNumber, allowedTargets, seenSemanticEdges)
      addMentionReferenceEdges(edges, line, filePath, nodeId, lineNumber, allowedTargets, seenSemanticEdges)

      if (heading.consumedLines === 2) {
        index += 1
      }
      continue
    }

    if (!trimmed) {
      continue
    }

    const currentSectionId = headingStack[headingStack.length - 1]?.id ?? fileNode.id
    const currentSectionLabel = headingStack[headingStack.length - 1]?.label
    const referenceEntry = currentSectionLabel && REFERENCE_SECTION_LABELS.has(currentSectionLabel) ? parseNumberedReferenceEntry(line) : null
    const referenceNodeId = referenceEntry ? addReferenceNodeFromText(nodes, edges, seenIds, seenSemanticEdges, line, filePath, lineNumber, currentSectionId) : null
    if (referenceEntry && referenceNodeId) {
      referenceNodeIdsByIndex.set(referenceEntry.referenceIndex, referenceNodeId)
    }

    addLocalReferenceEdges(edges, line, filePath, currentSectionId, lineNumber, allowedTargets, seenSemanticEdges)
    addMentionReferenceEdges(edges, line, filePath, currentSectionId, lineNumber, allowedTargets, seenSemanticEdges)
    addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, line, referenceNodeId ?? currentSectionId, filePath, lineNumber)
    addInlineReferenceCitationEdgesFromText(edges, seenSemanticEdges, line, currentSectionId, filePath, lineNumber, referenceNodeIdsByIndex, pendingReferenceCitations)
  }

  flushPendingReferenceCitations(edges, seenSemanticEdges, filePath, referenceNodeIdsByIndex, pendingReferenceCitations)

  return { nodes, edges }
}

export function createCodeFileOnlyExtraction(filePath: string): ExtractionFragment {
  const stem = basename(filePath, extname(filePath))
  return {
    nodes: [createNode(_makeId(stem), basename(filePath), filePath, 1)],
    edges: [],
  }
}

export function ensureTextFileWithinLimit(filePath: string): boolean {
  try {
    return statSync(filePath).size <= MAX_TEXT_BYTES
  } catch {
    return false
  }
}

function isAllowedOfficeEntry(
  file: UnzipFileInfo,
  selectedOriginalBytes: { value: number },
  allowedNames: ReadonlySet<string>,
  maxCompressedBytes: number,
  maxOriginalBytes: number,
  maxTotalOriginalBytes: number,
): boolean {
  if (!allowedNames.has(file.name)) {
    return false
  }

  if (file.size > maxCompressedBytes || file.originalSize > maxOriginalBytes) {
    return false
  }

  selectedOriginalBytes.value += file.originalSize
  return selectedOriginalBytes.value <= maxTotalOriginalBytes
}

function extractDocxParagraphText(paragraphXml: string): string {
  let combined = ''
  let runCount = 0

  for (const match of paragraphXml.matchAll(DOCX_TEXT_PATTERN)) {
    const fragment = match[1] ?? ''
    if (!fragment) {
      continue
    }

    combined += fragment
    runCount += 1
    if (runCount >= DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH || combined.length >= DOCX_MAX_PARAGRAPH_TEXT_CHARS) {
      break
    }
  }

  return decodeXmlText(combined.slice(0, DOCX_MAX_PARAGRAPH_TEXT_CHARS))
}

function extractDocxDocument(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = createFileNode(filePath, 'document')

  addNode(nodes, seenIds, fileNode)

  let archive: Record<string, Uint8Array>
  try {
    const buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      return { nodes, edges }
    }
    const selectedOriginalBytes = { value: 0 }
    archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) =>
        isAllowedOfficeEntry(
          file,
          selectedOriginalBytes,
          new Set(['word/document.xml', 'docProps/core.xml']),
          DOCX_MAX_COMPRESSED_ENTRY_BYTES,
          DOCX_MAX_ENTRY_ORIGINAL_BYTES,
          DOCX_MAX_TOTAL_ORIGINAL_BYTES,
        ),
    })
  } catch {
    return { nodes, edges }
  }

  const coreXmlBytes = archive['docProps/core.xml']
  if (coreXmlBytes && coreXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return { nodes, edges }
  }
  const coreXml = coreXmlBytes ? strFromU8(coreXmlBytes) : ''
  const coreMetadata = extractCoreMetadata(coreXml)
  if (Object.keys(coreMetadata).length > 0) {
    nodes[0] = { ...fileNode, ...coreMetadata }
  }

  const title = typeof coreMetadata.title === 'string' ? coreMetadata.title : ''
  if (title) {
    const titleId = sectionNodeId(filePath, title, 1)
    addNode(nodes, seenIds, createNode(titleId, title, filePath, 1, 'document'))
    addEdge(edges, createEdge(fileNode.id, titleId, 'contains', filePath, 1))
  }

  const documentXmlBytes = archive['word/document.xml']
  if (!documentXmlBytes || documentXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return { nodes, edges }
  }

  const documentXml = strFromU8(documentXmlBytes)
  const headingStack: Array<{ level: number; id: string; label: string }> = []
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  let syntheticLine = title ? 2 : 1
  let paragraphCount = 0

  for (const paragraph of documentXml.matchAll(DOCX_PARAGRAPH_PATTERN)) {
    paragraphCount += 1
    if (paragraphCount > DOCX_MAX_PARAGRAPHS) {
      break
    }

    const paragraphXml = paragraph[0]
    if (!paragraphXml || paragraphXml.length > DOCX_MAX_PARAGRAPH_TEXT_CHARS * 2) {
      continue
    }

    const text = extractDocxParagraphText(paragraphXml)
    if (!text) {
      continue
    }

    const style = paragraphXml.match(DOCX_PARAGRAPH_STYLE_PATTERN)?.[1] ?? ''
    const headingLevelMatch = style.match(/Heading([1-6])/i)
    const headingLevel = headingLevelMatch?.[1] ? Number.parseInt(headingLevelMatch[1], 10) : style.toLowerCase() === 'title' ? 1 : null

    if (headingLevel) {
      const nodeId = sectionNodeId(filePath, text, syntheticLine)
      addNode(nodes, seenIds, createNode(nodeId, text, filePath, syntheticLine, 'document'))

      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= headingLevel) {
        headingStack.pop()
      }

      const parentId = headingStack[headingStack.length - 1]?.id ?? fileNode.id
      addEdge(edges, createEdge(parentId, nodeId, 'contains', filePath, syntheticLine))
      headingStack.push({ level: headingLevel, id: nodeId, label: normalizeLabel(text) })
      addLocalReferenceEdges(edges, text, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
      addMentionReferenceEdges(edges, text, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
    } else if (headingStack.length > 0) {
      const currentSectionId = headingStack[headingStack.length - 1]!.id
      const currentSectionLabel = headingStack[headingStack.length - 1]!.label
      const referenceEntry = REFERENCE_SECTION_LABELS.has(currentSectionLabel) ? parseNumberedReferenceEntry(text) : null
      const referenceNodeId = referenceEntry ? addReferenceNodeFromText(nodes, edges, seenIds, seenSemanticEdges, text, filePath, syntheticLine, currentSectionId) : null
      if (referenceEntry && referenceNodeId) {
        referenceNodeIdsByIndex.set(referenceEntry.referenceIndex, referenceNodeId)
      }

      addLocalReferenceEdges(edges, text, filePath, currentSectionId, syntheticLine, allowedTargets, seenSemanticEdges)
      addMentionReferenceEdges(edges, text, filePath, currentSectionId, syntheticLine, allowedTargets, seenSemanticEdges)
      addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, text, referenceNodeId ?? currentSectionId, filePath, syntheticLine)
      addInlineReferenceCitationEdgesFromText(
        edges,
        seenSemanticEdges,
        text,
        currentSectionId,
        filePath,
        syntheticLine,
        referenceNodeIdsByIndex,
        pendingReferenceCitations,
      )
    } else {
      addLocalReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
      addMentionReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
      addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, text, fileNode.id, filePath, syntheticLine)
      addInlineReferenceCitationEdgesFromText(edges, seenSemanticEdges, text, fileNode.id, filePath, syntheticLine, referenceNodeIdsByIndex, pendingReferenceCitations)
    }

    syntheticLine += 1
  }

  flushPendingReferenceCitations(edges, seenSemanticEdges, filePath, referenceNodeIdsByIndex, pendingReferenceCitations)

  return { nodes, edges }
}

function extractImage(filePath: string): ExtractionFragment {
  return {
    nodes: [createFileNode(filePath, 'image')],
    edges: [],
  }
}

function decodePdfLiteral(raw: string): string {
  return sanitizeLabel(
    raw
      .replace(/\\([()\\])/g, '$1')
      .replace(/\\r/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractPdfArrayText(raw: string): string {
  return sanitizeLabel(
    [...raw.matchAll(/\((?:\\.|[^()\\]){1,2000}\)/g)]
      .map((match) => decodePdfLiteral(match[0].slice(1, -1)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractPdfTextOperations(pdfText: string): string[] {
  const operations: Array<{ index: number; text: string }> = []

  for (const match of pdfText.matchAll(PDF_TEXT_OPERATOR_PATTERN)) {
    const raw = match[0]
    const endIndex = raw.lastIndexOf(') Tj')
    if (endIndex <= 0) {
      continue
    }

    const text = decodePdfLiteral(raw.slice(1, endIndex))
    if (!text) {
      continue
    }

    operations.push({ index: match.index ?? operations.length, text })
  }

  for (const match of pdfText.matchAll(PDF_TEXT_ARRAY_OPERATOR_PATTERN)) {
    const text = extractPdfArrayText(match[1] ?? '')
    if (!text) {
      continue
    }

    operations.push({ index: match.index ?? operations.length, text })
  }

  return operations.sort((left, right) => left.index - right.index).map((entry) => entry.text)
}

function extractPdfPaper(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = createFileNode(filePath, 'paper')

  addNode(nodes, seenIds, fileNode)

  let buffer: Buffer
  try {
    buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      return { nodes, edges }
    }
  } catch {
    return { nodes, edges }
  }

  const pdfText = buffer.toString('latin1')
  const title = decodePdfLiteral(pdfText.match(PDF_METADATA_TITLE_PATTERN)?.[1] ?? '')
  const author = decodePdfLiteral(pdfText.match(PDF_METADATA_AUTHOR_PATTERN)?.[1] ?? '')
  const subject = decodePdfLiteral(pdfText.match(PDF_METADATA_SUBJECT_PATTERN)?.[1] ?? '')
  if (title || author || subject) {
    nodes[0] = {
      ...fileNode,
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(subject ? { subject } : {}),
    }
  }
  if (title && normalizeLabel(title) !== normalizeLabel(basename(filePath))) {
    const titleId = sectionNodeId(filePath, title, 1)
    addNode(nodes, seenIds, createNode(titleId, title, filePath, 1, 'paper'))
    addEdge(edges, createEdge(fileNode.id, titleId, 'contains', filePath, 1))
  }

  const sectionLabels = new Set<string>()
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  let currentSectionId = fileNode.id
  let currentSectionLabel: string | undefined
  let syntheticLine = 2
  for (const label of extractPdfTextOperations(pdfText)) {
    if (PDF_COMMON_SECTION_LABELS.has(normalizeLabel(label)) && !sectionLabels.has(label)) {
      sectionLabels.add(label)
      const sectionId = sectionNodeId(filePath, label, syntheticLine)
      addNode(nodes, seenIds, createNode(sectionId, label, filePath, syntheticLine, 'paper'))
      addEdge(edges, createEdge(fileNode.id, sectionId, 'contains', filePath, syntheticLine))
      currentSectionId = sectionId
      currentSectionLabel = normalizeLabel(label)
      syntheticLine += 1
      continue
    }

    const referenceEntry = currentSectionLabel && REFERENCE_SECTION_LABELS.has(currentSectionLabel) ? parseNumberedReferenceEntry(label) : null
    const referenceNodeId = referenceEntry ? addReferenceNodeFromText(nodes, edges, seenIds, seenSemanticEdges, label, filePath, syntheticLine, currentSectionId) : null
    if (referenceEntry && referenceNodeId) {
      referenceNodeIdsByIndex.set(referenceEntry.referenceIndex, referenceNodeId)
    }

    addMentionReferenceEdges(edges, label, filePath, currentSectionId, syntheticLine, allowedTargets, seenSemanticEdges)
    addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, label, referenceNodeId ?? currentSectionId, filePath, syntheticLine)
    addInlineReferenceCitationEdgesFromText(
      edges,
      seenSemanticEdges,
      label,
      currentSectionId,
      filePath,
      syntheticLine,
      referenceNodeIdsByIndex,
      pendingReferenceCitations,
    )
    syntheticLine += 1
  }

  flushPendingReferenceCitations(edges, seenSemanticEdges, filePath, referenceNodeIdsByIndex, pendingReferenceCitations)

  return { nodes, edges }
}

function extractXlsxSharedStringTexts(sharedStringsXml: string): string[] {
  const texts: string[] = []
  let count = 0

  for (const item of sharedStringsXml.matchAll(XLSX_SHARED_STRING_ITEM_PATTERN)) {
    const text = decodeXmlText([...(item[0] ?? '').matchAll(DOCX_TEXT_PATTERN)].map((match) => match[1] ?? '').join(' '))
    if (!text) {
      continue
    }

    texts.push(text)
    count += 1
    if (count >= 128) {
      break
    }
  }

  return texts
}

function extractXlsxDocument(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = createFileNode(filePath, 'document')

  addNode(nodes, seenIds, fileNode)

  let archive: Record<string, Uint8Array>
  try {
    const buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      return { nodes, edges }
    }

    const selectedOriginalBytes = { value: 0 }
    archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) =>
        isAllowedOfficeEntry(
          file,
          selectedOriginalBytes,
          new Set(['xl/workbook.xml', 'xl/sharedStrings.xml', 'docProps/core.xml']),
          DOCX_MAX_COMPRESSED_ENTRY_BYTES,
          DOCX_MAX_ENTRY_ORIGINAL_BYTES,
          DOCX_MAX_TOTAL_ORIGINAL_BYTES,
        ),
    })
  } catch {
    return { nodes, edges }
  }

  const coreXml = archive['docProps/core.xml'] ? strFromU8(archive['docProps/core.xml']!) : ''
  const coreMetadata = extractCoreMetadata(coreXml)
  if (Object.keys(coreMetadata).length > 0) {
    nodes[0] = { ...fileNode, ...coreMetadata }
  }

  const workbookXmlBytes = archive['xl/workbook.xml']
  if (!workbookXmlBytes || workbookXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return { nodes, edges }
  }

  const workbookXml = strFromU8(workbookXmlBytes)
  let syntheticLine = 1
  for (const match of workbookXml.matchAll(XLSX_SHEET_PATTERN)) {
    const sheetName = decodeXmlText(match[1] ?? '')
    if (!sheetName) {
      continue
    }

    const nodeId = sectionNodeId(filePath, sheetName, syntheticLine)
    addNode(nodes, seenIds, createNode(nodeId, sheetName, filePath, syntheticLine, 'document'))
    addEdge(edges, createEdge(fileNode.id, nodeId, 'contains', filePath, syntheticLine))
    addLocalReferenceEdges(edges, sheetName, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
    addMentionReferenceEdges(edges, sheetName, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
    syntheticLine += 1
  }

  const sharedStringsXml = archive['xl/sharedStrings.xml'] ? strFromU8(archive['xl/sharedStrings.xml']!) : ''
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  for (const text of extractXlsxSharedStringTexts(sharedStringsXml)) {
    addLocalReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
    addMentionReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
    addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, text, fileNode.id, filePath, syntheticLine)
    addInlineReferenceCitationEdgesFromText(edges, seenSemanticEdges, text, fileNode.id, filePath, syntheticLine, referenceNodeIdsByIndex, pendingReferenceCitations)
    syntheticLine += 1
  }

  flushPendingReferenceCitations(edges, seenSemanticEdges, filePath, referenceNodeIdsByIndex, pendingReferenceCitations)

  return { nodes, edges }
}

export function extractPaper(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.pdf') {
    return extractPdfPaper(filePath, allowedTargets)
  }

  return extractStructuredText(filePath, 'paper', allowedTargets)
}

export function extractDocument(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.docx') {
    return extractDocxDocument(filePath, allowedTargets)
  }
  if (extension === '.xlsx') {
    return extractXlsxDocument(filePath, allowedTargets)
  }

  return extractStructuredText(filePath, 'document', allowedTargets)
}

export function extractImageFile(filePath: string): ExtractionFragment {
  return extractImage(filePath)
}
