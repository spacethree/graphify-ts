import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _loadGraphifyignore, _isIgnored, classifyFile, countWords, detect, FileType } from '../../src/pipeline/detect.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

describe('detect', () => {
  function createTempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'graphify-ts-detect-'))
  }

  it('classifies code, docs, papers, images, audio, video, and unknown files', () => {
    expect(classifyFile('foo.py')).toBe(FileType.CODE)
    expect(classifyFile('bar.ts')).toBe(FileType.CODE)
    expect(classifyFile('README.md')).toBe(FileType.DOCUMENT)
    expect(classifyFile('paper.pdf')).toBe(FileType.PAPER)
    expect(classifyFile('screenshot.png')).toBe(FileType.IMAGE)
    expect(classifyFile('episode.mp3')).toBe(FileType.AUDIO)
    expect(classifyFile('demo.mp4')).toBe(FileType.VIDEO)
    expect(classifyFile('archive.zip')).toBeNull()
  })

  it('skips PDFs inside xcassets directories', () => {
    expect(classifyFile('MyApp/Images.xcassets/icon.imageset/icon.pdf')).toBeNull()
    expect(classifyFile('Pods/HXPHPicker/Assets.xcassets/photo.pdf')).toBeNull()
  })

  it('counts words in the sample markdown fixture', () => {
    expect(countWords(join(FIXTURES_DIR, 'sample.md'))).toBeGreaterThan(5)
  })

  it('detects fixture files and warns for a small corpus', () => {
    const result = detect(FIXTURES_DIR)

    expect(result.total_files).toBeGreaterThanOrEqual(2)
    expect(result.files.code.length).toBeGreaterThan(0)
    expect(result.files.document.length).toBeGreaterThan(0)
    expect(result.needs_graph).toBe(false)
    expect(result.warning).not.toBeNull()
  })

  it('includes saved graphify memory notes while keeping generated artifacts ignored', () => {
    const root = createTempRoot()
    try {
      mkdirSync(join(root, 'graphify-out', 'memory'), { recursive: true })
      writeFileSync(join(root, 'graphify-out', 'memory', 'query_auth.md'), '# Saved query\n', 'utf8')
      writeFileSync(join(root, 'graphify-out', 'graph.json'), '{}\n', 'utf8')
      writeFileSync(join(root, 'graphify-out', 'GRAPH_REPORT.md'), '# Report\n', 'utf8')

      const result = detect(root)

      expect(result.files.document).toContain(join(root, 'graphify-out', 'memory', 'query_auth.md'))
      expect(result.files.document.some((filePath) => filePath.endsWith('GRAPH_REPORT.md'))).toBe(false)
      expect(
        Object.values(result.files)
          .flat()
          .some((filePath) => filePath.endsWith('graph.json')),
      ).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips hidden files during detection', () => {
    const result = detect(FIXTURES_DIR)
    for (const files of Object.values(result.files)) {
      for (const filePath of files) {
        expect(filePath.includes('/.')).toBe(false)
      }
    }
  })

  it('loads graphifyignore patterns and excludes matching files', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.graphifyignore'), 'vendor/\n*.generated.py\n', 'utf8')
      mkdirSync(join(root, 'vendor'), { recursive: true })
      writeFileSync(join(root, 'vendor', 'lib.py'), 'x = 1', 'utf8')
      writeFileSync(join(root, 'main.py'), 'print("hi")', 'utf8')
      writeFileSync(join(root, 'schema.generated.py'), 'x = 1', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.includes('main.py'))).toBe(true)
      expect(result.files.code.some((filePath) => filePath.includes('vendor'))).toBe(false)
      expect(result.files.code.some((filePath) => filePath.includes('generated'))).toBe(false)
      expect(result.graphifyignore_patterns).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores comments in graphifyignore files', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.graphifyignore'), '# comment\n\nmain.py\n', 'utf8')
      writeFileSync(join(root, 'main.py'), 'x = 1', 'utf8')
      writeFileSync(join(root, 'other.py'), 'x = 2', 'utf8')

      const result = detect(root)

      expect(result.files.code.some((filePath) => filePath.includes('main.py'))).toBe(false)
      expect(result.files.code.some((filePath) => filePath.includes('other.py'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes graphifyignore helpers for explicit path matching', () => {
    const root = createTempRoot()
    try {
      writeFileSync(join(root, '.graphifyignore'), 'vendor/\n*.generated.py\n', 'utf8')
      const patterns = _loadGraphifyignore(root)

      expect(_isIgnored(join(root, 'vendor', 'lib.py'), root, patterns)).toBe(true)
      expect(_isIgnored(join(root, 'schema.generated.py'), root, patterns)).toBe(true)
      expect(_isIgnored(join(root, 'main.py'), root, patterns)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows symlinked directories when requested', () => {
    const root = createTempRoot()
    try {
      const realDir = join(root, 'real_lib')
      mkdirSync(realDir, { recursive: true })
      writeFileSync(join(realDir, 'util.py'), 'x = 1', 'utf8')
      symlinkSync(realDir, join(root, 'linked_lib'))

      const resultWithoutSymlinks = detect(root)
      const resultWithSymlinks = detect(root, { followSymlinks: true })

      expect(resultWithoutSymlinks.files.code.some((filePath) => filePath.includes('real_lib'))).toBe(true)
      expect(resultWithoutSymlinks.files.code.some((filePath) => filePath.includes('linked_lib'))).toBe(false)
      expect(resultWithSymlinks.files.code.some((filePath) => filePath.includes('linked_lib'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('follows symlinked files when requested', () => {
    const root = createTempRoot()
    try {
      const realFile = join(root, 'real.py')
      writeFileSync(realFile, 'x = 1', 'utf8')
      symlinkSync(realFile, join(root, 'link.py'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.includes('real.py'))).toBe(true)
      expect(result.files.code.some((filePath) => filePath.includes('link.py'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('handles circular symlinks safely', () => {
    const root = createTempRoot()
    try {
      const subDir = join(root, 'a')
      mkdirSync(subDir, { recursive: true })
      writeFileSync(join(subDir, 'main.py'), 'x = 1', 'utf8')
      symlinkSync(root, join(subDir, 'loop'))

      const result = detect(root, { followSymlinks: true })

      expect(result.files.code.some((filePath) => filePath.includes('main.py'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
