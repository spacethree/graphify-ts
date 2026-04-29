import { existsSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

import * as ts from 'typescript'

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']

export function resolveImportPath(filePath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }

  const resolvedSpecifier = resolve(dirname(filePath), specifier)
  const resolvedSpecifierExists = existsSync(resolvedSpecifier)
  if (resolvedSpecifierExists && statSync(resolvedSpecifier).isFile()) {
    return resolvedSpecifier
  }

  const declaredExtension = extname(resolvedSpecifier)
  if (JS_EXTENSIONS.includes(declaredExtension)) {
    const specifierStem = resolvedSpecifier.slice(0, -declaredExtension.length)
    for (const extension of JS_EXTENSIONS) {
      const candidate = `${specifierStem}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate
      }
    }
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = `${resolvedSpecifier}${extension}`
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = resolve(resolvedSpecifier, `index${extension}`)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }

  if (resolvedSpecifierExists) {
    return null
  }

  return resolvedSpecifier
}

export function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.cjs') || filePath.endsWith('.mjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}
