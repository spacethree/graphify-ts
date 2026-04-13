import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { isRecord } from './guards.js'

export interface BinaryIngestSidecarMetadata {
  source_url: string
  captured_at: string
  contributor: string
}

export const BINARY_INGEST_SIDECAR_SUFFIX = '.graphify-ingest.json'

export function binaryIngestSidecarPath(assetPath: string): string {
  return join(dirname(assetPath), `.${basename(assetPath)}${BINARY_INGEST_SIDECAR_SUFFIX}`)
}

export function writeBinaryIngestSidecar(assetPath: string, metadata: BinaryIngestSidecarMetadata): string {
  const sidecarPath = binaryIngestSidecarPath(assetPath)
  writeFileSync(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  return sidecarPath
}

export function readBinaryIngestSidecar(assetPath: string): Partial<BinaryIngestSidecarMetadata> | null {
  const sidecarPath = binaryIngestSidecarPath(assetPath)
  if (!existsSync(sidecarPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown
    if (!isRecord(parsed)) {
      return null
    }

    const metadata: Partial<BinaryIngestSidecarMetadata> = {}
    if (typeof parsed.source_url === 'string') {
      metadata.source_url = parsed.source_url
    }
    if (typeof parsed.captured_at === 'string') {
      metadata.captured_at = parsed.captured_at
    }
    if (typeof parsed.contributor === 'string') {
      metadata.contributor = parsed.contributor
    }

    return Object.keys(metadata).length > 0 ? metadata : null
  } catch {
    return null
  }
}
