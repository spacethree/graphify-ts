import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const STALE_PHRASES = ['384x', '397x', '897x', '384×', '397×', '897×']

function readDoc(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8')
}

describe('public marketing copy honesty', () => {
  describe('examples/why-graphify.md', () => {
    const content = readDoc('examples/why-graphify.md')
    const lower = content.toLowerCase()

    for (const stale of STALE_PHRASES) {
      it(`does not contain the stale "${stale}" claim`, () => {
        expect(lower).not.toContain(stale.toLowerCase())
      })
    }

    it('cites the measured benchmark headline numbers', () => {
      expect(content).toMatch(/3x fewer turns|3× fewer turns/i)
      expect(content).toMatch(/2\.8x|2\.8×/i)
      expect(content).toMatch(/2\.6x|2\.6×/i)
    })

    it('discloses the cold-start cost premium honestly', () => {
      expect(lower).toMatch(/cold[- ]start|cost parity|amortize/i)
    })
  })

  describe('README.md', () => {
    const content = readDoc('README.md')
    const lower = content.toLowerCase()

    for (const stale of STALE_PHRASES) {
      it(`does not contain the stale "${stale}" claim`, () => {
        expect(lower).not.toContain(stale.toLowerCase())
      })
    }

    it('replaces the stale "Generation time" headline with measured session latency', () => {
      expect(content).toMatch(/35s.*96s|35 ?s.*96 ?s|session latency/i)
    })
  })
})
