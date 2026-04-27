import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PackageManifest {
  devDependencies?: Record<string, string>
}

function loadPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest
}

function normalizeVersionRange(range: string | undefined): string {
  return (range ?? '').replace(/^[\^~]/, '')
}

describe('package metadata', () => {
  it('keeps vitest coverage tooling aligned with vitest', () => {
    const devDependencies = loadPackageManifest().devDependencies ?? {}

    expect(normalizeVersionRange(devDependencies['@vitest/coverage-v8'])).toBe(
      normalizeVersionRange(devDependencies.vitest),
    )
  })
})
