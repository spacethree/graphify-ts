import { basename, dirname, extname, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate'
import * as ts from 'typescript'

import type { ExtractionData, ExtractionEdge, ExtractionNode } from '../contracts/types.js'
import { loadCached, saveCached } from '../infrastructure/cache.js'
import { CODE_EXTENSIONS, FileType, classifyFile, detect } from './detect.js'
import { isRecord } from '../shared/guards.js'
import { MAX_TEXT_BYTES, sanitizeLabel } from '../shared/security.js'

const EXTRACTOR_CACHE_VERSION = 3
const PYTHON_KEYWORDS = new Set(['if', 'elif', 'else', 'for', 'while', 'return', 'class', 'def', 'lambda', 'with', 'print', 'sum'])
const GENERIC_CODE_EXTENSIONS = new Set(['.go', '.rs', '.java', '.kt', '.kts', '.scala', '.cs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.swift', '.php', '.zig'])
const GENERIC_CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'new',
  'delete',
  'throw',
  'sizeof',
  'case',
  'do',
  'else',
])
const RUBY_KEYWORDS = new Set(['if', 'elsif', 'else', 'unless', 'while', 'until', 'return', 'super', 'yield', 'class', 'def'])
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

type NonCodeFileType = Extract<ExtractionNode['file_type'], 'document' | 'paper' | 'image'>

interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
}

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

interface ImportedPythonSymbol {
  localName: string
  targetId: string
}

function toLocation(line: number): string {
  return `L${line}`
}

function normalizeLabel(label: string): string {
  return label.replaceAll('(', '').replaceAll(')', '').replace(/^\./, '').toLowerCase()
}

function stripHashComment(line: string): string {
  let inSingleQuote = false
  let inDoubleQuote = false
  let interpolationDepth = 0
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (!character) {
      continue
    }

    if (escaped) {
      escaped = false
      continue
    }

    if (character === '\\' && (inSingleQuote || inDoubleQuote)) {
      escaped = true
      continue
    }

    if (inDoubleQuote && character === '#' && line[index + 1] === '{') {
      interpolationDepth += 1
      index += 1
      continue
    }

    if (inDoubleQuote && interpolationDepth > 0 && character === '}') {
      interpolationDepth -= 1
      continue
    }

    if (character === '\'' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (character === '#' && !inSingleQuote && !inDoubleQuote && interpolationDepth === 0) {
      return line.slice(0, index)
    }
  }

  return line
}

function createNode(id: string, label: string, sourceFile: string, line: number, fileType: ExtractionNode['file_type'] = 'code'): ExtractionNode {
  return {
    id,
    label: sanitizeLabel(label),
    file_type: fileType,
    source_file: sourceFile,
    source_location: toLocation(line),
  }
}

function createFileNode(filePath: string, fileType: ExtractionNode['file_type']): ExtractionNode {
  return createNode(_makeId(basename(filePath, extname(filePath))), basename(filePath), filePath, 1, fileType)
}

function createEdge(
  source: string,
  target: string,
  relation: string,
  sourceFile: string,
  line: number,
  confidence: ExtractionEdge['confidence'] = 'EXTRACTED',
  weight = 1.0,
): ExtractionEdge {
  return {
    source,
    target,
    relation,
    confidence,
    source_file: sourceFile,
    source_location: toLocation(line),
    weight,
  }
}

function addNode(nodes: ExtractionNode[], seenIds: Set<string>, node: ExtractionNode): void {
  if (!seenIds.has(node.id)) {
    seenIds.add(node.id)
    nodes.push(node)
  }
}

function addEdge(edges: ExtractionEdge[], edge: ExtractionEdge): void {
  edges.push(edge)
}

