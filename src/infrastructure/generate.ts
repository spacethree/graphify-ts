import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { godNodes, suggestQuestions, surprisingConnections } from '../pipeline/analyze.js'
import { buildFromJson } from '../pipeline/build.js'
import { cluster, scoreAll } from '../pipeline/cluster.js'
import { type DetectResult, detect, detectIncremental, FileType, saveManifest } from '../pipeline/detect.js'
import { toHtml, toJson } from '../pipeline/export.js'
import { extract } from '../pipeline/extract.js'
import { generate as generateReport } from '../pipeline/report.js'
import { loadGraph } from '../runtime/serve.js'

export interface GenerateGraphOptions {
  update?: boolean
  clusterOnly?: boolean
  followSymlinks?: boolean
  noHtml?: boolean
}

export interface GenerateGraphResult {
  mode: 'generate' | 'update' | 'cluster-only'
  rootPath: string
  outputDir: string
  graphPath: string
  reportPath: string
  htmlPath: string | null
  totalFiles: number
  codeFiles: number
  nonCodeFiles: number
  totalWords: number
  nodeCount: number
  edgeCount: number
  communityCount: number
  changedFiles: number
  deletedFiles: number
  warning: string | null
  notes: string[]
}

type IncrementalDetectResult = ReturnType<typeof detectIncremental>

function detectOptions(options: GenerateGraphOptions): { followSymlinks?: boolean } {
  return options.followSymlinks ? { followSymlinks: true } : {}
}

function countNonCodeFiles(files: DetectResult['files']): number {
  return files[FileType.DOCUMENT].length + files[FileType.PAPER].length + files[FileType.IMAGE].length
}

function detectionSummary(detection: DetectResult): Record<string, unknown> {
  return {
    files: detection.files,
    total_files: detection.total_files,
    total_words: detection.total_words,
    warning: detection.warning,
  }
}

function isIncrementalDetectResult(detection: DetectResult | IncrementalDetectResult): detection is IncrementalDetectResult {
  return 'new_total' in detection && 'new_files' in detection && 'deleted_files' in detection
}

function defaultCommunityLabels(communities: Record<number, string[]>): Record<number, string> {
  return Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Community ${communityId}`]))
}

function outputDirectory(rootPath: string): string {
  return join(rootPath, 'graphify-out')
}

function missingCodeExtractionMessage(totalFiles: number): string {
  if (totalFiles === 0) {
    return 'No supported files were found in the target path.'
  }

  return 'No graph nodes could be generated from the detected corpus. The current TypeScript extractor supports Python, JavaScript/TypeScript, documents, text-like papers, and image assets, but some detected formats still have shallow coverage.'
}

export function generateGraph(rootPath = '.', options: GenerateGraphOptions = {}): GenerateGraphResult {
  if (options.update && options.clusterOnly) {
    throw new Error('--update and --cluster-only cannot be used together')
  }

  const resolvedRootPath = resolve(rootPath)
  const resolvedOutputDir = outputDirectory(resolvedRootPath)
  const graphPath = join(resolvedOutputDir, 'graph.json')
  const reportPath = join(resolvedOutputDir, 'GRAPH_REPORT.md')
  const htmlPath = join(resolvedOutputDir, 'graph.html')
  const manifestPath = join(resolvedOutputDir, 'manifest.json')

  mkdirSync(resolvedOutputDir, { recursive: true })

  const detected = options.update ? detectIncremental(resolvedRootPath, manifestPath) : detect(resolvedRootPath, detectOptions(options))
  const notes: string[] = []
  const mode: GenerateGraphResult['mode'] = options.clusterOnly ? 'cluster-only' : options.update ? 'update' : 'generate'

  if (options.clusterOnly) {
    notes.push('Re-clustered the existing graph without re-extracting source files.')
  }

  const nonCodeFiles = countNonCodeFiles(detected.files)
  if (nonCodeFiles > 0) {
    notes.push(`${nonCodeFiles} non-code file(s) were included in extraction alongside source code.`)
  }

  let changedFiles = 0
  let deletedFiles = 0
  if (isIncrementalDetectResult(detected)) {
    changedFiles = detected.new_total
    deletedFiles = detected.deleted_files.length

    const changedNonCodeFiles = countNonCodeFiles(detected.new_files)
    if (changedNonCodeFiles > 0) {
      notes.push(`${changedNonCodeFiles} changed non-code file(s) were included during --update.`)
    }

    if (deletedFiles > 0) {
      notes.push(`${deletedFiles} deleted file(s) were detected, so the graph was rebuilt from the current code corpus.`)
    }
  }

  const codeFiles = detected.files[FileType.CODE]
  const extractableFiles = [...codeFiles, ...detected.files[FileType.DOCUMENT], ...detected.files[FileType.PAPER], ...detected.files[FileType.IMAGE]]
  const graph = options.clusterOnly
    ? loadGraph(graphPath)
    : extractableFiles.length > 0
      ? buildFromJson(extract(extractableFiles))
      : options.update && existsSync(graphPath)
        ? loadGraph(graphPath)
        : null

  if (!graph) {
    throw new Error(missingCodeExtractionMessage(detected.total_files))
  }

  if (!options.clusterOnly && graph.numberOfNodes() === 0) {
    throw new Error(missingCodeExtractionMessage(detected.total_files))
  }

  const communities = cluster(graph)
  const cohesionScores = scoreAll(graph, communities)
  const communityLabels = defaultCommunityLabels(communities)
  const godNodeList = godNodes(graph)
  const surpriseList = surprisingConnections(graph, communities)
  const suggestedQuestions = suggestQuestions(graph, communities, communityLabels)
  const report = generateReport(
    graph,
    communities,
    cohesionScores,
    communityLabels,
    godNodeList,
    surpriseList,
    detectionSummary(detected),
    { input: 0, output: 0 },
    resolvedRootPath,
    suggestedQuestions,
  )

  writeFileSync(reportPath, `${report}\n`, 'utf8')
  toJson(graph, communities, graphPath)
  if (!options.noHtml) {
    toHtml(graph, communities, htmlPath, communityLabels)
  }
  saveManifest(detected.files, manifestPath)

  return {
    mode,
    rootPath: resolvedRootPath,
    outputDir: resolvedOutputDir,
    graphPath,
    reportPath,
    htmlPath: options.noHtml ? null : htmlPath,
    totalFiles: detected.total_files,
    codeFiles: codeFiles.length,
    nonCodeFiles,
    totalWords: detected.total_words,
    nodeCount: graph.numberOfNodes(),
    edgeCount: graph.numberOfEdges(),
    communityCount: Object.keys(communities).length,
    changedFiles,
    deletedFiles,
    warning: detected.warning,
    notes,
  }
}
