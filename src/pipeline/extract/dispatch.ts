import type { ExtractionEdge, ExtractionNode } from '../../contracts/types.js'
import { builtinCapabilityRegistry, type CapabilityRegistry } from '../../infrastructure/capabilities.js'
import { classifyFile, type FileTypeValue } from '../detect.js'

export interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
}

export type ExtractorHandler = (filePath: string, allowedTargets: ReadonlySet<string>) => ExtractionFragment

export type ExtractorHandlerMap = Readonly<Record<string, ExtractorHandler>>

export interface SingleFileExtractionDependencies {
  registry?: CapabilityRegistry
  readCached?: (filePath: string) => ExtractionFragment | null | undefined
  writeCached?: (filePath: string, extraction: ExtractionFragment) => void
  classifySourceFile?: (filePath: string) => FileTypeValue | null
}

function emptyExtractionFragment(): ExtractionFragment {
  return { nodes: [], edges: [] }
}

export function dispatchSingleFileExtraction(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  handlers: ExtractorHandlerMap,
  dependencies: SingleFileExtractionDependencies = {},
): ExtractionFragment {
  const cached = dependencies.readCached?.(filePath) ?? null
  if (cached) {
    return cached
  }

  const registry = dependencies.registry ?? builtinCapabilityRegistry
  const sourceFileType = dependencies.classifySourceFile?.(filePath) ?? classifyFile(filePath)
  const capability = registry.resolveExtractorForPath(filePath, sourceFileType)
  if (!capability) {
    return emptyExtractionFragment()
  }

  const handler = handlers[capability.id]
  if (!handler) {
    throw new Error(`No extractor handler registered for capability '${capability.id}'`)
  }

  const extraction = handler(filePath, allowedTargets)
  dependencies.writeCached?.(filePath, extraction)
  return extraction
}
