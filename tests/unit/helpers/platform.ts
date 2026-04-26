export function normalizeAssertionPath(path: string): string {
  return path.replaceAll('\\', '/')
}

export function normalizeAssertionPaths(paths: readonly string[]): string[] {
  return paths.map(normalizeAssertionPath)
}

export function shouldAssertExecutableBits(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}
