export interface SourceLineRange {
  start: number
  end: number
}

export function lineRangeFromSourceLocation(location: unknown): SourceLineRange | null {
  if (typeof location !== 'string') {
    return null
  }

  const match = location.match(/^L(\d+)(?:-L?(\d+))?$/)
  if (!match?.[1]) {
    return null
  }

  const start = Number.parseInt(match[1], 10)
  const end = Number.parseInt(match[2] ?? match[1], 10)
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) {
    return null
  }

  const normalizedStart = Math.min(start, end)
  const normalizedEnd = Math.max(start, end)

  return {
    start: normalizedStart,
    end: normalizedEnd,
  }
}

export function lineNumberFromSourceLocation(location: unknown): number {
  return lineRangeFromSourceLocation(location)?.start ?? 1
}
