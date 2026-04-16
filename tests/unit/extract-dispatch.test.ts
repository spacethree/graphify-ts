import { createCapabilityRegistry, type CapabilityDefinition } from '../../src/infrastructure/capabilities.js'
import { dispatchSingleFileExtraction, type ExtractionFragment } from '../../src/pipeline/extract/dispatch.js'

function makeExtraction(label: string): ExtractionFragment {
  return {
    nodes: [
      {
        id: `${label}-node`,
        label,
        file_type: 'code',
        source_file: `/tmp/${label}.py`,
      },
    ],
    edges: [],
  }
}

describe('dispatchSingleFileExtraction', () => {
  it('dispatches through the registry-selected handler and writes the result to cache', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const registry = createCapabilityRegistry([capability])
    const extraction = makeExtraction('python-result')
    const writes: ExtractionFragment[] = []

    const result = dispatchSingleFileExtraction(
      '/tmp/example.py',
      new Set(['/tmp/example.py']),
      {
        'custom:extract:python': () => extraction,
      },
      {
        registry,
        readCached: () => null,
        writeCached: (_filePath, cachedExtraction) => {
          writes.push(cachedExtraction)
        },
      },
    )

    expect(result).toEqual(extraction)
    expect(writes).toEqual([extraction])
  })

  it('returns the cached extraction before resolving a handler', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const registry = createCapabilityRegistry([capability])
    const cached = makeExtraction('cached-result')

    const result = dispatchSingleFileExtraction(
      '/tmp/example.py',
      new Set(['/tmp/example.py']),
      {
        'custom:extract:python': () => {
          throw new Error('handler should not run when cache is warm')
        },
      },
      {
        registry,
        readCached: () => cached,
        writeCached: () => {
          throw new Error('cache write should not run for cached results')
        },
      },
    )

    expect(result).toEqual(cached)
  })

  it('returns an empty fragment when no registered capability matches the file', () => {
    const result = dispatchSingleFileExtraction('/tmp/example.unknown', new Set(), {}, { registry: createCapabilityRegistry() })

    expect(result).toEqual({ nodes: [], edges: [] })
  })

  it('uses source classification to disambiguate handlers that share an extension', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:extract:markdown-document',
        kind: 'extract',
        fileType: 'document',
        extensions: ['.md'],
      },
      {
        id: 'custom:extract:markdown-paper',
        kind: 'extract',
        fileType: 'paper',
        extensions: ['.md'],
      },
    ])
    const paperExtraction = makeExtraction('paper-result')

    const result = dispatchSingleFileExtraction(
      '/tmp/paper.md',
      new Set(['/tmp/paper.md']),
      {
        'custom:extract:markdown-document': () => makeExtraction('document-result'),
        'custom:extract:markdown-paper': () => paperExtraction,
      },
      {
        registry,
        readCached: () => null,
        classifySourceFile: () => 'paper',
      },
    )

    expect(result).toEqual(paperExtraction)
  })

  it('throws when a capability resolves but no handler is registered for it', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const registry = createCapabilityRegistry([capability])

    expect(() => dispatchSingleFileExtraction('/tmp/example.py', new Set(), {}, { registry })).toThrow(/No extractor handler registered/i)
  })
})
