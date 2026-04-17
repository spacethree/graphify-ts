import type { Language } from 'web-tree-sitter'

import { loadTreeSitterWasmLanguages } from '../../src/pipeline/tree-sitter-wasm.js'

describe('tree-sitter-wasm', () => {
  it('keeps successfully loaded languages when one grammar fails', async () => {
    const loadedLanguages = new Map<string, Language>([
      ['tree-sitter-go.wasm', {} as Language],
      ['tree-sitter-java.wasm', {} as Language],
      ['tree-sitter-python.wasm', {} as Language],
      ['tree-sitter-ruby.wasm', {} as Language],
    ])

    const runtime = await loadTreeSitterWasmLanguages(async (fileName) => {
      if (fileName === 'tree-sitter-rust.wasm') {
        throw new Error('missing rust grammar')
      }

      const language = loadedLanguages.get(fileName)
      if (!language) {
        throw new Error(`unexpected grammar ${fileName}`)
      }
      return language
    })

    expect(runtime.languages.has('go')).toBe(true)
    expect(runtime.languages.has('java')).toBe(true)
    expect(runtime.languages.has('python')).toBe(true)
    expect(runtime.languages.has('ruby')).toBe(true)
    expect(runtime.languages.has('rust')).toBe(false)
    expect(runtime.error).toContain('rust')
  })
})