function addUniqueEdge(edges: ExtractionEdge[], seen: Set<string>, edge: ExtractionEdge): void {
  const key = `${edge.source}|${edge.target}|${edge.relation}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  edges.push(edge)
}

function resolveModuleName(specifier: string): string {
  const normalized = specifier.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\.\//, '')
  const lastSegment = normalized.split('/').filter(Boolean).at(-1) ?? normalized
  const extension = extname(lastSegment)
  return extension ? lastSegment.slice(0, -extension.length) : lastSegment
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

function addLocalReferenceEdges(
  edges: ExtractionEdge[],
  line: string,
  filePath: string,
  sourceId: string,
  lineNumber: number,
  allowedTargets: ReadonlySet<string>,
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
    const targetId = targetNodeId(resolvedTarget)
    if (sourceId === targetId) {
      continue
    }

    addEdge(edges, createEdge(sourceId, targetId, relation, filePath, lineNumber))
  }
}

function extractStructuredText(
  filePath: string,
  fileType: Extract<NonCodeFileType, 'document' | 'paper'>,
  allowedTargets: ReadonlySet<string>,
): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
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

  const headingStack: Array<{ level: number; id: string }> = []
  let inFrontmatter = lines[0]?.trim() === '---'
  let fenceMarker: '```' | '~~~' | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1

    if (inFrontmatter) {
      if (index > 0 && trimmed === '---') {
        inFrontmatter = false
      }
      continue
    }

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
      headingStack.push({ level: heading.level, id: nodeId })

      addLocalReferenceEdges(edges, line, filePath, nodeId, lineNumber, allowedTargets)

      if (heading.consumedLines === 2) {
        index += 1
      }
      continue
    }

    if (!trimmed) {
      continue
    }

    const currentSectionId = headingStack[headingStack.length - 1]?.id ?? fileNode.id
    addLocalReferenceEdges(edges, line, filePath, currentSectionId, lineNumber, allowedTargets)
  }

  return { nodes, edges }
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
  const headingStack: Array<{ level: number; id: string }> = []
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
      headingStack.push({ level: headingLevel, id: nodeId })
      addLocalReferenceEdges(edges, text, filePath, nodeId, syntheticLine, allowedTargets)
    } else if (headingStack.length > 0) {
      addLocalReferenceEdges(edges, text, filePath, headingStack[headingStack.length - 1]!.id, syntheticLine, allowedTargets)
    } else {
      addLocalReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets)
    }

    syntheticLine += 1
  }

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

function extractPdfPaper(filePath: string): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
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
  let syntheticLine = 2
  for (const match of pdfText.matchAll(PDF_TEXT_OPERATOR_PATTERN)) {
    const endIndex = match[0].lastIndexOf(') Tj')
    const label = decodePdfLiteral(match[0].slice(1, endIndex))
    if (!label || !PDF_COMMON_SECTION_LABELS.has(normalizeLabel(label)) || sectionLabels.has(label)) {
      continue
    }

    sectionLabels.add(label)
    const sectionId = sectionNodeId(filePath, label, syntheticLine)
    addNode(nodes, seenIds, createNode(sectionId, label, filePath, syntheticLine, 'paper'))
    addEdge(edges, createEdge(fileNode.id, sectionId, 'contains', filePath, syntheticLine))
    syntheticLine += 1
  }

  return { nodes, edges }
}

