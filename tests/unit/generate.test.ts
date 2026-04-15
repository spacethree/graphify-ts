import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { binaryIngestSidecarPath } from '../../src/shared/binary-ingest-sidecar.js'

function withTempDir<T>(callback: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-generate-'))
  try {
    return callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function withTempDirAsync<T>(callback: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-generate-'))
  try {
    return await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function createTestWavBuffer(durationSeconds: number, sampleRate: number = 4_000, channelCount: number = 2, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channelCount * (bitsPerSample / 8)
  const blockAlign = channelCount * (bitsPerSample / 8)
  const dataSize = Math.round(durationSeconds * byteRate)
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channelCount, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

function createMp4Atom(type: string, payload: Buffer): Buffer {
  const buffer = Buffer.alloc(8 + payload.length)
  buffer.writeUInt32BE(buffer.length, 0)
  buffer.write(type, 4, 'ascii')
  payload.copy(buffer, 8)
  return buffer
}

function createTestMp4Buffer(durationSeconds: number, timescale: number = 1_000): Buffer {
  const mvhdPayload = Buffer.alloc(20)
  mvhdPayload.writeUInt32BE(0, 0)
  mvhdPayload.writeUInt32BE(0, 4)
  mvhdPayload.writeUInt32BE(0, 8)
  mvhdPayload.writeUInt32BE(timescale, 12)
  mvhdPayload.writeUInt32BE(Math.round(durationSeconds * timescale), 16)

  return Buffer.concat([
    createMp4Atom('ftyp', Buffer.from('isom0000', 'ascii')),
    createMp4Atom('moov', createMp4Atom('mvhd', mvhdPayload)),
  ])
}

function encodeSynchsafeInteger(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ])
}

function createId3v23TextFrame(frameId: string, value: string): Buffer {
  const text = Buffer.from(value, 'utf8')
  const payload = Buffer.concat([Buffer.from([3]), text])
  const frame = Buffer.alloc(10 + payload.length)
  frame.write(frameId, 0, 'ascii')
  frame.writeUInt32BE(payload.length, 4)
  payload.copy(frame, 10)
  return frame
}

function createTestMp3Id3Buffer(metadata: { title: string; artist: string; album: string }): Buffer {
  const frames = Buffer.concat([
    createId3v23TextFrame('TIT2', metadata.title),
    createId3v23TextFrame('TPE1', metadata.artist),
    createId3v23TextFrame('TALB', metadata.album),
  ])
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'ascii')
  header[3] = 3
  header[4] = 0
  encodeSynchsafeInteger(frames.length).copy(header, 6)
  return Buffer.concat([header, frames, Buffer.from([0xff, 0xfb, 0x90, 0x64])])
}

describe('generateGraph', () => {
  test('builds graph artifacts for a code corpus', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return 1\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# Notes\nSee [Guide](guide.md)\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'graphify-out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        semantic_anomalies?: unknown
      }

      expect(result.mode).toBe('generate')
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(result.edgeCount).toBeGreaterThan(0)
      expect(result.semanticAnomalyCount).toEqual(expect.any(Number))
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'GRAPH_REPORT.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.html'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'manifest.json'))).toBe(true)
      expect(readFileSync(join(tempDir, 'graphify-out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## God Nodes')
      expect(readFileSync(join(tempDir, 'graphify-out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## Semantic Anomalies')
      expect(result.notes.join('\n')).not.toContain('semantic extraction')
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
      expect(Array.isArray(graphData.semantic_anomalies)).toBe(true)
    })
  })

  test('builds graph artifacts for a docs-and-images corpus without code', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'README.md'), '# Overview\n![Diagram](diagram.svg)\nSee [Guide](guide.md)\n## Details\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')
      writeFileSync(join(tempDir, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>Diagram</title></svg>', 'utf8')

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'graphify-out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.codeFiles).toBe(0)
      expect(result.nonCodeFiles).toBeGreaterThan(0)
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(result.notes.join('\n')).not.toContain('semantic extraction')
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
      expect(graphData.nodes.some((node) => node.file_type === 'image')).toBe(true)
    })
  })

  test('builds graph artifacts for a docs-and-local-media corpus without code', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Episode](episode.mp3)\nSee [Demo](demo.mp4)\n', 'utf8')
      writeFileSync(join(tempDir, 'episode.mp3'), Buffer.from('ID3'))
      writeFileSync(join(tempDir, 'demo.mp4'), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'graphify-out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.codeFiles).toBe(0)
      expect(result.nonCodeFiles).toBe(3)
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(graphData.nodes.some((node) => node.file_type === 'document')).toBe(true)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode.mp3',
            content_type: 'audio/mpeg',
            file_bytes: 3,
          }),
          expect.objectContaining({
            file_type: 'video',
            label: 'demo.mp4',
            content_type: 'video/mp4',
            file_bytes: 8,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with deterministic duration metadata for supported local media formats', () => {
    withTempDir((tempDir) => {
      const wavBuffer = createTestWavBuffer(1.5)
      const mp4Buffer = createTestMp4Buffer(2.5)
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Tone](tone.wav)\nSee [Clip](clip.mp4)\n', 'utf8')
      writeFileSync(join(tempDir, 'tone.wav'), wavBuffer)
      writeFileSync(join(tempDir, 'clip.mp4'), mp4Buffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'graphify-out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(3)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'tone.wav',
            media_duration_seconds: 1.5,
            audio_sample_rate_hz: 4000,
            audio_channel_count: 2,
          }),
          expect.objectContaining({
            file_type: 'video',
            label: 'clip.mp4',
            media_duration_seconds: 2.5,
          }),
        ]),
      )
    })
  })

  test('builds graph artifacts with deterministic MP3 track metadata from saved assets', () => {
    withTempDir((tempDir) => {
      const mp3Buffer = createTestMp3Id3Buffer({
        title: 'Roadmap Review',
        artist: 'Graphify FM',
        album: 'Engineering Notes',
      })
      writeFileSync(join(tempDir, 'README.md'), '# Overview\nSee [Episode](episode.mp3)\n', 'utf8')
      writeFileSync(join(tempDir, 'episode.mp3'), mp3Buffer)

      const result = generateGraph(tempDir)
      const graphData = JSON.parse(readFileSync(join(tempDir, 'graphify-out', 'graph.json'), 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(result.nonCodeFiles).toBe(2)
      expect(graphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode.mp3',
            audio_title: 'Roadmap Review',
            audio_artist: 'Graphify FM',
            audio_album: 'Engineering Notes',
          }),
        ]),
      )
    })
  })

  test('includes saved memory notes from graphify-out/memory with frontmatter metadata and references', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'auth.ts'), 'export function authenticate() {\n  return true\n}\n', 'utf8')
      mkdirSync(join(tempDir, 'graphify-out', 'memory'), { recursive: true })
      writeFileSync(
        join(tempDir, 'graphify-out', 'memory', 'query_auth.md'),
        [
          '---',
          'title: "Auth result"',
          'source_url: "https://example.com/auth"',
          'captured_at: "2026-04-11T00:00:00Z"',
          'source_nodes: ["authenticate()"]',
          '---',
          '',
          '# Q: How does auth work?',
          '',
          '## Answer',
          '',
          'Authentication starts in authenticate().',
        ].join('\n'),
        'utf8',
      )

      const result = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
      }
      const noteNode = graphData.nodes.find((node) => node.label === 'query_auth.md')
      const authNode = graphData.nodes.find((node) => node.label === 'authenticate()')

      expect(noteNode).toMatchObject({
        title: 'Auth result',
        source_url: 'https://example.com/auth',
        captured_at: '2026-04-11T00:00:00Z',
      })
      expect(authNode).toBeTruthy()
      expect(graphData.links.some((edge) => edge.source === noteNode?.id && edge.target === authNode?.id && edge.relation === 'references')).toBe(true)
    })
  })

  test('supports cluster-only regeneration from an existing graph', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def greet():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      const result = generateGraph(tempDir, { clusterOnly: true })

      expect(result.mode).toBe('cluster-only')
      expect(result.nodeCount).toBeGreaterThan(0)
      expect(readFileSync(join(tempDir, 'graphify-out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## Communities')
    })
  })

  test('tracks incremental update changes after a manifest exists', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      writeFileSync(sourcePath, 'def greet():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return 2\n\ndef other():\n    return greet()\n', 'utf8')

      const result = generateGraph(tempDir, { update: true })

      expect(result.mode).toBe('update')
      expect(result.changedFiles).toBeGreaterThan(0)
      expect(result.deletedFiles).toBe(0)
      expect(existsSync(join(tempDir, 'graphify-out', 'manifest.json'))).toBe(true)
    })
  })

  test('treats local media sidecar-only changes as incremental updates', async () => {
    await withTempDirAsync(async (tempDir) => {
      const audioPath = join(tempDir, 'episode.mp3')
      const sidecarPath = binaryIngestSidecarPath(audioPath)
      writeFileSync(audioPath, Buffer.from('ID3'))
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/1',
            captured_at: '2026-04-14T02:00:00Z',
            contributor: 'graphify-ts',
          },
          null,
          2,
        ),
        'utf8',
      )

      const initial = generateGraph(tempDir, { noHtml: true })
      const initialGraphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(initialGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            source_url: 'https://example.com/podcast/episodes/1',
          }),
        ]),
      )

      await delay(10)
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/2',
            captured_at: '2026-04-14T02:05:00Z',
            contributor: 'graphify-ts',
          },
          null,
          2,
        ),
        'utf8',
      )

      const updated = generateGraph(tempDir, { update: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(updated.changedFiles).toBeGreaterThan(0)
      expect(updatedGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            source_url: 'https://example.com/podcast/episodes/2',
            captured_at: '2026-04-14T02:05:00Z',
          }),
        ]),
      )
    })
  })

  test.runIf(process.platform !== 'win32')('preserves symlink-following local media files during incremental updates', async () => {
    await withTempDirAsync(async (tempDir) => {
      const mediaDir = join(tempDir, 'media')
      const targetPath = join(mediaDir, 'episode.mp3')
      const linkPath = join(tempDir, 'episode-link.mp3')
      mkdirSync(mediaDir, { recursive: true })
      writeFileSync(targetPath, Buffer.from('ID3'))
      symlinkSync(targetPath, linkPath)

      const initial = generateGraph(tempDir, { followSymlinks: true, noHtml: true })
      const initialGraphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(initialGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode-link.mp3',
            source_file: linkPath,
          }),
        ]),
      )

      const updated = generateGraph(tempDir, { update: true, followSymlinks: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown>>
      }

      expect(updated.deletedFiles).toBe(0)
      expect(updatedGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_type: 'audio',
            label: 'episode-link.mp3',
            source_file: linkPath,
          }),
        ]),
      )
    })
  })

  test('preserves schema version during incremental updates', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      const helperPath = join(tempDir, 'helper.py')
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n', 'utf8')
      writeFileSync(helperPath, 'def helper():\n    return 1\n', 'utf8')

      const initial = generateGraph(tempDir, { noHtml: true })
      const graphData = JSON.parse(readFileSync(initial.graphPath, 'utf8')) as {
        schema_version?: number
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
        hyperedges?: Array<Record<string, unknown>>
      }

      graphData.schema_version = 2
      graphData.nodes = graphData.nodes.map((node) =>
        node.label === 'helper()'
          ? {
              ...node,
              layer: 'semantic',
              provenance: [{ capability_id: 'test:seed-helper', stage: 'seed' }],
            }
          : node,
      )
      writeFileSync(initial.graphPath, `${JSON.stringify(graphData, null, 2)}\n`, 'utf8')

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n\ndef other():\n    return greet()\n', 'utf8')

      const updated = generateGraph(tempDir, { update: true, noHtml: true })
      const updatedGraphData = JSON.parse(readFileSync(updated.graphPath, 'utf8')) as {
        schema_version?: number
        nodes: Array<Record<string, unknown>>
      }

      expect(updatedGraphData.schema_version).toBe(2)
      expect(updatedGraphData.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'helper()',
            layer: 'semantic',
            provenance: [expect.objectContaining({ capability_id: 'test:seed-helper' })],
          }),
        ]),
      )
    })
  })

  test('re-extracts only changed files during update while retaining unchanged graph context', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.py')
      const helperPath = join(tempDir, 'helper.py')
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n', 'utf8')
      writeFileSync(helperPath, 'def helper():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      await delay(10)
      writeFileSync(sourcePath, 'def greet():\n    return helper()\n\ndef other():\n    return greet()\n', 'utf8')

      vi.resetModules()
      const actualExtractModule = await vi.importActual<typeof import('../../src/pipeline/extract.js')>('../../src/pipeline/extract.js')
      const extractSpy = vi.fn(actualExtractModule.extract)
      vi.doMock('../../src/pipeline/extract.js', () => ({
        ...actualExtractModule,
        extract: extractSpy,
      }))

      try {
        const generateModule = await import('../../src/infrastructure/generate.js')
        const result = generateModule.generateGraph(tempDir, { update: true, noHtml: true })
        const graph = loadGraph(result.graphPath)

        expect(extractSpy).toHaveBeenCalledTimes(1)
        expect(extractSpy.mock.calls[0]?.[0]).toEqual([sourcePath])
        expect(graph.nodeEntries().some(([, attributes]) => attributes.label === 'helper()')).toBe(true)
        expect(graph.nodeEntries().some(([, attributes]) => attributes.label === 'other()')).toBe(true)
      } finally {
        vi.doUnmock('../../src/pipeline/extract.js')
        vi.resetModules()
      }
    })
  })

  test('writes optional wiki, obsidian, svg, graphml, and cypher artifacts when requested', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return 1\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# Notes\nSee [Guide](guide.md)\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')

      const obsidianDir = join(tempDir, 'vault')
      const result = generateGraph(tempDir, {
        wiki: true,
        obsidian: true,
        obsidianDir,
        svg: true,
        graphml: true,
        neo4j: true,
      })

      expect(existsSync(join(tempDir, 'graphify-out', 'wiki', 'index.md'))).toBe(true)
      expect(existsSync(join(obsidianDir, '.obsidian', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.svg'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'graph.graphml'))).toBe(true)
      expect(existsSync(join(tempDir, 'graphify-out', 'cypher.txt'))).toBe(true)
      expect(result.wikiPath).toBe(join(tempDir, 'graphify-out', 'wiki'))
      expect(result.obsidianPath).toBe(obsidianDir)
      expect(result.svgPath).toBe(join(tempDir, 'graphify-out', 'graph.svg'))
      expect(result.graphmlPath).toBe(join(tempDir, 'graphify-out', 'graph.graphml'))
      expect(result.cypherPath).toBe(join(tempDir, 'graphify-out', 'cypher.txt'))
    })
  })

  test('generates semantic community labels in reports and graph json metadata', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'src', 'infrastructure'), { recursive: true })
      mkdirSync(join(tempDir, 'src', 'pipeline'), { recursive: true })
      writeFileSync(
        join(tempDir, 'src', 'infrastructure', 'install.ts'),
        'export function claudeInstall() { return ensureArray() }\nexport function ensureArray() { return [] }\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'src', 'pipeline', 'export.ts'), 'export function toHtml() { return toSvg() }\nexport function toSvg() { return 1 }\n', 'utf8')

      const result = generateGraph(tempDir, { noHtml: true })
      const report = readFileSync(result.reportPath, 'utf8')
      const graphData = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        community_labels?: Record<string, string>
      }

      expect(report).toContain('Infrastructure Install')
      expect(report).toContain('Pipeline Export')
      expect(report).not.toContain('Community 0 - "Community 0"')
      expect(graphData.community_labels).toMatchObject({
        0: expect.any(String),
      })
      expect(Object.values(graphData.community_labels ?? {})).toEqual(expect.arrayContaining(['Infrastructure Install', 'Pipeline Export']))
    })
  })

  test('propagates forced overview html mode through generateGraph', () => {
    withTempDir((tempDir) => {
      mkdirSync(join(tempDir, 'src', 'infrastructure'), { recursive: true })
      mkdirSync(join(tempDir, 'src', 'pipeline'), { recursive: true })
      writeFileSync(
        join(tempDir, 'src', 'infrastructure', 'install.ts'),
        'export function claudeInstall() { return ensureArray() }\nexport function ensureArray() { return [] }\n',
        'utf8',
      )
      writeFileSync(join(tempDir, 'src', 'pipeline', 'export.ts'), 'export function toHtml() { return toSvg() }\nexport function toSvg() { return 1 }\n', 'utf8')

      const result = generateGraph(tempDir, { htmlMode: 'overview' })
      expect(result.htmlPath).not.toBeNull()
      if (!result.htmlPath) {
        throw new Error('Expected htmlPath to be written when HTML export is enabled')
      }

      const overview = readFileSync(result.htmlPath, 'utf8')

      expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining('Large graph mode enabled')]))
      expect(overview).toContain('Overview-first large-graph mode')
      expect(readFileSync(join(tempDir, 'graphify-out', 'graph-pages', 'community-0.html'), 'utf8')).toContain('Back to overview')
    })
  })

  test('writes and reloads directed graphs when requested', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'class Greeter:\n    def hello(self):\n        return helper()\n\ndef helper():\n    return 1\n', 'utf8')

      const result = generateGraph(tempDir, { directed: true, noHtml: true })
      const graph = loadGraph(result.graphPath)

      expect(graph.isDirected()).toBe(true)
    })
  })
})
