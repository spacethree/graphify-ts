import { createBuiltinCapabilityRegistry, createCapabilityRegistry, type CapabilityDefinition } from '../../src/infrastructure/capabilities.js'

describe('builtin capability registry', () => {
  it('resolves python files to the python extractor capability', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.resolveExtractorForPath('src/auth.py')?.id).toBe('builtin:extract:python')
  })

  it('resolves typescript files to the typescript extractor capability', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.resolveExtractorForPath('src/auth.ts')?.id).toBe('builtin:extract:typescript')
  })

  it('resolves tweet url types to the tweet ingest capability', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.resolveIngestorForUrlType('tweet')?.id).toBe('builtin:ingest:tweet')
  })

  it('resolves hackernews url types to the hackernews ingest capability', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.resolveIngestorForUrlType('hackernews')?.id).toBe('builtin:ingest:hackernews')
  })

  it('resolves direct media url types to binary ingest capabilities', () => {
    const registry = createBuiltinCapabilityRegistry()

    expect(registry.resolveIngestorForUrlType('audio')?.id).toBe('builtin:ingest:audio')
    expect(registry.resolveIngestorForUrlType('video')?.id).toBe('builtin:ingest:video')
  })

  it('rejects duplicate capability registration', () => {
    const registry = createCapabilityRegistry()
    const capability: CapabilityDefinition = {
      id: 'builtin:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }

    registry.register(capability)

    expect(() => registry.register(capability)).toThrow(/already registered|duplicate/i)
  })

  it('normalizes extensions during registration and lookup', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:extract:yaml',
        kind: 'extract',
        fileType: 'document',
        extensions: ['yaml'],
      },
    ])

    expect(registry.resolveExtractorForPath('notes.yaml')?.id).toBe('custom:extract:yaml')
    expect(registry.resolveExtractorForPath('.yaml')?.id).toBe('custom:extract:yaml')
  })

  it('rejects duplicate extension claims across capabilities', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'builtin:extract:python',
        kind: 'extract',
        fileType: 'code',
        extensions: ['.py'],
      },
    ])

    expect(() =>
      registry.register({
        id: 'custom:extract:alt-python',
        kind: 'extract',
        fileType: 'code',
        extensions: ['py'],
      }),
    ).toThrow(/already registered/i)
  })

  it('rejects duplicate ingest url-type claims across capabilities', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'builtin:ingest:tweet',
        kind: 'ingest',
        urlType: 'tweet',
      },
    ])

    expect(() =>
      registry.register({
        id: 'custom:ingest:tweet-copy',
        kind: 'ingest',
        urlType: 'tweet',
      }),
    ).toThrow(/already registered/i)
  })
})
