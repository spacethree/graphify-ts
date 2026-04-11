import { Dirent, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'

export const FileType = {
  CODE: 'code',
  DOCUMENT: 'document',
  PAPER: 'paper',
  IMAGE: 'image',
} as const

export type FileTypeValue = (typeof FileType)[keyof typeof FileType]

export interface DetectOptions {
  followSymlinks?: boolean
}

export interface DetectResult {
  files: Record<FileTypeValue, string[]>
  total_files: number
  total_words: number
  needs_graph: boolean
  warning: string | null
  skipped_sensitive: string[]
  graphifyignore_patterns: number
}

export const CODE_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.js',
  '.jsx',
  '.tsx',
  '.go',
  '.rs',
  '.java',
  '.cpp',
  '.cc',
  '.cxx',
  '.c',
  '.h',
  '.hpp',
  '.rb',
  '.swift',
  '.kt',
  '.kts',
  '.cs',
  '.scala',
  '.php',
  '.lua',
  '.toc',
  '.zig',
  '.ps1',
  '.ex',
  '.exs',
  '.m',
  '.mm',
  '.jl',
])
export const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst'])
export const PAPER_EXTENSIONS = new Set(['.pdf'])
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
export const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx'])

const CORPUS_WARN_THRESHOLD = 50_000
const CORPUS_UPPER_THRESHOLD = 500_000
const FILE_COUNT_UPPER = 200
export const DEFAULT_MANIFEST_PATH = 'graphify-out/manifest.json'

