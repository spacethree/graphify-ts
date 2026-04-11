import { isRecord } from '../shared/guards.js'
import type { Confidence, ExtractionData, FileType } from './types.js'

const VALID_FILE_TYPES = new Set<FileType>(['code', 'document', 'paper', 'image', 'rationale'])
const VALID_CONFIDENCES = new Set<Confidence>(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
const REQUIRED_NODE_FIELDS = ['id', 'label', 'file_type', 'source_file'] as const
const REQUIRED_EDGE_FIELDS = ['source', 'target', 'relation', 'confidence', 'source_file'] as const

export function validateExtraction(data: unknown): string[] {
  if (!isRecord(data)) {
    return ['Extraction must be a JSON object']
  }

  const errors: string[] = []

  const nodesValue = data.nodes
  if (nodesValue === undefined) {
    errors.push("Missing required key 'nodes'")
  } else if (!Array.isArray(nodesValue)) {
    errors.push("'nodes' must be a list")
  } else {
    for (const [index, node] of nodesValue.entries()) {
      if (!isRecord(node)) {
        errors.push(`Node ${index} must be an object`)
        continue
      }

      for (const field of REQUIRED_NODE_FIELDS) {
        if (!(field in node)) {
          errors.push(`Node ${index} (id=${JSON.stringify(node.id ?? '?')}) missing required field '${field}'`)
        }
      }

      if ('file_type' in node && typeof node.file_type === 'string' && !VALID_FILE_TYPES.has(node.file_type as FileType)) {
        errors.push(
          `Node ${index} (id=${JSON.stringify(node.id ?? '?')}) has invalid file_type '${String(node.file_type)}' - must be one of ${JSON.stringify([...VALID_FILE_TYPES].sort())}`,
        )
      }
    }
  }

  const edgesValue = data.edges
  if (edgesValue === undefined) {
    errors.push("Missing required key 'edges'")
  } else if (!Array.isArray(edgesValue)) {
    errors.push("'edges' must be a list")
  } else {
    const nodeIds = new Set(
      Array.isArray(nodesValue)
        ? nodesValue
            .filter(isRecord)
            .map((node) => node.id)
            .filter((id): id is string => typeof id === 'string')
        : [],
    )

    for (const [index, edge] of edgesValue.entries()) {
      if (!isRecord(edge)) {
        errors.push(`Edge ${index} must be an object`)
        continue
      }

      for (const field of REQUIRED_EDGE_FIELDS) {
        if (!(field in edge)) {
          errors.push(`Edge ${index} missing required field '${field}'`)
        }
      }

      if ('confidence' in edge && typeof edge.confidence === 'string' && !VALID_CONFIDENCES.has(edge.confidence as Confidence)) {
        errors.push(`Edge ${index} has invalid confidence '${String(edge.confidence)}' - must be one of ${JSON.stringify([...VALID_CONFIDENCES].sort())}`)
      }

      if (typeof edge.source === 'string' && nodeIds.size > 0 && !nodeIds.has(edge.source)) {
        errors.push(`Edge ${index} source '${edge.source}' does not match any node id`)
      }

      if (typeof edge.target === 'string' && nodeIds.size > 0 && !nodeIds.has(edge.target)) {
        errors.push(`Edge ${index} target '${edge.target}' does not match any node id`)
      }
    }
  }

  return errors
}

export function assertValid(data: unknown): asserts data is ExtractionData {
  const errors = validateExtraction(data)
  if (errors.length > 0) {
    const message = `Extraction JSON has ${errors.length} error(s):\n${errors.map((error) => `  • ${error}`).join('\n')}`
    throw new Error(message)
  }
}
