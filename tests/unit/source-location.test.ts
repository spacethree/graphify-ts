import { describe, expect, it } from 'vitest'

import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'

describe('source location', () => {
  it('normalizes reversed line ranges', () => {
    expect(lineRangeFromSourceLocation('L14-L10')).toEqual({
      start: 10,
      end: 14,
    })
  })
})
