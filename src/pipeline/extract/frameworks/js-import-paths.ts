import { existsSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

import * as ts from 'typescript'

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const relativePath = relative(workspaceRoot, filePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function resolveWithinWorkspace(candidate: string, workspaceRoot: string): string | null {
  return isWithinWorkspace(candidate, workspaceRoot) ? candidate : null
}

export function resolveImportPath(filePath: string, specifier: string, workspaceRoot = process.cwd()): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }

  const normalizedWorkspaceRoot = resolve(workspaceRoot)
  const resolvedSpecifier = resolve(dirname(filePath), specifier)
  const resolvedSpecifierExists = existsSync(resolvedSpecifier)
  if (resolvedSpecifierExists && statSync(resolvedSpecifier).isFile()) {
    return resolveWithinWorkspace(resolvedSpecifier, normalizedWorkspaceRoot)
  }

  const declaredExtension = extname(resolvedSpecifier)
  if (JS_EXTENSIONS.includes(declaredExtension)) {
    const specifierStem = resolvedSpecifier.slice(0, -declaredExtension.length)
    for (const extension of JS_EXTENSIONS) {
      const candidate = `${specifierStem}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return resolveWithinWorkspace(candidate, normalizedWorkspaceRoot)
      }
    }
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = `${resolvedSpecifier}${extension}`
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return resolveWithinWorkspace(candidate, normalizedWorkspaceRoot)
    }
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = resolve(resolvedSpecifier, `index${extension}`)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return resolveWithinWorkspace(candidate, normalizedWorkspaceRoot)
    }
  }

  if (resolvedSpecifierExists) {
    return null
  }

  return resolveWithinWorkspace(resolvedSpecifier, normalizedWorkspaceRoot)
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
