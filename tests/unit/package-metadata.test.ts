import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PackageManifest {
  devDependencies?: Record<string, string>
  license?: string
}

function loadPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest
}

function loadDependabotConfig(): string {
  return readFileSync(join(process.cwd(), '.github', 'dependabot.yml'), 'utf8')
}

function loadCiWorkflow(): string {
  return readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8')
}

function loadReadme(): string {
  return readFileSync(join(process.cwd(), 'README.md'), 'utf8')
}

function loadContributingGuide(): string {
  return readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8')
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

  it('keeps the declared project license aligned with MIT', () => {
    expect(loadPackageManifest().license).toBe('MIT')
    expect(loadReadme()).toContain('[![license MIT]')
    expect(loadReadme()).toContain('licensed under **MIT**')
    expect(loadContributingGuide()).toContain("licensed under this project's MIT license")
  })

  it('keeps the eval regression workflow aligned with runner-backed eval requirements', () => {
    const ciWorkflow = loadCiWorkflow()

    expect(ciWorkflow).toContain('Enforce eval regression thresholds')
    expect(ciWorkflow).toContain('ci-prompt-runner.mjs')
    expect(ciWorkflow).toContain('--exec')
    expect(ciWorkflow).toContain('--yes')
  })
})
