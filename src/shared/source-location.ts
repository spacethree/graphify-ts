export function lineNumberFromSourceLocation(location: unknown): number {
  if (typeof location !== 'string') {
    return 1
  }

  const match = location.match(/^L(\d+)$/)
  if (!match?.[1]) {
    return 1
  }

  const line = Number.parseInt(match[1], 10)
  return Number.isFinite(line) && line > 0 ? line : 1
}
