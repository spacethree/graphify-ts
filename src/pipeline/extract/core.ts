import { basename, extname } from 'node:path'

import type { ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { DEFAULT_EXTRACTION_LAYER } from '../../core/layers/types.js'
import { createBaselineProvenance } from '../../core/provenance/types.js'
import { builtinCapabilityRegistry } from '../../infrastructure/capabilities.js'
import { sanitizeLabel } from '../../shared/security.js'
import { classifyFile, FileType, type FileTypeValue } from '../detect.js'

const EXTRACTION_STAGE = 'extract'
const CAPABILITY_CACHE = new Map<string, string | null>()

function sourceFileTypeForNode(fileType: ExtractionNode['file_type']): FileTypeValue | null {
  switch (fileType) {
    case FileType.CODE:
    case FileType.DOCUMENT:
    case FileType.PAPER:
    case FileType.IMAGE:
      return fileType
    default:
      return null
  }
}

function extractCapabilityId(sourceFile: string, fileType?: FileTypeValue | null): string | null {
  const cacheKey = `${sourceFile}\u0000${fileType ?? ''}`
  if (CAPABILITY_CACHE.has(cacheKey)) {
    return CAPABILITY_CACHE.get(cacheKey) ?? null
  }

  const detectedFileType = fileType ?? classifyFile(sourceFile)
  const capabilityId = builtinCapabilityRegistry.resolveExtractorForPath(sourceFile, detectedFileType)?.id ?? null
  CAPABILITY_CACHE.set(cacheKey, capabilityId)
  return capabilityId
}

function createExtractionProvenance(sourceFile: string, line: number, fileType?: ExtractionNode['file_type']): NonNullable<ExtractionNode['provenance']> | null {
  const sourceFileType = fileType ? sourceFileTypeForNode(fileType) : null
  const capabilityId = extractCapabilityId(sourceFile, sourceFileType)

  if (!capabilityId) {
    return null
  }

  return [
    createBaselineProvenance({
      capabilityId,
      stage: EXTRACTION_STAGE,
      sourceFile,
      sourceLocation: toLocation(line),
    }),
  ]
}

function createEdgeProvenance(sourceFile: string, line: number): NonNullable<ExtractionEdge['provenance']> | null {
  const capabilityId = extractCapabilityId(sourceFile)

  if (!capabilityId) {
    return null
  }

  return [
    createBaselineProvenance({
      capabilityId,
      stage: EXTRACTION_STAGE,
      sourceFile,
      sourceLocation: toLocation(line),
    }),
  ]
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

export function toLocation(line: number): string {
  return `L${line}`
}

export function normalizeLabel(label: string): string {
  return label.replaceAll('(', '').replaceAll(')', '').replace(/^\./, '').toLowerCase()
}

export function stripHashComment(line: string): string {
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

    if (character === "'" && !inDoubleQuote) {
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

export function createNode(id: string, label: string, sourceFile: string, line: number, fileType: ExtractionNode['file_type'] = 'code'): ExtractionNode {
  const provenance = createExtractionProvenance(sourceFile, line, fileType)

  return {
    id,
    label: sanitizeLabel(label),
    file_type: fileType,
    source_file: sourceFile,
    source_location: toLocation(line),
    layer: DEFAULT_EXTRACTION_LAYER,
    ...(provenance ? { provenance } : {}),
  }
}

export function createFileNode(filePath: string, fileType: ExtractionNode['file_type']): ExtractionNode {
  return createNode(_makeId(basename(filePath, extname(filePath))), basename(filePath), filePath, 1, fileType)
}

export function createEdge(
  source: string,
  target: string,
  relation: string,
  sourceFile: string,
  line: number,
  confidence: ExtractionEdge['confidence'] = 'EXTRACTED',
  weight = 1.0,
): ExtractionEdge {
  const provenance = createEdgeProvenance(sourceFile, line)

  return {
    source,
    target,
    relation,
    confidence,
    source_file: sourceFile,
    source_location: toLocation(line),
    layer: DEFAULT_EXTRACTION_LAYER,
    ...(provenance ? { provenance } : {}),
    weight,
  }
}

export function indentationLevel(line: string): number {
  return line.length - line.trimStart().length
}

export function addNode(nodes: ExtractionNode[], seenIds: Set<string>, node: ExtractionNode): void {
  if (!seenIds.has(node.id)) {
    seenIds.add(node.id)
    nodes.push(node)
  }
}

export function addEdge(edges: ExtractionEdge[], edge: ExtractionEdge): void {
  edges.push(edge)
}

export function addUniqueEdge(edges: ExtractionEdge[], seen: Set<string>, edge: ExtractionEdge): void {
  const key = `${edge.source}|${edge.target}|${edge.relation}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  edges.push(edge)
}
