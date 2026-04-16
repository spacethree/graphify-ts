import { basename, dirname, extname, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate'
import * as ts from 'typescript'

import type { ExtractionData, ExtractionEdge, ExtractionNode } from '../contracts/types.js'
import { loadCached, saveCached } from '../infrastructure/cache.js'
import { builtinCapabilityRegistry } from '../infrastructure/capabilities.js'
import { CODE_EXTENSIONS, FileType, classifyFile, detect } from './detect.js'
import { mergeExtractionFragments, resolveSourceNodeReferences } from './extract/combine.js'
import { resolveCrossFilePythonImports } from './extract/cross-file.js'
import { dispatchSingleFileExtraction, type ExtractionFragment, type ExtractorHandlerMap } from './extract/dispatch.js'
import { _makeId, addEdge, addNode, addUniqueEdge, createEdge, createFileNode, createNode, indentationLevel, normalizeLabel, stripHashComment } from './extract/core.js'
import {
  extractAudioFile as extractAudioFragment,
  createCodeFileOnlyExtraction as createTextFallbackExtraction,
  ensureTextFileWithinLimit as isTextFileWithinLimit,
  extractDocument as extractDocumentFile,
  extractImageFile as extractImageFragment,
  extractPaper as extractPaperFile,
  extractVideoFile as extractVideoFragment,
} from './extract/non-code.js'
import { extractPythonRationale } from './extract/python-rationale.js'
import { isRecord } from '../shared/guards.js'
import { MAX_TEXT_BYTES, sanitizeLabel } from '../shared/security.js'
import { createTreeSitterWasmParser, treeSitterWasmError, type TreeSitterNode } from './tree-sitter-wasm.js'

export { _makeId } from './extract/core.js'

const EXTRACTOR_CACHE_VERSION = 38
const PYTHON_KEYWORDS = new Set(['if', 'elif', 'else', 'for', 'while', 'return', 'class', 'def', 'lambda', 'with', 'print', 'sum'])
const GENERIC_CODE_EXTENSIONS = new Set(['.go', '.rs', '.java', '.kt', '.kts', '.scala', '.cs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.swift', '.php', '.zig'])
const GENERIC_CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'delete', 'throw', 'sizeof', 'case', 'do', 'else'])
const RUBY_KEYWORDS = new Set(['if', 'elsif', 'else', 'unless', 'while', 'until', 'return', 'super', 'yield', 'class', 'def'])
const RUBY_AST_NESTED_DECLARATION_TYPES = new Set(['class', 'module', 'method', 'singleton_method'])
const MAX_RUBY_AST_DEPTH = 64
const LUA_KEYWORDS = new Set(['if', 'then', 'elseif', 'else', 'for', 'while', 'repeat', 'until', 'return', 'function', 'local', 'require'])
const ELIXIR_KEYWORDS = new Set(['if', 'unless', 'case', 'cond', 'fn', 'def', 'defp', 'defmodule'])
const JULIA_KEYWORDS = new Set(['if', 'elseif', 'else', 'while', 'for', 'return', 'function', 'struct', 'mutable', 'macro'])
const POWERSHELL_KEYWORDS = new Set(['if', 'else', 'elseif', 'foreach', 'switch', 'return', 'function', 'class', 'param'])
const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT_H1_PATTERN = /^={3,}\s*$/
const SETEXT_H2_PATTERN = /^-{3,}\s*$/
const LOCAL_LINK_PATTERN = /(!)?\[[^\]]*\]\(([^)]+)\)/g
const PDF_METADATA_TITLE_PATTERN = /\/Title\s*\(([^)]{1,300})\)/i
const PDF_TEXT_OPERATOR_PATTERN = /\((?:\\.|[^()\\]){1,2000}\)\s*Tj/g
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
const DOCX_TITLE_PATTERN = /<dc:title>([\s\S]*?)<\/dc:title>/i
const DOCX_PARAGRAPH_PATTERN = /<w:p\b[\s\S]{0,65536}?<\/w:p>/g
const DOCX_PARAGRAPH_STYLE_PATTERN = /<w:pStyle[^>]*w:val="([^"]+)"[^>]*\/>/i
const DOCX_TEXT_PATTERN = /<w:t(?:\s[^>]*)?>([\s\S]{0,8192}?)<\/w:t>/g
const DOCX_MAX_COMPRESSED_ENTRY_BYTES = 2_097_152
const DOCX_MAX_ENTRY_ORIGINAL_BYTES = 4_194_304
const DOCX_MAX_TOTAL_ORIGINAL_BYTES = 6_291_456
const DOCX_MAX_PARAGRAPHS = 5_000
const DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH = 256
const DOCX_MAX_PARAGRAPH_TEXT_CHARS = 32_768
const DOI_CITATION_PATTERN = /\b10\.\d{4,9}\/[\-._;()/:A-Za-z0-9]{1,200}\b/gi
const ARXIV_CITATION_PATTERN = /(?:\barxiv\s{0,5}:?\s{0,5}|arxiv\.org\/abs\/)([A-Za-z\-.]{1,50}\/\d{7}|\d{4}\.\d{4,5}(?:v\d{1,3})?)/gi
const LATEX_CITATION_PATTERN = /\\cite\w{0,20}\{([^}]{1,512})\}/g
const MAX_GENERIC_BASE_TARGETS = 10
const MAX_REFERENCE_LABEL_CHARS = 220
const MAX_CITATION_KEYS_PER_LINE = 16
const REFERENCE_SECTION_LABELS = new Set(['references', 'bibliography', 'works cited', 'citations'])
const TREE_SITTER_FALLBACK_WARNINGS = new Set<string>()

type NonCodeFileType = Extract<ExtractionNode['file_type'], 'document' | 'paper' | 'image' | 'audio' | 'video'>

interface CollectFilesOptions {
  followSymlinks?: boolean
}

interface PendingCall {
  callerId: string
  calleeName: string
  line: number
  preferredClassId?: string
}

interface PendingCallInput {
  callerId: string
  calleeName: string
  line: number
  preferredClassId?: string | undefined
}

interface CachedExtractionPayload extends ExtractionFragment {
  __graphifyTsExtractorVersion: number
}

interface PendingReferenceCitation {
  sourceId: string
  lineNumber: number
  referenceIndices: number[]
}

const MAX_TS_NESTED_FUNCTION_DEPTH = 10

function resolveModuleName(specifier: string): string {
  const normalized = specifier
    .replaceAll('\\', '/')
    .replace(/^node:/, '')
    .replace(/^\.\//, '')
    .replace(/^\.\//, '')
  const lastSegment = normalized.split('/').filter(Boolean).at(-1) ?? normalized
  const extension = extname(lastSegment)
  return extension ? lastSegment.slice(0, -extension.length) : lastSegment
}

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
  addNode(
    nodes,
    seenIds,
    createSemanticPaperNode(nodeId, label, filePath, lineNumber, 'citation', {
      citation_kind: kind,
      citation_value: normalizedValue,
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
  const match = text.match(/^\[(\d{1,3})\]\s+(.{1,400})$/)
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
  }
  if (arxivId) {
    metadata.arxiv_id = trimCitationValue(arxivId)
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

function stripGenericSegments(value: string): string {
  let depth = 0
  let result = ''

  for (const character of value) {
    if (character === '<') {
      depth += 1
      continue
    }
    if (character === '>') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) {
      result += character
    }
  }

  return result
}

function normalizeTypeName(raw: string): string | null {
  const withoutGenerics = stripGenericSegments(raw)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bwhere\b[\s\S]*$/, ' ')
    .replace(/[{}]/g, ' ')
    .replace(
      /\b(?:public|private|protected|internal|open|sealed|abstract|final|static|virtual|override|implements|extends|with|class|interface|struct|enum|trait|protocol|object|extension|partial|readonly|required|unsafe|new)\b/g,
      ' ',
    )
    .trim()
  if (!withoutGenerics) {
    return null
  }

  const token = withoutGenerics.split(/\s+/).at(-1) ?? withoutGenerics
  const parts = token.split(/::|\.|:/).filter(Boolean)
  return parts.at(-1) ?? null
}

function parseBaseTypeList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => normalizeTypeName(value))
    .filter((value): value is string => Boolean(value))
}

function genericBaseNamesFromLine(line: string): string[] {
  const trimmed = stripHashComment(line)
    .replace(/\{.*$/, '')
    .replace(/\bwhere\b[\s\S]*$/, '')
    .trim()
  const bases: string[] = []
  const extendsMatch = trimmed.match(/\bextends\s+(.+)$/)

  if (extendsMatch?.[1]) {
    const afterExtends = extendsMatch[1]
    const [primaryBase] = afterExtends.split(/\b(?:implements|with)\b/, 1)
    if (primaryBase) {
      bases.push(...parseBaseTypeList(primaryBase))
    }

    const implementsMatch = afterExtends.match(/\bimplements\s+(.+)$/)
    if (implementsMatch?.[1]) {
      bases.push(...parseBaseTypeList(implementsMatch[1]))
    }

    for (const withSegment of afterExtends.split(/\bwith\b/).slice(1)) {
      bases.push(...parseBaseTypeList(withSegment))
    }
  } else {
    const colonMatch = trimmed.match(/\b(?:class|interface|struct|enum|trait|protocol|object|extension)\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>]+>)?\s*:\s*(.+)$/)
    if (colonMatch?.[1]) {
      bases.push(...parseBaseTypeList(colonMatch[1]))
    }

    const implementsMatch = trimmed.match(/\bimplements\s+(.+)$/)
    if (implementsMatch?.[1]) {
      bases.push(...parseBaseTypeList(implementsMatch[1]))
    }
  }

  return [...new Set(bases)].slice(0, MAX_GENERIC_BASE_TARGETS)
}

function genericContinuationBaseNamesFromLine(line: string): string[] {
  const trimmed = stripHashComment(line)
    .replace(/\{.*$/, '')
    .replace(/\bwhere\b[\s\S]*$/, '')
    .trim()

  if (!trimmed) {
    return []
  }

  if (/^with\b/.test(trimmed)) {
    return parseBaseTypeList(trimmed.replace(/^with\b/, ' '))
  }

  if (/^implements\b/.test(trimmed)) {
    return parseBaseTypeList(trimmed.replace(/^implements\b/, ' '))
  }

  if (trimmed.startsWith(',')) {
    return parseBaseTypeList(trimmed.slice(1))
  }

  return []
}

function inlineBodyTextFromSignature(line: string): string | undefined {
  const equalsIndex = line.indexOf('=')
  if (equalsIndex >= 0) {
    const inlineBodyText = line.slice(equalsIndex + 1).trim()
    return inlineBodyText || undefined
  }

  const openBraceIndex = line.indexOf('{')
  if (openBraceIndex >= 0) {
    const inlineBodyText = line
      .slice(openBraceIndex + 1)
      .replace(/\}\s*$/, '')
      .trim()
    return inlineBodyText || undefined
  }

  return undefined
}

