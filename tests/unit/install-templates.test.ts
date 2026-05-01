import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeInstall } from '../../src/infrastructure/install.js'

const STALE_PHRASES = ['384x', '397x', '897x', '384×', '397×', '897×']

function withTempDir(callback: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'graphify-ts-template-'))
  try {
    callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function decodeHookPayload(settingsJson: string): string {
  const parsed = JSON.parse(settingsJson) as {
    hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> }
  }
  const command = parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? ''
  // Hook command embeds the payload as a base64 literal inside a node -e wrapper.
  // Extract every base64-looking chunk and decode each, concatenating the results
  // so we capture both the match and miss payloads when present.
  const base64Matches = [...command.matchAll(/'([A-Za-z0-9+/=]{40,})'/g)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === 'string')
  if (base64Matches.length === 0) {
    return ''
  }
  return base64Matches.map((b64) => Buffer.from(b64, 'base64').toString('utf8')).join('\n')
}

describe('install hook payload', () => {
  it('decoded hook payload contains the measured "3x fewer turns" claim', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(settings)
      expect(decoded.toLowerCase()).toContain('3x fewer turns')
    })
  })

  it('decoded hook payload does NOT contain stale 384x/397x/897x claims', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(settings)
      const decodedLower = decoded.toLowerCase()
      for (const stale of STALE_PHRASES) {
        expect(decodedLower).not.toContain(stale.toLowerCase())
      }
    })
  })

  it('decoded hook payload still mentions the retrieve MCP tool', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const settings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')
      const decoded = decodeHookPayload(settings)
      expect(decoded).toContain('retrieve')
    })
  })
})
