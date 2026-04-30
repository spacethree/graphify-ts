import { isAbsolute, relative, sep } from 'node:path'

export function relativizeSourceFile(sourceFile: string, rootPath?: string): string {
  if (sourceFile.length === 0 || !rootPath || rootPath.length === 0 || !isAbsolute(sourceFile)) {
    return sourceFile
  }

  const relativePath = relative(rootPath, sourceFile)
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return sourceFile
  }

  return relativePath.replaceAll(sep, '/')
}