function lightweightFunctionSignature(line: string): { functionName: string; inlineBodyText?: string } | null {
  const kotlinMatch = line.match(/\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^={]+)?(?:\s*[={].*)?$/)
  if (kotlinMatch?.[1]) {
    const inlineBodyText = inlineBodyTextFromSignature(line)
    return {
      functionName: kotlinMatch[1],
      ...(inlineBodyText ? { inlineBodyText } : {}),
    }
  }

  const scalaMatch = line.match(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*\([^)]*\)\s*(?::\s*[^={]+)?(?:\s*[={].*)?$/)
  if (scalaMatch?.[1]) {
    const inlineBodyText = inlineBodyTextFromSignature(line)
    return {
      functionName: scalaMatch[1],
      ...(inlineBodyText ? { inlineBodyText } : {}),
    }
  }

  const swiftMatch = line.match(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?:->\s*[^={]+)?(?:\s*[={].*)?$/)
  if (swiftMatch?.[1]) {
    const inlineBodyText = inlineBodyTextFromSignature(line)
    return {
      functionName: swiftMatch[1],
      ...(inlineBodyText ? { inlineBodyText } : {}),
    }
  }

  return null
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
  const { metadata: frontmatterMetadata, contentStartIndex } = parseStructuredTextFrontmatter(lines)

  if (Object.keys(frontmatterMetadata).length > 0) {
    const enrichedFileNode: ExtractionNode = { ...frontmatterMetadata, ...fileNode }
    nodes[0] = enrichedFileNode
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

function createCodeFileOnlyExtraction(filePath: string): ExtractionFragment {
  const stem = basename(filePath, extname(filePath))
  return {
    nodes: [createNode(_makeId(stem), basename(filePath), filePath, 1)],
    edges: [],
  }
}

function ensureTextFileWithinLimit(filePath: string): boolean {
  try {
    return statSync(filePath).size <= MAX_TEXT_BYTES
  } catch {
    return false
  }
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

function isAllowedDocxEntry(file: UnzipFileInfo, selectedOriginalBytes: { value: number }): boolean {
  if (file.name !== 'word/document.xml' && file.name !== 'docProps/core.xml') {
    return false
  }

  if (file.size > DOCX_MAX_COMPRESSED_ENTRY_BYTES || file.originalSize > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return false
  }

  selectedOriginalBytes.value += file.originalSize
  return selectedOriginalBytes.value <= DOCX_MAX_TOTAL_ORIGINAL_BYTES
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
      filter: (file) => isAllowedDocxEntry(file, selectedOriginalBytes),
    })
  } catch {
    return { nodes, edges }
  }

  const coreXmlBytes = archive['docProps/core.xml']
  if (coreXmlBytes && coreXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return { nodes, edges }
  }
  const coreXml = coreXmlBytes ? strFromU8(coreXmlBytes) : ''
  const title = decodeXmlText(coreXml.match(DOCX_TITLE_PATTERN)?.[1] ?? '')
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
  for (const match of pdfText.matchAll(PDF_TEXT_OPERATOR_PATTERN)) {
    const endIndex = match[0].lastIndexOf(') Tj')
    const label = decodePdfLiteral(match[0].slice(1, endIndex))
    if (!label) {
      continue
    }

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

function extractPaper(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.pdf') {
    return extractPdfPaper(filePath, allowedTargets)
  }

  return extractStructuredText(filePath, 'paper', allowedTargets)
}

function extractDocument(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  if (extname(filePath).toLowerCase() === '.docx') {
    return extractDocxDocument(filePath, allowedTargets)
  }

  return extractStructuredText(filePath, 'document', allowedTargets)
}

function isCachedExtraction(value: unknown): value is CachedExtractionPayload {
  return isRecord(value) && value.__graphifyTsExtractorVersion === EXTRACTOR_CACHE_VERSION && Array.isArray(value.nodes) && Array.isArray(value.edges)
}

function moduleSpecifierFromRequireCall(node: ts.CallExpression): string | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') {
    return null
  }

  const [specifier] = node.arguments
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : null
}

function addTsImportEdge(edges: ExtractionEdge[], seenImportEdges: Set<string>, sourceId: string, specifier: string, filePath: string, line: number): void {
  const trimmedSpecifier = specifier.trim()
  if (!trimmedSpecifier || trimmedSpecifier.length > 512) {
    return
  }

  addUniqueEdge(edges, seenImportEdges, createEdge(sourceId, _makeId(resolveModuleName(trimmedSpecifier)), 'imports_from', filePath, line))
}

function readCachedExtraction(filePath: string): ExtractionFragment | null {
  const cached = loadCached(filePath)
  if (!isCachedExtraction(cached)) {
    return null
  }
  return {
    nodes: cached.nodes,
    edges: cached.edges,
  }
}

function writeCachedExtraction(filePath: string, extraction: ExtractionFragment): void {
  saveCached(filePath, {
    __graphifyTsExtractorVersion: EXTRACTOR_CACHE_VERSION,
    nodes: extraction.nodes,
    edges: extraction.edges,
  })
}

function addPendingCall(pendingCalls: PendingCall[], call: PendingCallInput): void {
  if (call.preferredClassId) {
    pendingCalls.push({
      callerId: call.callerId,
      calleeName: call.calleeName,
      line: call.line,
      preferredClassId: call.preferredClassId,
    })
    return
  }

  pendingCalls.push({
    callerId: call.callerId,
    calleeName: call.calleeName,
    line: call.line,
  })
}

function addResolvedCalls(
  edges: ExtractionEdge[],
  pendingCalls: PendingCall[],
  nodes: ExtractionNode[],
  sourceFile: string,
  methodIdsByClass: Map<string, string>,
): void {
  const labelToId = new Map<string, string>()
  for (const node of nodes) {
    labelToId.set(normalizeLabel(node.label), node.id)
  }

  const seenPairs = new Set<string>()
  for (const pendingCall of pendingCalls) {
    const preferredKey = pendingCall.preferredClassId ? `${pendingCall.preferredClassId}:${pendingCall.calleeName.toLowerCase()}` : null
    const targetId = (preferredKey ? methodIdsByClass.get(preferredKey) : undefined) ?? labelToId.get(pendingCall.calleeName.toLowerCase())
    if (!targetId || targetId === pendingCall.callerId) {
      continue
    }

    const pairKey = `${pendingCall.callerId}->${targetId}`
    if (seenPairs.has(pairKey)) {
      continue
    }
    seenPairs.add(pairKey)
    addEdge(edges, createEdge(pendingCall.callerId, targetId, 'calls', sourceFile, pendingCall.line, 'EXTRACTED', 1.0))
  }
}

function genericImportTarget(line: string): string | null {
  const includeMatch = line.match(/^#include\s+[<"]([^>"]+)[>"]/)
  if (includeMatch?.[1]) {
    return includeMatch[1]
  }

  const zigImportMatch = line.match(/@import\(["']([^"']+)["']\)/)
  if (zigImportMatch?.[1]) {
    return zigImportMatch[1]
  }

  const useMatch = line.match(/^(?:import|use)\s+([^;]+);?$/)
  if (useMatch?.[1]) {
    return useMatch[1].replace(/^static\s+/, '').trim()
  }

  return null
}

function normalizeImportTarget(specifier: string): string {
  const cleaned = specifier.replace(/["'<>;]/g, '')
  const parts = cleaned.split(/[/\\.:]+/).filter(Boolean)
  return parts.at(-1) ?? cleaned
}

function braceDelta(line: string): number {
  return [...line].reduce((total, character) => total + (character === '{' ? 1 : character === '}' ? -1 : 0), 0)
}

function classNameFromLine(line: string): string | null {
  const goStructMatch = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/)
  if (goStructMatch?.[1]) {
    return goStructMatch[1]
  }

  const zigStructMatch = line.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*struct\b/)
  if (zigStructMatch?.[1]) {
    return zigStructMatch[1]
  }

  const implForMatch = line.match(/^impl(?:\s*<[^>]+>)?\s+[A-Za-z_][A-Za-z0-9_:<>]*\s+for\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
  if (implForMatch?.[1]) {
    return implForMatch[1]
  }

  const implMatch = line.match(/^(?:impl|extension)\s+(?:<[^>]+>\s*)?([A-Za-z_][A-Za-z0-9_]*)\b/)
  if (implMatch?.[1]) {
    return implMatch[1]
  }

  const genericMatch = line.match(/\b(class|interface|struct|enum|trait|protocol|object)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
  return genericMatch?.[2] ?? null
}

function qualifiedMethodDefinition(line: string): { ownerName: string; functionName: string } | null {
  const match = line.match(/(?:^|[\s*&<>,:])(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\b)?\s*(?:\{|=>)/)
  if (!match?.[1] || !match[2]) {
    return null
  }

  return {
    ownerName: match[1],
    functionName: match[2],
  }
}

function ownerIdFromName(stem: string, ownerName: string | undefined): string | undefined {
  return ownerName ? _makeId(stem, ownerName) : undefined
}

function addGenericCallsFromText(
  text: string,
  callerId: string,
  lineNumber: number,
  pendingCalls: PendingCall[],
  preferredClassId: string | undefined,
  stem: string,
): void {
  for (const match of text.matchAll(/\b(?:self|this)\s*(?:\.|->|::)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const calleeName = match[1]
    if (!calleeName) {
      continue
    }

    addPendingCall(pendingCalls, { callerId, calleeName, line: lineNumber, preferredClassId })
  }

  for (const match of text.matchAll(/\b(?:[A-Za-z_][A-Za-z0-9_]*::)+([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const ownerName = match[1]
    const calleeName = match[2]
    if (!ownerName || !calleeName) {
      continue
    }

    addPendingCall(pendingCalls, {
      callerId,
      calleeName,
      line: lineNumber,
      preferredClassId: ownerIdFromName(stem, ownerName),
    })
  }

  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const calleeName = match[1]
    const matchIndex = match.index ?? -1
    const previousCharacter = matchIndex > 0 ? text[matchIndex - 1] : ''
    if (!calleeName || GENERIC_CONTROL_KEYWORDS.has(calleeName) || previousCharacter === '.' || previousCharacter === ':' || previousCharacter === '>') {
      continue
    }

    addPendingCall(pendingCalls, { callerId, calleeName, line: lineNumber, preferredClassId })
  }

  for (const match of text.matchAll(/(?:\.|::|->)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const calleeName = match[1]
    if (!calleeName) {
      continue
    }

    addPendingCall(pendingCalls, { callerId, calleeName, line: lineNumber })
  }
}

function ensureGenericOwnerNode(
  className: string,
  stem: string,
  filePath: string,
  lineNumber: number,
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
): string {
  const classId = _makeId(stem, className)
  addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
  addEdge(edges, createEdge(_makeId(stem), classId, 'contains', filePath, lineNumber))
  return classId
}

export function extractGenericCode(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  let braceDepth = 0
  const classStack: Array<{ braceDepth: number; id: string; name: string }> = []
  const functionStack: Array<{ braceDepth: number; id: string; classId?: string }> = []
  let pendingClassDeclaration: { id: string; name: string } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed || trimmed.startsWith('//')) {
      braceDepth += braceDelta(line)
      continue
    }

    while (functionStack.length > 0 && braceDepth < (functionStack[functionStack.length - 1]?.braceDepth ?? 0)) {
      functionStack.pop()
    }
    while (classStack.length > 0 && braceDepth < (classStack[classStack.length - 1]?.braceDepth ?? 0)) {
      classStack.pop()
    }

    const importTarget = genericImportTarget(trimmed)
    if (importTarget) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importTarget)), 'imports_from', filePath, lineNumber))
      braceDepth += braceDelta(line)
      continue
    }

    const className = classNameFromLine(trimmed)
    const continuationBaseNames = pendingClassDeclaration && !className ? genericContinuationBaseNamesFromLine(trimmed) : []
    if (pendingClassDeclaration && !className) {
      for (const baseName of continuationBaseNames) {
        const baseId = _makeId(stem, baseName)
        addNode(nodes, seenIds, createNode(baseId, baseName, filePath, lineNumber))
        addEdge(edges, createEdge(pendingClassDeclaration.id, baseId, 'inherits', filePath, lineNumber))
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      const opensPendingClassBody = trimmed === '{' || (continuationBaseNames.length > 0 && trimmed.includes('{'))
      if (opensPendingClassBody) {
        classStack.push({
          braceDepth: Math.max(nextBraceDepth, braceDepth + 1),
          id: pendingClassDeclaration.id,
          name: pendingClassDeclaration.name,
        })
        pendingClassDeclaration = null
        braceDepth = nextBraceDepth
        continue
      }

      if (continuationBaseNames.length > 0) {
        braceDepth = nextBraceDepth
        continue
      }
    }

    if (className) {
      const classId = _makeId(stem, className)
      const parentOwnerId = classStack[classStack.length - 1]?.id ?? fileNodeId
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(parentOwnerId, classId, 'contains', filePath, lineNumber))

      for (const baseName of genericBaseNamesFromLine(trimmed)) {
        const baseId = _makeId(stem, baseName)
        addNode(nodes, seenIds, createNode(baseId, baseName, filePath, lineNumber))
        addEdge(edges, createEdge(classId, baseId, 'inherits', filePath, lineNumber))
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{') || /\bstruct\b/.test(trimmed)) {
        classStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: classId, name: className })
      } else {
        pendingClassDeclaration = { id: classId, name: className }
      }

      braceDepth = nextBraceDepth
      continue
    }

    let functionName: string | null = null
    let ownerClassId: string | undefined
    let inlineBodyText: string | undefined
    const currentClass = classStack[classStack.length - 1]

    const goMethodMatch = trimmed.match(/^func\s*\([^)]*\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (goMethodMatch?.[1] && goMethodMatch[2]) {
      const ownerName = goMethodMatch[1]
      functionName = goMethodMatch[2]
      ownerClassId = ensureGenericOwnerNode(ownerName, stem, filePath, lineNumber, nodes, edges, seenIds)
    } else {
      const qualifiedMethod = qualifiedMethodDefinition(trimmed)
      const constructorMatch = currentClass
        ? trimmed.match(new RegExp(`^(?:public|private|protected|internal|static|final|open|override|virtual|abstract|\\s)*${currentClass.name}\\s*\\(`))
        : null
      const specialSignature = lightweightFunctionSignature(trimmed)
      if (qualifiedMethod) {
        functionName = qualifiedMethod.functionName
        ownerClassId = ensureGenericOwnerNode(qualifiedMethod.ownerName, stem, filePath, lineNumber, nodes, edges, seenIds)
      } else if (specialSignature) {
        functionName = specialSignature.functionName
        ownerClassId = currentClass?.id
        inlineBodyText = specialSignature.inlineBodyText
      } else if (constructorMatch && currentClass) {
        functionName = currentClass.name
        ownerClassId = currentClass.id
      } else {
        const zigFunctionMatch = trimmed.match(/^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
        if (zigFunctionMatch?.[1] && trimmed.includes('{')) {
          functionName = zigFunctionMatch[1]
          ownerClassId = currentClass?.id
        } else {
          const genericFunctionMatch = trimmed.match(/([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\b)?\s*(?:\{|=>)/)
          if (genericFunctionMatch?.[1]) {
            const candidate = genericFunctionMatch[1]
            if (!GENERIC_CONTROL_KEYWORDS.has(candidate) && candidate !== 'import' && candidate !== 'use') {
              functionName = candidate
              ownerClassId = currentClass?.id
            }
          }
        }
      }
    }

    if (functionName) {
      const effectiveOwnerClassId = ownerClassId ?? pendingClassDeclaration?.id
      const functionId = effectiveOwnerClassId ? _makeId(effectiveOwnerClassId, functionName) : _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${effectiveOwnerClassId ? '.' : ''}${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(effectiveOwnerClassId ?? fileNodeId, functionId, effectiveOwnerClassId ? 'method' : 'contains', filePath, lineNumber))
      if (effectiveOwnerClassId) {
        methodIdsByClass.set(`${effectiveOwnerClassId}:${functionName.toLowerCase()}`, functionId)
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{')) {
        functionStack.push({
          braceDepth: Math.max(nextBraceDepth, braceDepth + 1),
          id: functionId,
          ...(effectiveOwnerClassId ? { classId: effectiveOwnerClassId } : {}),
        })
      }

      if (inlineBodyText && inlineBodyText.trim()) {
        addGenericCallsFromText(inlineBodyText, functionId, lineNumber, pendingCalls, effectiveOwnerClassId, stem)
      } else {
        const inlineBodyIndex = trimmed.indexOf('=>') >= 0 ? trimmed.indexOf('=>') + 2 : trimmed.indexOf('{') >= 0 ? trimmed.indexOf('{') + 1 : -1
        if (inlineBodyIndex >= 0) {
          addGenericCallsFromText(trimmed.slice(inlineBodyIndex), functionId, lineNumber, pendingCalls, effectiveOwnerClassId, stem)
        }
      }

      braceDepth = nextBraceDepth
      continue
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (currentFunction) {
      addGenericCallsFromText(trimmed, currentFunction.id, lineNumber, pendingCalls, currentFunction.classId, stem)
    }

    braceDepth += braceDelta(line)
  }

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function collectFiles(root: string, options: CollectFilesOptions = {}): string[] {
  const result = detect(root, options.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks })
  return result.files.code
}

function extractPythonRegex(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const classStack: Array<{ indent: number; id: string; name: string }> = []
  const functionStack: Array<{ indent: number; id: string; classId?: string }> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      return
    }

    const indent = line.length - line.trimStart().length

    while (functionStack.length > 0 && indent <= (functionStack.at(-1)?.indent ?? -1)) {
      functionStack.pop()
    }
    while (classStack.length > 0 && indent <= (classStack.at(-1)?.indent ?? -1)) {
      classStack.pop()
    }

    const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)/)
    if (importMatch) {
      const moduleList = importMatch[1]
      if (!moduleList) {
        return
      }
      for (const rawModule of moduleList.split(',')) {
        const moduleName = rawModule.split(' as ')[0]?.trim().replace(/^\.+/, '')
        if (!moduleName) {
          continue
        }
        addEdge(edges, createEdge(fileNodeId, _makeId(moduleName), 'imports', filePath, lineNumber))
      }
      return
    }

    const importFromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+/)
    if (importFromMatch) {
      const moduleName = importFromMatch[1]?.replace(/^\.+/, '')
      if (moduleName) {
        addEdge(edges, createEdge(fileNodeId, _makeId(moduleName), 'imports_from', filePath, lineNumber))
      }
      return
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?:/)
    if (classMatch) {
      const className = classMatch[1]
      if (!className) {
        return
      }
      const baseName = classMatch[2]?.split(',')[0]?.trim()
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, lineNumber))
      if (baseName) {
        addEdge(edges, createEdge(classId, _makeId(baseName), 'inherits', filePath, lineNumber))
      }
      classStack.push({ indent, id: classId, name: className })
      return
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (functionMatch) {
      const functionName = functionMatch[1]
      if (!functionName) {
        return
      }
      const parentClass = classStack.at(-1)
      if (parentClass) {
        const functionId = _makeId(parentClass.id, functionName)
        addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(parentClass.id, functionId, 'method', filePath, lineNumber))
        methodIdsByClass.set(`${parentClass.id}:${functionName.toLowerCase()}`, functionId)
        functionStack.push({ indent, id: functionId, classId: parentClass.id })
      } else {
        const functionId = _makeId(stem, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))
        functionStack.push({ indent, id: functionId })
      }
      return
    }

    const currentFunction = functionStack.at(-1)
    if (!currentFunction) {
      return
    }

    const selfCallPattern = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    for (const match of trimmed.matchAll(selfCallPattern)) {
      const calleeName = match[1]
      if (!calleeName) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }

    const plainCallPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    for (const match of trimmed.matchAll(plainCallPattern)) {
      const calleeName = match[1]
      const matchIndex = match.index ?? -1
      if (!calleeName || PYTHON_KEYWORDS.has(calleeName) || (matchIndex > 0 && trimmed[matchIndex - 1] === '.')) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const rationale = extractPythonRationale(filePath)
  nodes.push(...rationale.nodes)
  edges.push(...rationale.edges)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

function pythonDefinitionNode(node: TreeSitterNode): TreeSitterNode | null {
  if (node.type !== 'decorated_definition') {
    return node
  }

  return namedTreeSitterChildren(node).find((child) => child.type === 'class_definition' || child.type === 'function_definition') ?? null
}

function collectPythonCalls(node: TreeSitterNode, sourceText: string, callerId: string, pendingCalls: PendingCall[], currentOwnerId?: string, isRoot = true): void {
  if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition' || node.type === 'decorated_definition')) {
    return
  }

  if (node.type === 'call') {
    const functionNode = node.childForFieldName('function')
    const line = node.startPosition.row + 1

    if (functionNode?.type === 'identifier') {
      const calleeName = treeSitterNodeText(sourceText, functionNode)?.trim()
      if (calleeName) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
        })
      }
    } else if (functionNode?.type === 'attribute') {
      const calleeName = treeSitterNodeText(sourceText, functionNode.childForFieldName('attribute'))?.trim()
      const objectName = treeSitterNodeText(sourceText, functionNode.childForFieldName('object'))?.trim()
      if (calleeName) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
          preferredClassId: currentOwnerId && (objectName === 'self' || objectName === 'cls') ? currentOwnerId : undefined,
        })
      }
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    collectPythonCalls(child, sourceText, callerId, pendingCalls, currentOwnerId, false)
  }
}

function extractPythonTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('python')
  if (!parser) {
    return null
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  const pendingInherits: Array<{ sourceId: string; baseName: string; line: number }> = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureClassNode = (className: string, line: number, parentOwnerId?: string): string => {
    const classId = _makeId(stem, className)
    addNode(nodes, seenIds, createNode(classId, className, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, classId, 'contains', filePath, line))
    return classId
  }

  const addPythonImports = (): void => {
    lines.forEach((line, index) => {
      const lineNumber = index + 1
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        return
      }

      const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)/)
      if (importMatch?.[1]) {
        for (const rawModule of importMatch[1].split(',')) {
          const moduleName = rawModule.split(' as ')[0]?.trim().replace(/^\.+/, '')
          if (!moduleName) {
            continue
          }

          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(moduleName), 'imports', filePath, lineNumber))
        }
        return
      }

      const importFromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+/)
      if (importFromMatch?.[1]) {
        const moduleName = importFromMatch[1].replace(/^\.+/, '')
        if (moduleName) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(moduleName), 'imports_from', filePath, lineNumber))
        }
      }
    })
  }

  const processFunction = (node: TreeSitterNode, ownerId?: string): void => {
    const functionName = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
    if (!functionName) {
      return
    }

    const line = node.startPosition.row + 1
    const functionId = ownerId ? _makeId(ownerId, functionName) : _makeId(stem, functionName)
    addNode(nodes, seenIds, createNode(functionId, `${ownerId ? '.' : ''}${functionName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId ?? fileNodeId, functionId, ownerId ? 'method' : 'contains', filePath, line))
    if (ownerId) {
      methodIdsByClass.set(`${ownerId}:${functionName.toLowerCase()}`, functionId)
    }

    const bodyNode = node.childForFieldName('body')
    if (bodyNode) {
      collectPythonCalls(bodyNode, sourceText, functionId, pendingCalls, ownerId)
    }
  }

  const walkClass = (node: TreeSitterNode, parentOwnerId?: string): void => {
    const className = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
    if (!className) {
      return
    }

    const line = node.startPosition.row + 1
    const classId = ensureClassNode(className, line, parentOwnerId)

    const superclassesNode = node.childForFieldName('superclasses')
    if (superclassesNode) {
      for (const child of namedTreeSitterChildren(superclassesNode)) {
        const baseName = normalizeTypeName(treeSitterNodeText(sourceText, child)?.trim() ?? '')
        if (!baseName) {
          continue
        }

        pendingInherits.push({
          sourceId: classId,
          baseName,
          line: child.startPosition.row + 1,
        })
      }
    }

    const bodyNode = node.childForFieldName('body')
    if (!bodyNode) {
      return
    }

    for (const child of namedTreeSitterChildren(bodyNode)) {
      const definitionNode = pythonDefinitionNode(child)
      if (!definitionNode) {
        continue
      }

      if (definitionNode.type === 'class_definition') {
        walkClass(definitionNode, classId)
        continue
      }

      if (definitionNode.type === 'function_definition') {
        processFunction(definitionNode, classId)
      }
    }
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))
    addPythonImports()

    for (const child of namedTreeSitterChildren(tree.rootNode)) {
      const definitionNode = pythonDefinitionNode(child)
      if (!definitionNode) {
        continue
      }

      if (definitionNode.type === 'class_definition') {
        walkClass(definitionNode)
        continue
      }

      if (definitionNode.type === 'function_definition') {
        processFunction(definitionNode)
      }
    }

    const labelToId = new Map<string, string>()
    for (const node of nodes) {
      labelToId.set(normalizeLabel(node.label), node.id)
    }

    for (const pendingInheritance of pendingInherits) {
      const baseId = labelToId.get(normalizeLabel(pendingInheritance.baseName))
      if (!baseId) {
        continue
      }

      addUniqueEdge(edges, seenStructuralEdges, createEdge(pendingInheritance.sourceId, baseId, 'inherits', filePath, pendingInheritance.line))
    }

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const rationale = extractPythonRationale(filePath)
    nodes.push(...rationale.nodes)
    edges.push(...rationale.edges)

    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

export function extractPython(filePath: string): ExtractionFragment {
  const extraction = extractPythonTreeSitter(filePath)
  if (extraction !== null) {
    return extraction
  }

  warnTreeSitterFallback('python')
  return extractPythonRegex(filePath)
}

function extractRubyScanner(filePath: string): ExtractionFragment {
  if (!isTextFileWithinLimit(filePath)) {
    return createTextFallbackExtraction(filePath)
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ownerStack: Array<{ id: string; name: string }> = []
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'class' | 'module' | 'def'> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end') {
      const blockType = blockStack.pop()
      if (blockType === 'def') {
        functionStack.pop()
      }
      if (blockType === 'class' || blockType === 'module') {
        ownerStack.pop()
      }
      return
    }

    const requireRelativeMatch = trimmed.match(/^require_relative\s+['"]([^'"]+)['"]/)
    if (requireRelativeMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(requireRelativeMatch[1])), 'imports_from', filePath, lineNumber))
      return
    }

    const requireMatch = trimmed.match(/^require\s+['"]([^'"]+)['"]/)
    if (requireMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(requireMatch[1])), 'imports', filePath, lineNumber))
      return
    }

    const moduleMatch = trimmed.match(/^module\s+([A-Za-z_][A-Za-z0-9_:]*)/)
    if (moduleMatch?.[1]) {
      const moduleName = moduleMatch[1].split('::').at(-1)
      if (!moduleName) {
        return
      }
      const moduleId = _makeId(stem, moduleName)
      addNode(nodes, seenIds, createNode(moduleId, moduleName, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, moduleId, 'contains', filePath, lineNumber))
      ownerStack.push({ id: moduleId, name: moduleName })
      blockStack.push('module')
      return
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_:]*)(?:\s*<\s*([A-Za-z_][A-Za-z0-9_:]*))?/)
    if (classMatch?.[1]) {
      const className = classMatch[1].split('::').at(-1)
      if (!className) {
        return
      }
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, classId, 'contains', filePath, lineNumber))

      const baseName = classMatch[2]?.split('::').at(-1)
      if (baseName) {
        addEdge(edges, createEdge(classId, _makeId(stem, baseName), 'inherits', filePath, lineNumber))
      }

      ownerStack.push({ id: classId, name: className })
      blockStack.push('class')
      return
    }

    const functionMatch = trimmed.match(/^def\s+(?:(self|[A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/)
    if (functionMatch?.[2]) {
      const functionName = functionMatch[2]
      const explicitOwner = functionMatch[1] && functionMatch[1] !== 'self' ? functionMatch[1] : undefined
      const parentClassId = explicitOwner ? _makeId(stem, explicitOwner) : ownerStack[ownerStack.length - 1]?.id

      if (parentClassId) {
        addNode(nodes, seenIds, createNode(parentClassId, explicitOwner ?? ownerStack[ownerStack.length - 1]?.name ?? stem, filePath, lineNumber))
        const functionId = _makeId(parentClassId, functionName)
        addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(parentClassId, functionId, 'method', filePath, lineNumber))
        methodIdsByClass.set(`${parentClassId}:${functionName.toLowerCase()}`, functionId)
        functionStack.push({ id: functionId, classId: parentClassId })
      } else {
        const functionId = _makeId(stem, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))
        functionStack.push({ id: functionId })
      }

      blockStack.push('def')
      return
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\bself\.([A-Za-z_][A-Za-z0-9_!?=]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_!?=]*)\s*\(/g)) {
      const calleeName = match[1]
      const matchIndex = match.index ?? -1
      if (!calleeName || RUBY_KEYWORDS.has(calleeName) || (matchIndex > 0 && trimmed[matchIndex - 1] === '.')) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractRuby(filePath: string): ExtractionFragment {
  const extraction = extractRubyTreeSitter(filePath)
  if (extraction !== null) {
    return extraction
  }

  warnTreeSitterFallback('ruby')
  return extractRubyScanner(filePath)
}

export function extractLua(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  const ownerIdsByName = new Map<string, string>()
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'function' | 'block'> = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ensureOwner = (ownerName: string, lineNumber: number): string => {
    const existingId = ownerIdsByName.get(ownerName)
    if (existingId) {
      return existingId
    }

    const ownerId = _makeId(stem, ownerName)
    ownerIdsByName.set(ownerName, ownerId)
    addNode(nodes, seenIds, createNode(ownerId, ownerName, filePath, lineNumber))
    addEdge(edges, createEdge(fileNodeId, ownerId, 'contains', filePath, lineNumber))
    return ownerId
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end' || trimmed === 'until') {
      const blockType = blockStack.length > 0 ? blockStack.pop() : undefined
      if (blockType === 'function') {
        functionStack.pop()
      }
      return
    }

    const requireMatch = trimmed.match(/^local\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*require\(["']([^"']+)["']\)/) ?? trimmed.match(/^require\(["']([^"']+)["']\)/)
    if (requireMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(requireMatch[1])), 'imports', filePath, lineNumber))
      return
    }

    const tableMatch = trimmed.match(/^(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*\}$/)
    if (tableMatch?.[1]) {
      ensureOwner(tableMatch[1], lineNumber)
      return
    }

    const methodMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)[:.]([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (methodMatch?.[1] && methodMatch[2]) {
      const ownerId = ensureOwner(methodMatch[1], lineNumber)
      const functionName = methodMatch[2]
      const functionId = _makeId(ownerId, functionName)
      addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(ownerId, functionId, 'method', filePath, lineNumber))
      methodIdsByClass.set(`${ownerId}:${functionName.toLowerCase()}`, functionId)
      functionStack.push({ id: functionId, classId: ownerId })
      blockStack.push('function')
      return
    }

    const functionMatch = trimmed.match(/^(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (functionMatch?.[1]) {
      const functionName = functionMatch[1]
      const functionId = _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))
      functionStack.push({ id: functionId })
      blockStack.push('function')
      return
    }

    if (/\b(?:if|for|while|repeat|do)\b/.test(trimmed)) {
      blockStack.push('block')
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\bself[:.]([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const calleeName = match[1]
      const matchIndex = match.index ?? -1
      if (!calleeName || LUA_KEYWORDS.has(calleeName) || (matchIndex > 0 && (trimmed[matchIndex - 1] === '.' || trimmed[matchIndex - 1] === ':'))) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

function extractToc(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const fileNode = createFileNode(filePath, 'document')

  addNode(nodes, seenIds, fileNode)

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed) {
      continue
    }

    const metadataMatch = trimmed.match(/^##\s*([A-Za-z][A-Za-z0-9 _-]*):\s*(.+)$/)
    if (metadataMatch?.[1] && metadataMatch[2]) {
      const label = `${metadataMatch[1]}: ${metadataMatch[2].trim()}`
      const metadataId = sectionNodeId(filePath, label, lineNumber)
      addNode(nodes, seenIds, createNode(metadataId, label, filePath, lineNumber, 'document'))
      addEdge(edges, createEdge(fileNode.id, metadataId, 'contains', filePath, lineNumber))
      continue
    }

    if (trimmed.startsWith('#')) {
      continue
    }

    const cleanedTarget = cleanReferenceTarget(trimmed)
    if (!cleanedTarget) {
      continue
    }

    const resolvedTarget = resolve(dirname(filePath), cleanedTarget)
    if (!allowedTargets.has(resolvedTarget) || !existsSync(resolvedTarget)) {
      continue
    }

    addEdge(edges, createEdge(fileNode.id, targetNodeId(resolvedTarget), 'references', filePath, lineNumber))
  }

  return { nodes, edges }
}

export function extractElixir(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ownerStack: Array<{ id: string; name: string }> = []
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'module' | 'def'> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end') {
      const blockType = blockStack.pop()
      if (blockType === 'def') {
        functionStack.pop()
      }
      if (blockType === 'module') {
        ownerStack.pop()
      }
      return
    }

    const importMatch = trimmed.match(/^(?:alias|import|use)\s+([A-Za-z_][A-Za-z0-9_.]*)/)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports_from', filePath, lineNumber))
      return
    }

    const moduleMatch = trimmed.match(/^defmodule\s+([A-Za-z_][A-Za-z0-9_.]*)\s+do\b/)
    if (moduleMatch?.[1]) {
      const moduleName = moduleMatch[1].split('.').at(-1)
      if (!moduleName) {
        return
      }
      const moduleId = _makeId(stem, moduleName)
      addNode(nodes, seenIds, createNode(moduleId, moduleName, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, moduleId, 'contains', filePath, lineNumber))
      ownerStack.push({ id: moduleId, name: moduleName })
      blockStack.push('module')
      return
    }

    const functionMatch = trimmed.match(/^defp?\s+([A-Za-z_][A-Za-z0-9_!?]*)\b(?:\s*\(|\s+do\b)/)
    if (functionMatch?.[1]) {
      const functionName = functionMatch[1]
      const parentId = ownerStack[ownerStack.length - 1]?.id
      const functionId = parentId ? _makeId(parentId, functionName) : _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${parentId ? '.' : ''}${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(parentId ?? fileNodeId, functionId, parentId ? 'method' : 'contains', filePath, lineNumber))
      if (parentId) {
        methodIdsByClass.set(`${parentId}:${functionName.toLowerCase()}`, functionId)
      }
      functionStack.push({ id: functionId, ...(parentId ? { classId: parentId } : {}) })
      blockStack.push('def')
      return
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_!?]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName || ELIXIR_KEYWORDS.has(calleeName)) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractJulia(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ownerStack: Array<{ id: string; name: string }> = []
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'struct' | 'function'> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end') {
      const blockType = blockStack.pop()
      if (blockType === 'function') {
        functionStack.pop()
      }
      if (blockType === 'struct') {
        ownerStack.pop()
      }
      return
    }

    const importMatch = trimmed.match(/^(?:using|import)\s+([A-Za-z_][A-Za-z0-9_.:]*)/)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports', filePath, lineNumber))
      return
    }

    const structMatch = trimmed.match(/^(?:mutable\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (structMatch?.[1]) {
      const structName = structMatch[1]
      const structId = _makeId(stem, structName)
      addNode(nodes, seenIds, createNode(structId, structName, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, structId, 'contains', filePath, lineNumber))
      ownerStack.push({ id: structId, name: structName })
      blockStack.push('struct')
      return
    }

    const functionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_!]*)\s*\(/) ?? trimmed.match(/^([A-Za-z_][A-Za-z0-9_!]*)\s*\([^=]*\)\s*=/)
    if (functionMatch?.[1]) {
      const functionName = functionMatch[1]
      const functionId = _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))

      const inlineDefinition = trimmed.includes('=') && !trimmed.startsWith('function ')
      if (!inlineDefinition) {
        functionStack.push({ id: functionId })
        blockStack.push('function')
      }

      if (inlineDefinition) {
        const bodyStart = trimmed.indexOf('=') + 1
        for (const match of trimmed.slice(bodyStart).matchAll(/\b([A-Za-z_][A-Za-z0-9_!]*)\s*\(/g)) {
          const calleeName = match[1]
          if (!calleeName || JULIA_KEYWORDS.has(calleeName)) {
            continue
          }
          addPendingCall(pendingCalls, { callerId: functionId, calleeName, line: lineNumber })
        }
      }
      return
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_!]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName || JULIA_KEYWORDS.has(calleeName)) {
        continue
      }
      addPendingCall(pendingCalls, { callerId: currentFunction.id, calleeName, line: lineNumber })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractPowerShell(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  let braceDepth = 0
  const classStack: Array<{ braceDepth: number; id: string; name: string }> = []
  const functionStack: Array<{ braceDepth: number; id: string; classId?: string }> = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed || trimmed.startsWith('//')) {
      braceDepth += braceDelta(line)
      continue
    }

    while (functionStack.length > 0 && braceDepth < (functionStack[functionStack.length - 1]?.braceDepth ?? 0)) {
      functionStack.pop()
    }
    while (classStack.length > 0 && braceDepth < (classStack[classStack.length - 1]?.braceDepth ?? 0)) {
      classStack.pop()
    }

    const importMatch = trimmed.match(/^Import-Module\s+([A-Za-z0-9_.-]+)/i) ?? trimmed.match(/^using\s+module\s+([A-Za-z0-9_.-]+)/i)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports', filePath, lineNumber))
      braceDepth += braceDelta(line)
      continue
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)
    if (classMatch?.[1]) {
      const className = classMatch[1]
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, lineNumber))

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{')) {
        classStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: classId, name: className })
      }
      braceDepth = nextBraceDepth
      continue
    }

    let functionName: string | null = null
    let ownerClassId: string | undefined
    const currentClass = classStack[classStack.length - 1]

    const psFunctionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_-]*)\b/i)
    if (psFunctionMatch?.[1]) {
      functionName = psFunctionMatch[1]
    } else {
      const psMethodMatch = trimmed.match(/^\[[^\]]+\]\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\([^)]*\)\s*\{/)
      if (psMethodMatch?.[1]) {
        functionName = psMethodMatch[1]
        ownerClassId = currentClass?.id
      }
    }

    if (functionName) {
      const functionId = ownerClassId ? _makeId(ownerClassId, functionName) : _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${ownerClassId ? '.' : ''}${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(ownerClassId ?? fileNodeId, functionId, ownerClassId ? 'method' : 'contains', filePath, lineNumber))
      if (ownerClassId) {
        methodIdsByClass.set(`${ownerClassId}:${functionName.toLowerCase()}`, functionId)
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{')) {
        functionStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: functionId, ...(ownerClassId ? { classId: ownerClassId } : {}) })
      }
      braceDepth = nextBraceDepth
      continue
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (currentFunction) {
      for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_-]*)\b/g)) {
        const calleeName = match[1]
        if (!calleeName || POWERSHELL_KEYWORDS.has(calleeName.toLowerCase()) || calleeName === currentClass?.name) {
          continue
        }
        const previous = trimmed[(match.index ?? 0) - 1] ?? ''
        if (previous === '$' || previous === '-' || previous === '.') {
          continue
        }
        addPendingCall(pendingCalls, { callerId: currentFunction.id, calleeName, line: lineNumber, preferredClassId: currentFunction.classId })
        break
      }
    }

    braceDepth += braceDelta(line)
  }

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractObjectiveC(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  let currentClass: { id: string; name: string } | undefined
  let braceDepth = 0
  const functionStack: Array<{ braceDepth: number; id: string; classId?: string }> = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed || trimmed.startsWith('//')) {
      braceDepth += braceDelta(line)
      continue
    }

    while (functionStack.length > 0 && braceDepth < (functionStack[functionStack.length - 1]?.braceDepth ?? 0)) {
      functionStack.pop()
    }

    const importMatch = trimmed.match(/^#import\s+[<"]([^>"]+)[>"]/)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports_from', filePath, lineNumber))
      braceDepth += braceDelta(line)
      continue
    }

    if (trimmed === '@end') {
      currentClass = undefined
      braceDepth += braceDelta(line)
      continue
    }

    const classMatch = trimmed.match(/^@(?:interface|implementation)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (classMatch?.[1]) {
      const className = classMatch[1]
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, lineNumber))
      currentClass = { id: classId, name: className }
      braceDepth += braceDelta(line)
      continue
    }

    const methodMatch = trimmed.match(/^[+-]\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)[^;]*\{/)
    if (methodMatch?.[1] && currentClass) {
      const functionName = methodMatch[1]
      const functionId = _makeId(currentClass.id, functionName)
      addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(currentClass.id, functionId, 'method', filePath, lineNumber))
      methodIdsByClass.set(`${currentClass.id}:${functionName.toLowerCase()}`, functionId)

      const nextBraceDepth = braceDepth + braceDelta(line)
      functionStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: functionId, classId: currentClass.id })

      const inlineStart = trimmed.indexOf('{') + 1
      if (inlineStart > 0) {
        for (const match of trimmed.slice(inlineStart).matchAll(/\[[^\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
          const calleeName = match[1]
          if (!calleeName) {
            continue
          }
          addPendingCall(pendingCalls, { callerId: functionId, calleeName, line: lineNumber, preferredClassId: currentClass.id })
        }
      }

      braceDepth = nextBraceDepth
      continue
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (currentFunction) {
      for (const match of trimmed.matchAll(/\[[^\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
        const calleeName = match[1]
        if (!calleeName) {
          continue
        }
        addPendingCall(pendingCalls, { callerId: currentFunction.id, calleeName, line: lineNumber, preferredClassId: currentFunction.classId })
      }
    }

    braceDepth += braceDelta(line)
  }

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const extension = extname(filePath).toLowerCase()
  switch (extension) {
    case '.ts':
      return ts.ScriptKind.TS
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    default:
      return ts.ScriptKind.JS
  }
}

function namedTreeSitterChildren(node: TreeSitterNode): TreeSitterNode[] {
  return node.namedChildren.filter((child): child is TreeSitterNode => child !== null)
}

function treeSitterNodeText(sourceText: string, node: TreeSitterNode | null | undefined): string | null {
  if (!node) {
    return null
  }

  return sourceText.slice(node.startIndex, node.endIndex)
}

function warnTreeSitterFallback(language: 'go' | 'java' | 'python' | 'ruby'): void {
  const runtimeError = treeSitterWasmError()
  const warningKey = `${language}:${runtimeError ?? 'parser-unavailable'}`
  if (TREE_SITTER_FALLBACK_WARNINGS.has(warningKey)) {
    return
  }

  TREE_SITTER_FALLBACK_WARNINGS.add(warningKey)
  const suffix = runtimeError ? ` (${runtimeError})` : ''
  console.warn(`[graphify-ts] tree-sitter ${language} parser unavailable; falling back to the legacy extractor${suffix}`)
}

function collectGoImports(node: TreeSitterNode, sourceText: string): string[] {
  const imports: string[] = []
  for (const match of sourceText.slice(node.startIndex, node.endIndex).matchAll(/"([^"]+)"/g)) {
    const importPath = match[1]
    if (importPath) {
      imports.push(importPath)
    }
  }

  return imports
}

function lastScopedRubyName(name: string | null | undefined): string | null {
  const trimmed = name?.trim()
  if (!trimmed) {
    return null
  }

  const normalized = trimmed.replace(/^<\s*/, '').replace(/^::/, '').trim()
  if (!normalized) {
    return null
  }

  const parts = normalized.split('::').filter(Boolean)
  return parts.at(-1) ?? normalized
}

function extractRubyStringArgument(sourceText: string, node: TreeSitterNode | null | undefined): string | null {
  if (!node) {
    return null
  }

  const stringNode =
    node.type === 'argument_list' ? (namedTreeSitterChildren(node).find((child) => child.type === 'string') ?? null) : node.type === 'string' ? node : null

  if (!stringNode) {
    return null
  }

  const contentNode = namedTreeSitterChildren(stringNode).find((child) => child.type === 'string_content') ?? stringNode
  const rawValue = treeSitterNodeText(sourceText, contentNode)?.trim()
  if (!rawValue) {
    return null
  }

  return rawValue.replace(/^['"]|['"]$/g, '')
}

function collectRubyImports(
  node: TreeSitterNode,
  sourceText: string,
  fileNodeId: string,
  filePath: string,
  edges: ExtractionEdge[],
  seenStructuralEdges: Set<string>,
  depth = 0,
): void {
  if (depth >= MAX_RUBY_AST_DEPTH) {
    return
  }

  if (node.type === 'call') {
    const receiverNode = node.childForFieldName('receiver')
    const methodNode = node.childForFieldName('method') ?? namedTreeSitterChildren(node).find((child) => child.type === 'identifier') ?? null
    const methodName = treeSitterNodeText(sourceText, methodNode)?.trim()
    if (!receiverNode && (methodName === 'require' || methodName === 'require_relative')) {
      const importTarget = extractRubyStringArgument(sourceText, node.childForFieldName('arguments'))
      if (importTarget) {
        addUniqueEdge(
          edges,
          seenStructuralEdges,
          createEdge(
            fileNodeId,
            _makeId(normalizeImportTarget(importTarget)),
            methodName === 'require_relative' ? 'imports_from' : 'imports',
            filePath,
            node.startPosition.row + 1,
          ),
        )
      }
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    collectRubyImports(child, sourceText, fileNodeId, filePath, edges, seenStructuralEdges, depth + 1)
  }
}

function collectRubyCalls(
  node: TreeSitterNode,
  sourceText: string,
  stem: string,
  callerId: string,
  pendingCalls: PendingCall[],
  currentOwnerId?: string,
  depth = 0,
): void {
  if (depth >= MAX_RUBY_AST_DEPTH) {
    return
  }

  if (node.type === 'call') {
    const methodNode = node.childForFieldName('method') ?? namedTreeSitterChildren(node).find((child) => child.type === 'identifier') ?? null
    const methodName = treeSitterNodeText(sourceText, methodNode)?.trim()
    if (methodName && !RUBY_KEYWORDS.has(methodName)) {
      const receiverNode = node.childForFieldName('receiver')
      const receiverText = treeSitterNodeText(sourceText, receiverNode)?.trim()
      let preferredClassId: string | undefined

      if (receiverNode?.type === 'self') {
        preferredClassId = currentOwnerId
      } else if (receiverText && (/^[A-Z]/.test(receiverText) || receiverText.includes('::'))) {
        const ownerName = lastScopedRubyName(receiverText)
        if (ownerName) {
          preferredClassId = _makeId(stem, ownerName)
        }
      } else if (!receiverNode) {
        preferredClassId = currentOwnerId
      }

      addPendingCall(pendingCalls, {
        callerId,
        calleeName: methodName,
        line: node.startPosition.row + 1,
        preferredClassId,
      })
    }
    return
  }

  for (const child of namedTreeSitterChildren(node)) {
    if (RUBY_AST_NESTED_DECLARATION_TYPES.has(child.type)) {
      continue
    }

    if (node.type === 'body_statement' && child.type === 'identifier') {
      const calleeName = treeSitterNodeText(sourceText, child)?.trim()
      if (calleeName && !RUBY_KEYWORDS.has(calleeName)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line: child.startPosition.row + 1,
          preferredClassId: currentOwnerId,
        })
      }
      continue
    }

    collectRubyCalls(child, sourceText, stem, callerId, pendingCalls, currentOwnerId, depth + 1)
  }
}

function extractRubyTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('ruby')
  if (!parser) {
    return null
  }

  if (!isTextFileWithinLimit(filePath)) {
    return createTextFallbackExtraction(filePath)
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureOwnerNode = (ownerName: string, line: number, parentOwnerId?: string): string => {
    const ownerId = _makeId(stem, ownerName)
    addNode(nodes, seenIds, createNode(ownerId, ownerName, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, ownerId, 'contains', filePath, line))
    return ownerId
  }

  const ensureMethodNode = (ownerId: string, methodName: string, line: number): string => {
    const methodId = _makeId(ownerId, methodName)
    addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, methodId, 'method', filePath, line))
    methodIdsByClass.set(`${ownerId}:${methodName.toLowerCase()}`, methodId)
    return methodId
  }

  const ensureFunctionNode = (functionName: string, line: number): string => {
    const functionId = _makeId(stem, functionName)
    addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, functionId, 'contains', filePath, line))
    return functionId
  }

  const walkRubyStatements = (node: TreeSitterNode, parentOwnerId?: string, depth = 0): void => {
    if (depth >= MAX_RUBY_AST_DEPTH) {
      return
    }

    for (const child of namedTreeSitterChildren(node)) {
      if (child.type === 'module') {
        const ownerName = lastScopedRubyName(treeSitterNodeText(sourceText, child.childForFieldName('name')))
        if (!ownerName) {
          continue
        }

        const ownerId = ensureOwnerNode(ownerName, child.startPosition.row + 1, parentOwnerId)
        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          walkRubyStatements(bodyNode, ownerId, depth + 1)
        }
        continue
      }

      if (child.type === 'class') {
        const ownerName = lastScopedRubyName(treeSitterNodeText(sourceText, child.childForFieldName('name')))
        if (!ownerName) {
          continue
        }

        const ownerId = ensureOwnerNode(ownerName, child.startPosition.row + 1, parentOwnerId)
        const superclassName = lastScopedRubyName(treeSitterNodeText(sourceText, child.childForFieldName('superclass')))
        if (superclassName) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, _makeId(stem, superclassName), 'inherits', filePath, child.startPosition.row + 1))
        }

        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          walkRubyStatements(bodyNode, ownerId, depth + 1)
        }
        continue
      }

      if (child.type === 'method') {
        const methodName = treeSitterNodeText(sourceText, child.childForFieldName('name'))?.trim()
        if (!methodName) {
          continue
        }

        const methodId = parentOwnerId
          ? ensureMethodNode(parentOwnerId, methodName, child.startPosition.row + 1)
          : ensureFunctionNode(methodName, child.startPosition.row + 1)
        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          collectRubyCalls(bodyNode, sourceText, stem, methodId, pendingCalls, parentOwnerId, depth + 1)
        }
        continue
      }

      if (child.type === 'singleton_method') {
        const methodName = treeSitterNodeText(sourceText, child.childForFieldName('name'))?.trim()
        if (!methodName) {
          continue
        }

        const objectText = treeSitterNodeText(sourceText, child.childForFieldName('object'))?.trim()
        let ownerId: string | undefined
        if (objectText === 'self') {
          ownerId = parentOwnerId
        } else {
          const explicitOwnerName = lastScopedRubyName(objectText)
          if (explicitOwnerName) {
            ownerId = ensureOwnerNode(explicitOwnerName, child.startPosition.row + 1, parentOwnerId)
          }
        }

        const methodId = ownerId ? ensureMethodNode(ownerId, methodName, child.startPosition.row + 1) : ensureFunctionNode(methodName, child.startPosition.row + 1)
        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          collectRubyCalls(bodyNode, sourceText, stem, methodId, pendingCalls, ownerId ?? parentOwnerId, depth + 1)
        }
        continue
      }
    }
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))
    collectRubyImports(tree.rootNode, sourceText, fileNodeId, filePath, edges, seenStructuralEdges)
    walkRubyStatements(tree.rootNode)

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

function goReceiverInfo(sourceText: string, receiverNode: TreeSitterNode | null): { ownerName: string; receiverName?: string } | null {
  if (!receiverNode) {
    return null
  }

  const parameterNode = namedTreeSitterChildren(receiverNode).find((child) => child.type === 'parameter_declaration')
  if (!parameterNode) {
    return null
  }

  const receiverName = treeSitterNodeText(sourceText, parameterNode.childForFieldName('name')) ?? undefined
  const typeNode = parameterNode.childForFieldName('type')
  const ownerTypeNode =
    typeNode?.type === 'pointer_type'
      ? (namedTreeSitterChildren(typeNode).find((child) => child.type === 'type_identifier') ?? null)
      : typeNode?.type === 'type_identifier'
        ? typeNode
        : (namedTreeSitterChildren(typeNode ?? parameterNode).find((child) => child.type === 'type_identifier') ?? null)

  const ownerName = treeSitterNodeText(sourceText, ownerTypeNode)?.trim()
  if (!ownerName) {
    return null
  }

  return {
    ownerName,
    ...(receiverName ? { receiverName } : {}),
  }
}

function collectGoCalls(node: TreeSitterNode, sourceText: string, callerId: string, pendingCalls: PendingCall[], receiverName?: string, currentOwnerId?: string): void {
  if (node.type === 'call_expression') {
    const functionNode = node.childForFieldName('function')
    const line = node.startPosition.row + 1
    if (functionNode?.type === 'identifier') {
      const calleeName = treeSitterNodeText(sourceText, functionNode)?.trim()
      if (calleeName) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
        })
      }
    } else if (functionNode?.type === 'selector_expression') {
      const operandNode = functionNode.childForFieldName('operand')
      const fieldNode = functionNode.childForFieldName('field')
      const calleeName = treeSitterNodeText(sourceText, fieldNode)?.trim()
      if (calleeName) {
        const operandName = treeSitterNodeText(sourceText, operandNode)?.trim()
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
          preferredClassId: currentOwnerId && receiverName && operandName === receiverName ? currentOwnerId : undefined,
        })
      }
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    collectGoCalls(child, sourceText, callerId, pendingCalls, receiverName, currentOwnerId)
  }
}

function extractGoTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('go')
  if (!parser) {
    return null
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureOwnerNode = (ownerName: string, line: number): string => {
    const ownerId = _makeId(stem, ownerName)
    addNode(nodes, seenIds, createNode(ownerId, ownerName, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, ownerId, 'contains', filePath, line))
    return ownerId
  }

  const ensureMethodNode = (ownerId: string, methodName: string, line: number): string => {
    const methodId = _makeId(ownerId, methodName)
    addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, methodId, 'method', filePath, line))
    methodIdsByClass.set(`${ownerId}:${methodName.toLowerCase()}`, methodId)
    return methodId
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

    for (const node of namedTreeSitterChildren(tree.rootNode)) {
      if (node.type === 'import_declaration') {
        for (const importPath of collectGoImports(node, sourceText)) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(resolveModuleName(importPath)), 'imports_from', filePath, node.startPosition.row + 1))
        }
        continue
      }

      if (node.type === 'type_declaration') {
        for (const typeSpec of namedTreeSitterChildren(node).filter((child) => child.type === 'type_spec')) {
          const nameNode = typeSpec.childForFieldName('name')
          const typeName = treeSitterNodeText(sourceText, nameNode)?.trim()
          if (!typeName) {
            continue
          }

          const ownerId = ensureOwnerNode(typeName, typeSpec.startPosition.row + 1)
          const typeNode = typeSpec.childForFieldName('type')
          if (typeNode?.type !== 'interface_type') {
            continue
          }

          for (const memberNode of namedTreeSitterChildren(typeNode).filter((child) => child.type === 'method_elem')) {
            const methodName = treeSitterNodeText(sourceText, memberNode.childForFieldName('name'))?.trim()
            if (!methodName) {
              continue
            }

            ensureMethodNode(ownerId, methodName, memberNode.startPosition.row + 1)
          }
        }
        continue
      }

      if (node.type === 'method_declaration') {
        const receiver = goReceiverInfo(sourceText, node.childForFieldName('receiver'))
        const methodName = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
        if (!receiver?.ownerName || !methodName) {
          continue
        }

        const ownerId = ensureOwnerNode(receiver.ownerName, node.startPosition.row + 1)
        const methodId = ensureMethodNode(ownerId, methodName, node.startPosition.row + 1)
        const bodyNode = node.childForFieldName('body')
        if (bodyNode) {
          collectGoCalls(bodyNode, sourceText, methodId, pendingCalls, receiver.receiverName, ownerId)
        }
        continue
      }

      if (node.type === 'function_declaration') {
        const nameNode = node.childForFieldName('name')
        const functionName = treeSitterNodeText(sourceText, nameNode)?.trim()
        if (!functionName) {
          continue
        }

        const functionId = _makeId(stem, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, node.startPosition.row + 1))
        addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, functionId, 'contains', filePath, node.startPosition.row + 1))

        const bodyNode = node.childForFieldName('body')
        if (bodyNode) {
          collectGoCalls(bodyNode, sourceText, functionId, pendingCalls)
        }
      }
    }

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

const JAVA_TYPE_DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration'])

function collectJavaCalls(node: TreeSitterNode, sourceText: string, callerId: string, pendingCalls: PendingCall[]): void {
  if (node.type === 'method_invocation') {
    const methodName = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
    if (methodName) {
      addPendingCall(pendingCalls, {
        callerId,
        calleeName: methodName,
        line: node.startPosition.row + 1,
      })
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    if (JAVA_TYPE_DECLARATIONS.has(child.type)) {
      continue
    }

    collectJavaCalls(child, sourceText, callerId, pendingCalls)
  }
}

function extractJavaImportTarget(importText: string): string | null {
  const match = importText.match(/\bimport\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_$.]*)\s*;/)
  if (!match?.[1]) {
    return null
  }

  return normalizeImportTarget(match[1])
}

function extractJavaTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('java')
  if (!parser) {
    return null
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureTypeNode = (typeName: string, line: number, parentOwnerId?: string): string => {
    const typeId = _makeId(stem, typeName)
    addNode(nodes, seenIds, createNode(typeId, typeName, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, typeId, 'contains', filePath, line))
    return typeId
  }

  const ensureMethodNode = (ownerId: string, methodName: string, line: number): string => {
    const methodId = _makeId(ownerId, methodName)
    addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, methodId, 'method', filePath, line))
    methodIdsByClass.set(`${ownerId}:${methodName.toLowerCase()}`, methodId)
    return methodId
  }

  const walkTypeDeclaration = (node: TreeSitterNode, parentOwnerId?: string): void => {
    const nameNode = node.childForFieldName('name')
    const typeName = treeSitterNodeText(sourceText, nameNode)?.trim()
    if (!typeName) {
      return
    }

    const ownerId = ensureTypeNode(typeName, node.startPosition.row + 1, parentOwnerId)
    const bodyNode = node.childForFieldName('body')
    if (!bodyNode) {
      return
    }

    for (const child of namedTreeSitterChildren(bodyNode)) {
      if (JAVA_TYPE_DECLARATIONS.has(child.type)) {
        walkTypeDeclaration(child, ownerId)
        continue
      }

      if (child.type !== 'method_declaration' && child.type !== 'constructor_declaration') {
        continue
      }

      const methodName = treeSitterNodeText(sourceText, child.childForFieldName('name'))?.trim() ?? (child.type === 'constructor_declaration' ? typeName : null)
      if (!methodName) {
        continue
      }

      const methodId = ensureMethodNode(ownerId, methodName, child.startPosition.row + 1)
      const methodBody = child.childForFieldName('body')
      if (methodBody) {
        collectJavaCalls(methodBody, sourceText, methodId, pendingCalls)
      }
    }
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

    for (const node of namedTreeSitterChildren(tree.rootNode)) {
      if (node.type === 'import_declaration') {
        const importTarget = extractJavaImportTarget(sourceText.slice(node.startIndex, node.endIndex))
        if (importTarget) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(importTarget), 'imports_from', filePath, node.startPosition.row + 1))
        }
        continue
      }

      if (JAVA_TYPE_DECLARATIONS.has(node.type)) {
        walkTypeDeclaration(node)
      }
    }

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

export function extractJs(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenImportEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const addTsCalls = (node: ts.Node, callerId: string, currentClassId?: string, isRoot = true): void => {
    if (
      !isRoot &&
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))
    ) {
      return
    }

    if (ts.isCallExpression(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const expression = node.expression
      if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier] = node.arguments
        if (specifier && ts.isStringLiteralLike(specifier)) {
          addTsImportEdge(edges, seenImportEdges, callerId, specifier.text, filePath, line)
        }
      } else if (moduleSpecifierFromRequireCall(node)) {
        addTsImportEdge(edges, seenImportEdges, callerId, moduleSpecifierFromRequireCall(node) ?? '', filePath, line)
      } else if (ts.isIdentifier(expression)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName: expression.text,
          line,
        })
      } else if (ts.isPropertyAccessExpression(expression)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName: expression.name.text,
          line,
          preferredClassId: expression.expression.kind === ts.SyntaxKind.ThisKeyword ? currentClassId : undefined,
        })
      }
    }
    ts.forEachChild(node, (child) => addTsCalls(child, callerId, currentClassId, false))
  }

  const addNestedTsFunctions = (node: ts.Node, ownerId: string, currentClassId?: string, depth = 0): void => {
    if (depth >= MAX_TS_NESTED_FUNCTION_DEPTH) {
      return
    }

    const visitNested = (candidate: ts.Node): void => {
      if (ts.isFunctionDeclaration(candidate) && candidate.name) {
        const functionName = candidate.name.text
        const functionLine = sourceFile.getLineAndCharacterOfPosition(candidate.name.getStart(sourceFile)).line + 1
        const functionId = _makeId(ownerId, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, functionLine))
        addEdge(edges, createEdge(ownerId, functionId, 'contains', filePath, functionLine))
        if (candidate.body) {
          addTsCalls(candidate.body, functionId, currentClassId)
          addNestedTsFunctions(candidate.body, functionId, currentClassId, depth + 1)
        }
        return
      }

      if (ts.isVariableStatement(candidate)) {
        for (const declaration of candidate.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            continue
          }

          if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) {
            continue
          }

          const functionName = declaration.name.text
          const functionLine = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile)).line + 1
          const functionId = _makeId(ownerId, functionName)
          addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, functionLine))
          addEdge(edges, createEdge(ownerId, functionId, 'contains', filePath, functionLine))
          addTsCalls(declaration.initializer.body, functionId, currentClassId)
          addNestedTsFunctions(declaration.initializer.body, functionId, currentClassId, depth + 1)
        }
        return
      }

      ts.forEachChild(candidate, visitNested)
    }

    ts.forEachChild(node, visitNested)
  }

  const visitTopLevel = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addTsImportEdge(
        edges,
        seenImportEdges,
        fileNodeId,
        node.moduleSpecifier.text,
        filePath,
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      )
      return
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addTsImportEdge(
        edges,
        seenImportEdges,
        fileNodeId,
        node.moduleSpecifier.text,
        filePath,
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      )
      return
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addTsImportEdge(
        edges,
        seenImportEdges,
        fileNodeId,
        node.moduleReference.expression.text,
        filePath,
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      )
      return
    }

    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const requireSpecifier = moduleSpecifierFromRequireCall(node.expression)
      if (requireSpecifier) {
        addTsImportEdge(edges, seenImportEdges, fileNodeId, requireSpecifier, filePath, sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
      }
      return
    }

    if (ts.isInterfaceDeclaration(node)) {
      const interfaceName = node.name.text
      const interfaceId = _makeId(stem, interfaceName)
      const interfaceLine = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
      addNode(nodes, seenIds, createNode(interfaceId, interfaceName, filePath, interfaceLine))
      addEdge(edges, createEdge(fileNodeId, interfaceId, 'contains', filePath, interfaceLine))

      for (const heritageClause of node.heritageClauses ?? []) {
        for (const heritageType of heritageClause.types) {
          const baseName = normalizeTypeName(heritageType.expression.getText(sourceFile))
          if (!baseName) {
            continue
          }

          const baseId = _makeId(stem, baseName)
          addNode(nodes, seenIds, createNode(baseId, baseName, filePath, interfaceLine))
          addEdge(edges, createEdge(interfaceId, baseId, 'inherits', filePath, interfaceLine))
        }
      }
      return
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text
      const classId = _makeId(stem, className)
      const classLine = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
      addNode(nodes, seenIds, createNode(classId, className, filePath, classLine))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, classLine))

      for (const heritageClause of node.heritageClauses ?? []) {
        for (const heritageType of heritageClause.types) {
          const baseName = normalizeTypeName(heritageType.expression.getText(sourceFile))
          if (!baseName) {
            continue
          }

          const baseId = _makeId(stem, baseName)
          addNode(nodes, seenIds, createNode(baseId, baseName, filePath, classLine))
          addEdge(edges, createEdge(classId, baseId, 'inherits', filePath, classLine))
        }
      }

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)) {
          if (!ts.isPropertyDeclaration(member) || !member.name || !member.initializer) {
            continue
          }

          if (!ts.isArrowFunction(member.initializer) && !ts.isFunctionExpression(member.initializer)) {
            continue
          }

          const methodName = ts.isIdentifier(member.name)
            ? member.name.text
            : ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
              ? member.name.text
              : member.name.getText(sourceFile)
          if (!methodName) {
            continue
          }

          const methodLine = sourceFile.getLineAndCharacterOfPosition(member.name.getStart(sourceFile)).line + 1
          const methodId = _makeId(classId, methodName)
          addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, methodLine))
          addEdge(edges, createEdge(classId, methodId, 'method', filePath, methodLine))
          methodIdsByClass.set(`${classId}:${methodName.toLowerCase()}`, methodId)
          addTsCalls(member.initializer.body, methodId, classId)
          addNestedTsFunctions(member.initializer.body, methodId, classId)
          continue
        }

        const methodName = ts.isConstructorDeclaration(member)
          ? 'constructor'
          : member.name && ts.isIdentifier(member.name)
            ? member.name.text
            : member.name
              ? member.name.getText(sourceFile)
              : null
        if (!methodName) {
          continue
        }

        const methodLine = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1
        const methodId = _makeId(classId, methodName)
        addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, methodLine))
        addEdge(edges, createEdge(classId, methodId, 'method', filePath, methodLine))
        methodIdsByClass.set(`${classId}:${methodName.toLowerCase()}`, methodId)
        if (member.body) {
          addTsCalls(member.body, methodId, classId)
          addNestedTsFunctions(member.body, methodId, classId)
        }
      }
      return
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const functionName = node.name.text
      const functionLine = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
      const functionId = _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, functionLine))
      addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, functionLine))
      if (node.body) {
        addTsCalls(node.body, functionId)
        addNestedTsFunctions(node.body, functionId)
      }
      return
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue
        }

        if (ts.isCallExpression(declaration.initializer)) {
          const requireSpecifier = moduleSpecifierFromRequireCall(declaration.initializer)
          if (requireSpecifier) {
            const importLine = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile)).line + 1
            addTsImportEdge(edges, seenImportEdges, fileNodeId, requireSpecifier, filePath, importLine)
          }
        }

        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) {
          continue
        }

        const functionName = declaration.name.text
        const functionLine = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile)).line + 1
        const functionId = _makeId(stem, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, functionLine))
        addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, functionLine))

        const body = declaration.initializer.body
        if (body) {
          addTsCalls(body, functionId)
          addNestedTsFunctions(body, functionId)
        }
      }
      return
    }

    ts.forEachChild(node, visitTopLevel)
  }

  visitTopLevel(sourceFile)
  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

const SINGLE_FILE_EXTRACTOR_HANDLERS: ExtractorHandlerMap = {
  'builtin:extract:python': (filePath) => extractPython(filePath),
  'builtin:extract:ruby': (filePath) => extractRuby(filePath),
  'builtin:extract:lua': (filePath) => extractLua(filePath),
  'builtin:extract:toc': (filePath, allowedTargets) => extractToc(filePath, allowedTargets),
  'builtin:extract:elixir': (filePath) => extractElixir(filePath),
  'builtin:extract:julia': (filePath) => extractJulia(filePath),
  'builtin:extract:powershell': (filePath) => extractPowerShell(filePath),
  'builtin:extract:objective-c': (filePath) => extractObjectiveC(filePath),
  'builtin:extract:typescript': (filePath) => extractJs(filePath),
  'builtin:extract:javascript': (filePath) => extractJs(filePath),
  'builtin:extract:go': (filePath) => {
    const extraction = extractGoTreeSitter(filePath)
    if (extraction !== null) {
      return extraction
    }

    warnTreeSitterFallback('go')
    return extractGenericCode(filePath)
  },
  'builtin:extract:java': (filePath) => {
    const extraction = extractJavaTreeSitter(filePath)
    if (extraction !== null) {
      return extraction
    }

    warnTreeSitterFallback('java')
    return extractGenericCode(filePath)
  },
  'builtin:extract:c-family': (filePath) => extractGenericCode(filePath),
  'builtin:extract:rust': (filePath) => extractGenericCode(filePath),
  'builtin:extract:swift': (filePath) => extractGenericCode(filePath),
  'builtin:extract:kotlin': (filePath) => extractGenericCode(filePath),
  'builtin:extract:csharp': (filePath) => extractGenericCode(filePath),
  'builtin:extract:scala': (filePath) => extractGenericCode(filePath),
  'builtin:extract:php': (filePath) => extractGenericCode(filePath),
  'builtin:extract:zig': (filePath) => extractGenericCode(filePath),
  'builtin:extract:markdown': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:markdown-paper': (filePath, allowedTargets) => extractPaperFile(filePath, allowedTargets),
  'builtin:extract:text': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:text-paper': (filePath, allowedTargets) => extractPaperFile(filePath, allowedTargets),
  'builtin:extract:paper': (filePath, allowedTargets) => extractPaperFile(filePath, allowedTargets),
  'builtin:extract:docx': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:xlsx': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:image': (filePath) => extractImageFragment(filePath),
  'builtin:extract:audio': (filePath) => extractAudioFragment(filePath),
  'builtin:extract:video': (filePath) => extractVideoFragment(filePath),
}

function extractSingleFile(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  return dispatchSingleFileExtraction(filePath, allowedTargets, SINGLE_FILE_EXTRACTOR_HANDLERS, {
    registry: builtinCapabilityRegistry,
    readCached: readCachedExtraction,
    writeCached: writeCachedExtraction,
    classifySourceFile: classifyFile,
  })
}

export interface ExtractOptions {
  allowedTargets?: Iterable<string>
  contextNodes?: ExtractionNode[]
}

export function extract(files: string[]): ExtractionData
export function extract(files: string[], options: ExtractOptions): ExtractionData
export function extract(files: string[], options: ExtractOptions = {}): ExtractionData {
  const allowedTargets = new Set([...(options.allowedTargets ?? files)].map((filePath) => resolve(filePath)))
  let combined = mergeExtractionFragments(files.map((filePath) => extractSingleFile(filePath, allowedTargets)))

  combined = options.contextNodes
    ? resolveCrossFilePythonImports(files, combined, { contextNodes: options.contextNodes })
    : resolveCrossFilePythonImports(files, combined)

  combined = options.contextNodes ? resolveSourceNodeReferences(combined, { contextNodes: options.contextNodes }) : resolveSourceNodeReferences(combined)

  return combined
}