const SENSITIVE_PATTERNS = [
  /(^|[\\/])\.(env|envrc)(\.|$)/i,
  /\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
  /(credential|secret|passwd|password|token|private_key)/i,
  /(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /(\.netrc|\.pgpass|\.htpasswd)$/i,
  /(aws_credentials|gcloud_credentials|service.account)/i,
]

const PAPER_SIGNALS = [
  /\barxiv\b/i,
  /\bdoi\s*:/i,
  /\babstract\b/i,
  /\bproceedings\b/i,
  /\bjournal\b/i,
  /\bpreprint\b/i,
  /\\cite\{/,
  /\[\d+\]/,
  /\[\n\d+\n\]/,
  /eq\.\s*\d+|equation\s+\d+/i,
  /\d{4}\.\d{4,5}/,
  /\bwe propose\b/i,
  /\bliterature\b/i,
]
const PAPER_SIGNAL_THRESHOLD = 3

const ASSET_DIR_MARKERS = ['.imageset', '.xcassets', '.appiconset', '.colorset', '.launchimage']
const SKIP_DIRS = new Set([
  'venv',
  '.venv',
  'env',
  '.env',
  'graphify-out',
  'node_modules',
  '__pycache__',
  '.git',
  'dist',
  'build',
  'target',
  'out',
  'site-packages',
  'lib64',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.eggs',
])

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function globToRegExp(pattern: string): RegExp {
  const wildcardCount = [...pattern].filter((character) => character === '*').length
  if (pattern.length > 512 || wildcardCount > 32) {
    return /^$/
  }

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const wildcarded = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${wildcarded}$`)
}

function matchesPattern(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value)
}

function isNoiseDir(part: string): boolean {
  return SKIP_DIRS.has(part) || part.endsWith('_venv') || part.endsWith('_env') || part.endsWith('.egg-info')
}

function isSensitive(path: string): boolean {
  const name = basename(path)
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name) || pattern.test(path))
}

export function _looksLikePaper(path: string): boolean {
  try {
    const text = readFileSync(path, 'utf8').slice(0, 3_000)
    const hits = PAPER_SIGNALS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0)
    return hits >= PAPER_SIGNAL_THRESHOLD
  } catch {
    return false
  }
}

export function classifyFile(path: string): FileTypeValue | null {
  const extension = extname(path).toLowerCase()
  if (CODE_EXTENSIONS.has(extension)) {
    return FileType.CODE
  }
  if (PAPER_EXTENSIONS.has(extension)) {
    const pathParts = toPosixPath(path).split('/')
    if (pathParts.some((part) => ASSET_DIR_MARKERS.some((marker) => part.endsWith(marker)))) {
      return null
    }
    return FileType.PAPER
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return FileType.IMAGE
  }
  if (DOC_EXTENSIONS.has(extension)) {
    return _looksLikePaper(path) ? FileType.PAPER : FileType.DOCUMENT
  }
  if (OFFICE_EXTENSIONS.has(extension)) {
    return FileType.DOCUMENT
  }
  return null
}

export function countWords(path: string): number {
  try {
    const extension = extname(path).toLowerCase()
    if (IMAGE_EXTENSIONS.has(extension) || PAPER_EXTENSIONS.has(extension)) {
      return 0
    }
    return readFileSync(path, 'utf8').split(/\s+/).filter(Boolean).length
  } catch {
    return 0
  }
}

export function _loadGraphifyignore(root: string): string[] {
  try {
    const content = readFileSync(resolve(root, '.graphifyignore'), 'utf8')
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  } catch {
    return []
  }
}

export function _isIgnored(path: string, root: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false
  }

  const relativePath = toPosixPath(relative(resolve(root), resolve(path)))
  if (relativePath.startsWith('..')) {
    return false
  }

  const pathParts = relativePath.split('/')
  const fileName = basename(path)

  for (const rawPattern of patterns) {
    const pattern = rawPattern.replace(/^\/+|\/+$/g, '')
    if (!pattern) {
      continue
    }

    if (matchesPattern(relativePath, pattern) || matchesPattern(fileName, pattern)) {
      return true
    }

    for (let index = 0; index < pathParts.length; index += 1) {
      const part = pathParts[index]
      if (!part) {
        continue
      }
      const prefix = pathParts.slice(0, index + 1).join('/')
      if (matchesPattern(part, pattern) || matchesPattern(prefix, pattern)) {
        return true
      }
    }
  }

  return false
}

function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const rootPrefix = rootRealPath.endsWith(sep) ? rootRealPath : `${rootRealPath}${sep}`
  return candidateRealPath === rootRealPath || candidateRealPath.startsWith(rootPrefix)
}

function visitDirectory(
  directory: string,
  root: string,
  followSymlinks: boolean,
  ignorePatterns: string[],
  ancestorRealPaths: string[],
  rootRealPath: string,
  files: string[],
): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name)
    const normalizedEntryPath = toPosixPath(entryPath)

    if (entry.name.startsWith('.')) {
      continue
    }

    if (_isIgnored(entryPath, root, ignorePatterns)) {
      continue
    }

    let stats
    try {
      stats = lstatSync(entryPath)
    } catch {
      continue
    }

    if (stats.isDirectory()) {
      if (isNoiseDir(entry.name)) {
        continue
      }
      visitDirectory(entryPath, root, followSymlinks, ignorePatterns, ancestorRealPaths, rootRealPath, files)
      continue
    }

    if (stats.isSymbolicLink()) {
      if (!followSymlinks) {
        continue
      }

      let realTarget: string
      try {
        realTarget = realpathSync(entryPath)
      } catch {
        continue
      }

      if (ancestorRealPaths.includes(realTarget)) {
        continue
      }
      if (!isWithinRoot(rootRealPath, realTarget)) {
        continue
      }

      let targetStats
      try {
        targetStats = lstatSync(realTarget)
      } catch {
        continue
      }

      if (targetStats.isDirectory()) {
        const nextAncestors = [...ancestorRealPaths, realTarget]
        visitDirectory(entryPath, root, followSymlinks, ignorePatterns, nextAncestors, rootRealPath, files)
      } else if (targetStats.isFile()) {
        files.push(normalizedEntryPath)
      }
      continue
    }

    if (stats.isFile()) {
      files.push(normalizedEntryPath)
    }
  }
}

function collectFiles(root: string, followSymlinks: boolean, ignorePatterns: string[]): string[] {
  const resolvedRoot = resolve(root)
  mkdirSync(resolvedRoot, { recursive: true })

  const files: string[] = []
  let rootRealPath = resolvedRoot
  try {
    rootRealPath = realpathSync(resolvedRoot)
  } catch {
    rootRealPath = resolvedRoot
  }

  visitDirectory(resolvedRoot, resolvedRoot, followSymlinks, ignorePatterns, [rootRealPath], rootRealPath, files)
  return files.sort()
}

function inferOutputBase(outputPath: string): string {
  const resolvedPath = resolve(outputPath)
  const parts = resolvedPath.split(sep)
  const graphifyOutIndex = parts.lastIndexOf('graphify-out')

  if (graphifyOutIndex >= 0) {
    const baseParts = parts.slice(0, graphifyOutIndex + 1)
    if (baseParts[0] === '') {
      return `${sep}${baseParts.slice(1).join(sep)}`
    }
    return baseParts.join(sep)
  }

  return resolve('graphify-out')
}

function validateManifestPath(manifestPath: string): string {
  const resolvedPath = resolve(manifestPath)
  const resolvedBase = inferOutputBase(manifestPath)
  const basePrefix = resolvedBase.endsWith(sep) ? resolvedBase : `${resolvedBase}${sep}`
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(basePrefix)) {
    throw new Error(`Manifest path must stay within graphify-out/: ${manifestPath}`)
  }
  return resolvedPath
}

export function detect(root: string, options: DetectOptions = {}): DetectResult {
  const followSymlinks = options.followSymlinks ?? false
  const ignorePatterns = _loadGraphifyignore(root)
  const files: Record<FileTypeValue, string[]> = {
    [FileType.CODE]: [],
    [FileType.DOCUMENT]: [],
    [FileType.PAPER]: [],
    [FileType.IMAGE]: [],
  }

  let totalWords = 0
  const skippedSensitive: string[] = []

  for (const filePath of collectFiles(root, followSymlinks, ignorePatterns)) {
    if (isSensitive(filePath)) {
      skippedSensitive.push(filePath)
      continue
    }

    const fileType = classifyFile(filePath)
    if (!fileType) {
      continue
    }

    files[fileType].push(filePath)
    totalWords += countWords(filePath)
  }

  const totalFiles = Object.values(files).reduce((count, group) => count + group.length, 0)
  const needsGraph = totalWords >= CORPUS_WARN_THRESHOLD

  let warning: string | null = null
  if (!needsGraph) {
    warning = `Corpus is ~${totalWords.toLocaleString()} words - fits in a single context window. You may not need a graph.`
  } else if (totalWords >= CORPUS_UPPER_THRESHOLD || totalFiles >= FILE_COUNT_UPPER) {
    warning = `Large corpus: ${totalFiles} files · ~${totalWords.toLocaleString()} words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.`
  }

  return {
    files,
    total_files: totalFiles,
    total_words: totalWords,
    needs_graph: needsGraph,
    warning,
    skipped_sensitive: skippedSensitive,
    graphifyignore_patterns: ignorePatterns.length,
  }
}

export function loadManifest(manifestPath: string = DEFAULT_MANIFEST_PATH): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(validateManifestPath(manifestPath), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch {
    return {}
  }
}

export function saveManifest(files: Record<string, string[]>, manifestPath: string = DEFAULT_MANIFEST_PATH): void {
  const manifest: Record<string, number> = {}

  for (const fileList of Object.values(files)) {
    for (const filePath of fileList) {
      try {
        const modifiedAt = statSync(filePath).mtimeMs
        if (Number.isFinite(modifiedAt)) {
          manifest[filePath] = modifiedAt
        }
      } catch {
        // Ignore files deleted between detect() and manifest write.
      }
    }
  }

  const safeManifestPath = validateManifestPath(manifestPath)
  mkdirSync(dirname(safeManifestPath), { recursive: true })
  writeFileSync(safeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function detectIncremental(
  root: string,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): DetectResult & {
  incremental: true
  new_files: Record<FileTypeValue, string[]>
  unchanged_files: Record<FileTypeValue, string[]>
  new_total: number
  deleted_files: string[]
} {
  const full = detect(root)
  const manifest = loadManifest(manifestPath)

  if (Object.keys(manifest).length === 0) {
    return {
      ...full,
      incremental: true,
      new_files: full.files,
      unchanged_files: {
        [FileType.CODE]: [],
        [FileType.DOCUMENT]: [],
        [FileType.PAPER]: [],
        [FileType.IMAGE]: [],
      },
      new_total: full.total_files,
      deleted_files: [],
    }
  }

  const newFiles: Record<FileTypeValue, string[]> = {
    [FileType.CODE]: [],
    [FileType.DOCUMENT]: [],
    [FileType.PAPER]: [],
    [FileType.IMAGE]: [],
  }
  const unchangedFiles: Record<FileTypeValue, string[]> = {
    [FileType.CODE]: [],
    [FileType.DOCUMENT]: [],
    [FileType.PAPER]: [],
    [FileType.IMAGE]: [],
  }

  for (const [fileType, fileList] of Object.entries(full.files) as Array<[FileTypeValue, string[]]>) {
    for (const filePath of fileList) {
      let currentMtime = 0
      try {
        currentMtime = statSync(filePath).mtimeMs
      } catch {
        currentMtime = 0
      }

      const storedMtime = manifest[filePath]
      if (storedMtime === undefined || currentMtime > storedMtime) {
        newFiles[fileType].push(filePath)
      } else {
        unchangedFiles[fileType].push(filePath)
      }
    }
  }

  const currentFiles = new Set(Object.values(full.files).flat())
  const deletedFiles = Object.keys(manifest).filter((filePath) => !currentFiles.has(filePath))

  return {
    ...full,
    incremental: true,
    new_files: newFiles,
    unchanged_files: unchangedFiles,
    new_total: Object.values(newFiles).reduce((count, fileList) => count + fileList.length, 0),
    deleted_files: deletedFiles,
  }
}
