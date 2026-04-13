import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

import type { ExtractionData, ExtractionNode } from '../../contracts/types.js'
import { _makeId, addUniqueEdge, createEdge, normalizeLabel, stripHashComment } from './core.js'

export interface ResolveCrossFilePythonImportsOptions {
  contextNodes?: readonly ExtractionNode[]
}

interface ImportedPythonSymbol {
  localName: string
  targetId: string
}

function isPythonClassNode(node: ExtractionNode): boolean {
  return extname(node.source_file).toLowerCase() === '.py' && node.file_type === 'code' && node.label !== basename(node.source_file) && !node.label.includes('(')
}

function resolveImportedPythonClassTarget(moduleSpecifier: string, importedName: string, classNodeIdsByModuleAndName: ReadonlyMap<string, string>): string | null {
  const moduleStem = moduleSpecifier.replace(/^\.+/, '').split('.').filter(Boolean).at(-1)
  if (!moduleStem) {
    return null
  }

  return classNodeIdsByModuleAndName.get(`${normalizeLabel(moduleStem)}:${normalizeLabel(importedName)}`) ?? null
}

export function resolveCrossFilePythonImports(files: readonly string[], extraction: ExtractionData, options: ResolveCrossFilePythonImportsOptions = {}): ExtractionData {
  const pythonFiles = files.filter((filePath) => extname(filePath).toLowerCase() === '.py')
  if (pythonFiles.length < 2) {
    return extraction
  }

  const searchableNodes = options.contextNodes && options.contextNodes.length > 0 ? [...extraction.nodes, ...options.contextNodes] : extraction.nodes
  const classNodeIdsByModuleAndName = new Map<string, string>()
  for (const node of searchableNodes) {
    if (!isPythonClassNode(node)) {
      continue
    }

    const moduleStem = basename(node.source_file, extname(node.source_file))
    classNodeIdsByModuleAndName.set(`${normalizeLabel(moduleStem)}:${normalizeLabel(node.label)}`, node.id)
  }

  const edges = [...extraction.edges]
  const existingEdges = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))

  for (const filePath of pythonFiles) {
    const stem = basename(filePath, extname(filePath))
    let lines: string[]
    try {
      lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    } catch {
      if (process.env.DEBUG) {
        console.warn(`[graphify extract] Skipping unreadable Python file during cross-file linking: ${filePath}`)
      }
      continue
    }

    const classStack: Array<{ indent: number; id: string }> = []
    const importedSymbols: ImportedPythonSymbol[] = []

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const lineNumber = index + 1
      const trimmed = stripHashComment(line).trim()
      if (!trimmed) {
        continue
      }

      const indent = line.length - line.trimStart().length
      while (classStack.length > 0 && indent <= (classStack[classStack.length - 1]?.indent ?? -1)) {
        classStack.pop()
      }

      const importFromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/)
      if (importFromMatch?.[1] && importFromMatch[2]) {
        const moduleSpecifier = importFromMatch[1]
        const importedList = importFromMatch[2].replace(/[()]/g, '')
        for (const rawEntry of importedList.split(',')) {
          const entry = rawEntry.trim()
          if (!entry) {
            continue
          }

          const [importedNamePart, aliasPart] = entry.split(/\s+as\s+/)
          const importedName = importedNamePart?.trim()
          if (!importedName) {
            continue
          }

          const targetId = resolveImportedPythonClassTarget(moduleSpecifier, importedName, classNodeIdsByModuleAndName)
          if (!targetId) {
            continue
          }

          importedSymbols.push({
            localName: aliasPart?.trim() || importedName,
            targetId,
          })
        }
        continue
      }

      const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?:/)
      if (classMatch?.[1]) {
        const classId = _makeId(stem, classMatch[1])
        classStack.push({ indent, id: classId })

        const baseList =
          classMatch[2]
            ?.split(',')
            .map((value) => value.trim())
            .filter(Boolean) ?? []
        for (const baseName of baseList) {
          const importedBase = importedSymbols.find((symbol) => symbol.localName === baseName)
          if (!importedBase) {
            continue
          }

          addUniqueEdge(edges, existingEdges, createEdge(classId, importedBase.targetId, 'inherits', filePath, lineNumber, 'INFERRED'))
        }
        continue
      }

      const currentClass = classStack[classStack.length - 1]
      if (!currentClass) {
        continue
      }

      for (const importedSymbol of importedSymbols) {
        const symbolPattern = new RegExp(`\\b${importedSymbol.localName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`)
        if (!symbolPattern.test(trimmed)) {
          continue
        }

        addUniqueEdge(edges, existingEdges, createEdge(currentClass.id, importedSymbol.targetId, 'uses', filePath, lineNumber, 'INFERRED'))
      }
    }
  }

  return {
    ...extraction,
    nodes: [...extraction.nodes],
    edges,
  }
}
