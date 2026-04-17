import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { Language, Parser } from 'web-tree-sitter'

export type TreeSitterNode = import('web-tree-sitter').Node

export type SupportedTreeSitterLanguage = 'go' | 'java' | 'python' | 'ruby' | 'rust'

interface TreeSitterRuntimeState {
  languages: Map<SupportedTreeSitterLanguage, Language>
  error: string | null
}

const TREE_SITTER_WASM_LANGUAGE_FILES: ReadonlyArray<readonly [SupportedTreeSitterLanguage, string]> = [
  ['go', 'tree-sitter-go.wasm'],
  ['java', 'tree-sitter-java.wasm'],
  ['python', 'tree-sitter-python.wasm'],
  ['ruby', 'tree-sitter-ruby.wasm'],
  ['rust', 'tree-sitter-rust.wasm'],
]

const require = createRequire(import.meta.url)
const parserWasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm')
const grammarDirectory = dirname(require.resolve('@vscode/tree-sitter-wasm'))

async function loadLanguage(fileName: string): Promise<Language> {
  return Language.load(join(grammarDirectory, fileName))
}

export async function loadTreeSitterWasmLanguages(
  loadLanguageFile: (fileName: string) => Promise<Language> = loadLanguage,
): Promise<TreeSitterRuntimeState> {
  const languages = new Map<SupportedTreeSitterLanguage, Language>()
  const errors: string[] = []

  for (const [languageName, fileName] of TREE_SITTER_WASM_LANGUAGE_FILES) {
    try {
      languages.set(languageName, await loadLanguageFile(fileName))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${languageName}: ${message}`)
    }
  }

  return {
    languages,
    error: errors.length > 0 ? errors.join('; ') : null,
  }
}

async function initializeRuntime(): Promise<TreeSitterRuntimeState> {
  try {
    await Parser.init({
      locateFile() {
        return parserWasmPath
      },
    })
  } catch (error) {
    return {
      languages: new Map<SupportedTreeSitterLanguage, Language>(),
      error: error instanceof Error ? error.message : String(error),
    }
  }

  return loadTreeSitterWasmLanguages()
}

const runtimeState = await initializeRuntime()

export function createTreeSitterWasmParser(languageName: SupportedTreeSitterLanguage): Parser | null {
  const language = runtimeState.languages.get(languageName)
  if (!language) {
    return null
  }

  const parser = new Parser()
  parser.setLanguage(language)
  return parser
}

export function hasTreeSitterWasmLanguage(languageName: SupportedTreeSitterLanguage): boolean {
  return runtimeState.languages.has(languageName)
}

export function treeSitterWasmError(): string | null {
  return runtimeState.error
}
