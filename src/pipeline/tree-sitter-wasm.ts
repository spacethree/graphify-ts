import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { Language, Parser } from 'web-tree-sitter'

export type TreeSitterNode = import('web-tree-sitter').Node

export type SupportedTreeSitterLanguage = 'go' | 'java'

interface TreeSitterRuntimeState {
  languages: Map<SupportedTreeSitterLanguage, Language>
  error: string | null
}

const require = createRequire(import.meta.url)
const parserWasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm')
const grammarDirectory = dirname(require.resolve('@vscode/tree-sitter-wasm'))

async function loadLanguage(fileName: string): Promise<Language> {
  return Language.load(join(grammarDirectory, fileName))
}

async function initializeRuntime(): Promise<TreeSitterRuntimeState> {
  try {
    await Parser.init({
      locateFile() {
        return parserWasmPath
      },
    })

    const languages = new Map<SupportedTreeSitterLanguage, Language>()
    languages.set('go', await loadLanguage('tree-sitter-go.wasm'))
    languages.set('java', await loadLanguage('tree-sitter-java.wasm'))

    return {
      languages,
      error: null,
    }
  } catch (error) {
    return {
      languages: new Map<SupportedTreeSitterLanguage, Language>(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
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
