import { basename, extname } from 'node:path'

import type { ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { sanitizeLabel } from '../../shared/security.js'

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
  return {
    id,
    label: sanitizeLabel(label),
    file_type: fileType,
    source_file: sourceFile,
    source_location: toLocation(line),
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