function extractPaper(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.pdf') {
    return extractPdfPaper(filePath)
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

function isPythonClassNode(node: ExtractionNode): boolean {
  return extname(node.source_file).toLowerCase() === '.py' && node.file_type === 'code' && node.label !== basename(node.source_file) && !node.label.includes('(')
}

function resolveImportedPythonClassTarget(
  moduleSpecifier: string,
  importedName: string,
  classNodeIdsByModuleAndName: ReadonlyMap<string, string>,
): string | null {
  const moduleStem = moduleSpecifier.replace(/^\.+/, '').split('.').filter(Boolean).at(-1)
  if (!moduleStem) {
    return null
  }

  return classNodeIdsByModuleAndName.get(`${normalizeLabel(moduleStem)}:${normalizeLabel(importedName)}`) ?? null
}

function resolveCrossFilePythonImports(files: string[], combined: ExtractionData): void {
  const pythonFiles = files.filter((filePath) => extname(filePath).toLowerCase() === '.py')
  if (pythonFiles.length < 2) {
    return
  }

  const classNodeIdsByModuleAndName = new Map<string, string>()
  for (const node of combined.nodes) {
    if (!isPythonClassNode(node)) {
      continue
    }
    const moduleStem = basename(node.source_file, extname(node.source_file))
    classNodeIdsByModuleAndName.set(`${normalizeLabel(moduleStem)}:${normalizeLabel(node.label)}`, node.id)
  }

  const existingEdges = new Set(combined.edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))

  for (const filePath of pythonFiles) {
    const stem = basename(filePath, extname(filePath))
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    const classStack: Array<{ indent: number; id: string }> = []
    const importedSymbols: ImportedPythonSymbol[] = []

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const lineNumber = index + 1
      const trimmed = stripHashComment(line).trim()
      if (!trimmed) {
        continue
      }

      const indent = line.length - line.trimStart().length
      while (classStack.length > 0 && indent <= (classStack[classStack.length - 1]?.indent ?? -1)) {
        classStack.pop()
      }

      const importFromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/)
      if (importFromMatch?.[1] && importFromMatch[2]) {
        const moduleSpecifier = importFromMatch[1]
        const importedList = importFromMatch[2].replace(/[()]/g, '')
        for (const rawEntry of importedList.split(',')) {
          const entry = rawEntry.trim()
          if (!entry) {
            continue
          }
          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          if (!importedName) {
            continue
          }
          const targetId = resolveImportedPythonClassTarget(moduleSpecifier, importedName, classNodeIdsByModuleAndName)
          if (!targetId) {
            continue
          }
          importedSymbols.push({
            localName: aliasPart?.trim() || importedName,
            targetId,
          })
        }
        continue
      }

      const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?:/)
      if (classMatch?.[1]) {
        const classId = _makeId(stem, classMatch[1])
        classStack.push({ indent, id: classId })

        const baseList = classMatch[2]?.split(',').map((value) => value.trim()).filter(Boolean) ?? []
        for (const baseName of baseList) {
          const importedBase = importedSymbols.find((symbol) => symbol.localName === baseName)
          if (!importedBase) {
            continue
          }
          addUniqueEdge(
            combined.edges,
            existingEdges,
            createEdge(classId, importedBase.targetId, 'inherits', filePath, lineNumber, 'INFERRED'),
          )
        }
        continue
      }

      const currentClass = classStack[classStack.length - 1]
      if (!currentClass) {
        continue
      }

      for (const importedSymbol of importedSymbols) {
        const symbolPattern = new RegExp(`\\b${importedSymbol.localName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`)
        if (!symbolPattern.test(trimmed)) {
          continue
        }

        addUniqueEdge(
          combined.edges,
          existingEdges,
          createEdge(currentClass.id, importedSymbol.targetId, 'uses', filePath, lineNumber, 'INFERRED'),
        )
      }
    }
  }
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
    if (className) {
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, lineNumber))

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{') || /\bstruct\b/.test(trimmed)) {
        classStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: classId, name: className })
      }

      braceDepth = nextBraceDepth
      continue
    }

    let functionName: string | null = null
    let ownerClassId: string | undefined

    const goMethodMatch = trimmed.match(/^func\s*\([^)]*\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (goMethodMatch?.[1] && goMethodMatch[2]) {
      const ownerName = goMethodMatch[1]
      functionName = goMethodMatch[2]
      ownerClassId = ensureGenericOwnerNode(ownerName, stem, filePath, lineNumber, nodes, edges, seenIds)
    } else {
      const qualifiedMethod = qualifiedMethodDefinition(trimmed)
      const currentClass = classStack[classStack.length - 1]
      const constructorMatch = currentClass ? trimmed.match(new RegExp(`^(?:public|private|protected|internal|static|final|open|override|virtual|abstract|\\s)*${currentClass.name}\\s*\\(`)) : null
      if (qualifiedMethod) {
        functionName = qualifiedMethod.functionName
        ownerClassId = ensureGenericOwnerNode(qualifiedMethod.ownerName, stem, filePath, lineNumber, nodes, edges, seenIds)
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
      const functionId = ownerClassId ? _makeId(ownerClassId, functionName) : _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${ownerClassId ? '.' : ''}${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(ownerClassId ?? fileNodeId, functionId, ownerClassId ? 'method' : 'contains', filePath, lineNumber))
      if (ownerClassId) {
        methodIdsByClass.set(`${ownerClassId}:${functionName.toLowerCase()}`, functionId)
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{')) {
        functionStack.push({
          braceDepth: Math.max(nextBraceDepth, braceDepth + 1),
          id: functionId,
          ...(ownerClassId ? { classId: ownerClassId } : {}),
        })
      }

      const inlineBodyIndex = trimmed.indexOf('=>') >= 0 ? trimmed.indexOf('=>') + 2 : trimmed.indexOf('{') >= 0 ? trimmed.indexOf('{') + 1 : -1
      if (inlineBodyIndex >= 0) {
        addGenericCallsFromText(trimmed.slice(inlineBodyIndex), functionId, lineNumber, pendingCalls, ownerClassId, stem)
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

export function _makeId(...parts: string[]): string {
  const combined = parts
    .map((part) => part.replace(/^[_\.]+|[_\.]+$/g, ''))
    .filter(Boolean)
    .join('_')
  return combined
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function collectFiles(root: string, options: CollectFilesOptions = {}): string[] {
  const result = detect(root, options.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks })
  return result.files.code
}

export function extractPython(filePath: string): ExtractionFragment {
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

    const functionMatch = trimmed.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
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

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractRuby(filePath: string): ExtractionFragment {
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

    const requireMatch = trimmed.match(/^local\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*require\(["']([^"']+)["']\)/)
      ?? trimmed.match(/^require\(["']([^"']+)["']\)/)
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

    const functionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_!]*)\s*\(/)
      ?? trimmed.match(/^([A-Za-z_][A-Za-z0-9_!]*)\s*\([^=]*\)\s*=/)
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

    const importMatch = trimmed.match(/^Import-Module\s+([A-Za-z0-9_.-]+)/i)
      ?? trimmed.match(/^using\s+module\s+([A-Za-z0-9_.-]+)/i)
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

export function extractJs(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
  const stem = basename(filePath, extname(filePath))
  const fileNodeId = _makeId(stem)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const addTsCalls = (node: ts.Node, callerId: string, currentClassId?: string): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      if (ts.isIdentifier(expression)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName: expression.text,
          line: sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile)).line + 1,
        })
      } else if (ts.isPropertyAccessExpression(expression)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName: expression.name.text,
          line: sourceFile.getLineAndCharacterOfPosition(expression.name.getStart(sourceFile)).line + 1,
          preferredClassId: expression.expression.kind === ts.SyntaxKind.ThisKeyword ? currentClassId : undefined,
        })
      }
    }
    ts.forEachChild(node, (child) => addTsCalls(child, callerId, currentClassId))
  }

  const visitTopLevel = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addEdge(
        edges,
        createEdge(
          fileNodeId,
          _makeId(resolveModuleName(node.moduleSpecifier.text)),
          'imports_from',
          filePath,
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        ),
      )
      return
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text
      const classId = _makeId(stem, className)
      const classLine = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
      addNode(nodes, seenIds, createNode(classId, className, filePath, classLine))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, classLine))

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)) {
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
      }
      return
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue
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

