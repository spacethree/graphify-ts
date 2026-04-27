import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PackageManifest {
  devDependencies?: Record<string, string>
}

function loadPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest
}

function loadDependabotConfig(): string {
  return readFileSync(join(process.cwd(), '.github', 'dependabot.yml'), 'utf8')
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

  it('groups vitest tooling updates together in dependabot', () => {
    const dependabotConfig = loadDependabotConfig()

    expect(dependabotConfig).toContain('groups:')
    expect(dependabotConfig).toContain('test-tooling:')
    expect(dependabotConfig).toContain('patterns:')
    expect(dependabotConfig).toContain('- vitest')
    expect(dependabotConfig).toContain('- "@vitest/coverage-v8"')
  })
})
