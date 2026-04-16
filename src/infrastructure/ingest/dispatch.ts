import { builtinCapabilityRegistry, type CapabilityRegistry } from '../capabilities.js'
import type { IngestOptions, UrlType } from './types.js'

export interface IngestTextAsset {
  fileName: string
  content: string
}

export type IngestDispatchResult =
  | {
      kind: 'text'
      asset: IngestTextAsset
    }
  | {
      kind: 'binary'
      suffix: string
      bytes?: Uint8Array
      sourceUrl?: string
    }

export type IngestHandler = (url: string, options: IngestOptions) => Promise<IngestDispatchResult>

export type IngestHandlerMap = Readonly<Record<string, IngestHandler>>

export interface IngestDispatchDependencies {
  registry?: CapabilityRegistry
}

export async function dispatchIngest(
  urlType: UrlType,
  url: string,
  options: IngestOptions,
  handlers: IngestHandlerMap,
  dependencies: IngestDispatchDependencies = {},
): Promise<IngestDispatchResult> {
  const registry = dependencies.registry ?? builtinCapabilityRegistry
  const directCapability = registry.resolveIngestorForUrlType(urlType)
  const capability = directCapability ?? registry.resolveIngestorForUrlType('webpage')
  if (!capability) {
    throw new Error(`No ingest capability registered for url type '${urlType}' and fallback 'webpage' is also missing`)
  }

  const handler = handlers[capability.id]
  if (!handler) {
    throw new Error(`No ingest handler registered for capability '${capability.id}'`)
  }

  return handler(url, options)
}