function extractSingleFile(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const cached = readCachedExtraction(filePath)
  if (cached) {
    return cached
  }

  const extension = extname(filePath).toLowerCase()
  if (extension === '.py') {
    const extraction = extractPython(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.rb') {
    const extraction = extractRuby(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.lua') {
    const extraction = extractLua(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.toc') {
    const extraction = extractToc(filePath, allowedTargets)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.ex' || extension === '.exs') {
    const extraction = extractElixir(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.jl') {
    const extraction = extractJulia(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.ps1') {
    const extraction = extractPowerShell(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.m' || extension === '.mm') {
    const extraction = extractObjectiveC(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (extension === '.js' || extension === '.jsx' || extension === '.ts' || extension === '.tsx') {
    const extraction = extractJs(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (GENERIC_CODE_EXTENSIONS.has(extension)) {
    const extraction = extractGenericCode(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  const fileType = classifyFile(filePath)
  if (fileType === FileType.DOCUMENT) {
    const extraction = extractDocument(filePath, allowedTargets)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (fileType === FileType.PAPER) {
    const extraction = extractPaper(filePath, allowedTargets)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  if (fileType === FileType.IMAGE) {
    const extraction = extractImage(filePath)
    writeCachedExtraction(filePath, extraction)
    return extraction
  }

  return { nodes: [], edges: [] }
}

export function extract(files: string[]): ExtractionData {
  const combined: ExtractionData = {
    nodes: [],
    edges: [],
    input_tokens: 0,
    output_tokens: 0,
  }
  const allowedTargets = new Set(files.map((filePath) => resolve(filePath)))

  for (const filePath of files) {
    const extraction = extractSingleFile(filePath, allowedTargets)
    combined.nodes.push(...extraction.nodes)
    combined.edges.push(...extraction.edges)
  }

  resolveCrossFilePythonImports(files, combined)

  return combined
}
