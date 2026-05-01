import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import { godNodes, workspaceBridges } from '../pipeline/analyze.js'
import { communitiesFromGraph } from './serve.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { analyzeImpact, type ImpactResult } from './impact.js'
import type { RetrieveCommunityContext, RetrieveMatchedNode, RetrieveRelationship } from './retrieve.js'
import { collectRelationships, estimateRetrieveEntryTokens, readSnippet } from './retrieve.js'
import { lineNumberFromSourceLocation, lineRangeFromSourceLocation, type SourceLineRange } from '../shared/source-location.js'
import { relativizeSourceFile } from '../shared/source-path.js'
import { buildRankedRisk, compareRankedRisks, type RiskSeverity } from './risk-map.js'

const MAX_DIFF_BYTES = 5_000_000
const MAX_CHANGED_FILES = 200
const DEFAULT_REVIEW_BUDGET = 2_000
const MAX_REVIEW_SEEDS = 12
const MAX_SECOND_HOP_CANDIDATES = 4
const MAX_COMPACT_PER_NODE_IMPACT = 5
const MAX_COMPACT_REVIEW_SUPPORT_NODES = 3
const MAX_TOP_REVIEW_RISKS = 3

export interface PrImpactOptions {
  baseBranch?: string
  depth?: number
  budget?: number
}

export interface ChangedNode {
  node_id: string
  label: string
  source_file: string
  node_kind: string
  community: number | null
  community_label: string | null
  line_number: number | null
  source_location: string | null
}

export interface PrImpactSeedNode extends ChangedNode {
  match_kind: 'line' | 'file'
}

export interface ChangedFileRanges {
  source_file: string
  line_ranges: SourceLineRange[]
}

export interface PrReviewBundle {
  budget: number
  token_count: number
  nodes: RetrieveMatchedNode[]
  relationships: RetrieveRelationship[]
  community_context: RetrieveCommunityContext[]
}

export interface PrImpactResult {
  base_branch: string
  changed_files: string[]
  changed_ranges: ChangedFileRanges[]
  changed_nodes: ChangedNode[]
  seed_nodes: PrImpactSeedNode[]
  per_node_impact: Array<{
    node: string
    direct_dependents: number
    transitive_dependents: number
    affected_communities: number
  }>
  total_blast_radius: number
  affected_files: string[]
  affected_communities: Array<{ id: number; label: string; node_count: number }>
  review_bundle: PrReviewBundle
  risk_summary: {
    high_impact_nodes: string[]
    cross_community_changes: number
    top_risks: Array<{
      label: string
      severity: RiskSeverity
      reason: string
    }>
  }
}

export interface CompactPrImpactNodeImpact {
  node: string
  total_dependents: number
  affected_communities: number
}

export interface CompactPrImpactResult extends Pick<
  PrImpactResult,
  | 'base_branch'
  | 'changed_files'
  | 'changed_ranges'
  | 'seed_nodes'
  | 'total_blast_radius'
  | 'affected_communities'
  | 'review_bundle'
  | 'risk_summary'
> {
  per_node_impact: CompactPrImpactNodeImpact[]
}

function compactReviewBundle(
  reviewBundle: PrReviewBundle,
  seedNodes: readonly PrImpactSeedNode[],
): PrReviewBundle {
  const seedIds = new Set(seedNodes.map((node) => node.node_id))
  const seedLabels = new Set(seedNodes.map((node) => node.label))
  const compactNodes: RetrieveMatchedNode[] = []
  let supportNodes = 0

  for (const node of reviewBundle.nodes) {
    const isSeed = (typeof node.node_id === 'string' && seedIds.has(node.node_id)) || seedLabels.has(node.label)
    if (!isSeed && supportNodes >= MAX_COMPACT_REVIEW_SUPPORT_NODES) {
      continue
    }

    compactNodes.push(isSeed ? node : { ...node, snippet: null })
    if (!isSeed) {
      supportNodes += 1
    }
  }

  const includedIds = new Set(compactNodes.map((node) => node.node_id).filter((nodeId): nodeId is string => typeof nodeId === 'string'))
  const includedLabels = new Set(compactNodes.map((node) => node.label))
  const includedCommunities = new Set(compactNodes.flatMap((node) => (node.community === null ? [] : [node.community])))

  return {
    budget: reviewBundle.budget,
    token_count: compactNodes.reduce(
      (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
      0,
    ),
    nodes: compactNodes,
    relationships: reviewBundle.relationships.filter((relationship) => {
      if (includedIds.size > 0 && relationship.from_id && relationship.to_id) {
        return includedIds.has(relationship.from_id) && includedIds.has(relationship.to_id)
      }
      return includedLabels.has(relationship.from) && includedLabels.has(relationship.to)
    }),
    community_context: reviewBundle.community_context.filter((community) => includedCommunities.has(community.id)),
  }
}

interface ParsedChangedFileRanges {
  path: string
  lineRanges: SourceLineRange[]
}

interface CandidateNode {
  id: string
  label: string
  sourceFile: string
  sourceLocation: string | null
  nodeKind: string
  fileType: string
  community: number | null
  lineNumber: number
  lineNumberDerived: boolean
}

interface ChangedGraphNode {
  candidate: CandidateNode
  serialized: ChangedNode
  normalizedSourceFile: string
  sourceRange: SourceLineRange | null
}

function gitDiffPatch(projectDir: string, gitArgs: string[]): string {
  try {
    return execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', ...gitArgs], {
      cwd: projectDir,
      maxBuffer: MAX_DIFF_BYTES,
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    return ''
  }
}

function pushChangedRange(changedFiles: Map<string, SourceLineRange[]>, path: string, range: SourceLineRange): void {
  if (!path) {
    return
  }

  const ranges = changedFiles.get(path) ?? []
  if (!ranges.some((candidate) => candidate.start === range.start && candidate.end === range.end)) {
    ranges.push(range)
    changedFiles.set(path, ranges)
  }
}

function ensureChangedFile(changedFiles: Map<string, SourceLineRange[]>, path: string): void {
  if (path && !changedFiles.has(path)) {
    changedFiles.set(path, [])
  }
}

function parseUnifiedDiff(patch: string): ParsedChangedFileRanges[] {
  const changedFiles = new Map<string, SourceLineRange[]>()
  let currentPath = ''

  for (const rawLine of patch.split('\n')) {
    const line = rawLine.trimEnd()

    if (line.startsWith('+++ ')) {
      currentPath = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : ''
      continue
    }

    if (!currentPath || !line.startsWith('@@ ')) {
      continue
    }

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!match?.[1]) {
      continue
    }

    const start = Number.parseInt(match[1], 10)
    const count = Number.parseInt(match[2] ?? '1', 10)
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(count) || count < 0) {
      continue
    }

    ensureChangedFile(changedFiles, currentPath)
    if (count === 0) {
      continue
    }
    if (start === 0) {
      continue
    }

    pushChangedRange(changedFiles, currentPath, {
      start,
      end: start + count - 1,
    })
  }

  return [...changedFiles.entries()]
    .slice(0, MAX_CHANGED_FILES)
    .map(([path, lineRanges]) => ({
      path,
      lineRanges: lineRanges.sort((left, right) => left.start - right.start || left.end - right.end),
    }))
}

function mergeChangedFileRanges(changedSets: ParsedChangedFileRanges[]): ParsedChangedFileRanges[] {
  const merged = new Map<string, SourceLineRange[]>()
  for (const changedFile of changedSets) {
    ensureChangedFile(merged, changedFile.path)
    for (const range of changedFile.lineRanges) {
      pushChangedRange(merged, changedFile.path, range)
    }
  }

  return [...merged.entries()]
    .slice(0, MAX_CHANGED_FILES)
    .map(([path, lineRanges]) => ({
      path,
      lineRanges: lineRanges.sort((left, right) => left.start - right.start || left.end - right.end),
    }))
}

function gitDiffFiles(projectDir: string, baseBranch: string): ParsedChangedFileRanges[] {
  const changedFiles = mergeChangedFileRanges([
    ...parseUnifiedDiff(gitDiffPatch(projectDir, ['HEAD'])),
    ...parseUnifiedDiff(gitDiffPatch(projectDir, ['--cached'])),
    ...parseUnifiedDiff(gitDiffPatch(projectDir, [`${baseBranch}...HEAD`])),
  ])

  return changedFiles.slice(0, MAX_CHANGED_FILES)
}

function gitDetectBaseBranch(projectDir: string): string {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'main'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return 'main'
  } catch {
    return 'master'
  }
}

function parseCommunityId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw)
  }
  return null
}

function storedCommunityLabelsFromGraph(graph: KnowledgeGraph): Record<number, string> {
  const rawLabels = graph.graph.community_labels
  if (!rawLabels || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(rawLabels as Record<string, unknown>)
      .map(([key, value]) => [Number(key), typeof value === 'string' ? value.trim() : ''] as const)
      .filter(([communityId, label]) => Number.isInteger(communityId) && communityId >= 0 && label.length > 0),
  )
}

function normalizeProjectPath(projectDir: string, filePath: string): string {
  if (!filePath) {
    return ''
  }

  const resolvedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(projectDir, filePath)
  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath
}

function sourceRangeFromAttributes(attributes: Record<string, unknown>): SourceLineRange | null {
  if (typeof attributes.line_number === 'number' && attributes.line_number > 0) {
    return {
      start: attributes.line_number,
      end: attributes.line_number,
    }
  }

  return lineRangeFromSourceLocation(attributes.source_location)
}

function candidateNodeFromGraphEntry(nodeId: string, attributes: Record<string, unknown>): CandidateNode {
  const sourceRange = sourceRangeFromAttributes(attributes)
  const sourceLocation = typeof attributes.source_location === 'string' && attributes.source_location.length > 0
    ? attributes.source_location
    : null

  return {
    id: nodeId,
    label: String(attributes.label ?? nodeId),
    sourceFile: String(attributes.source_file ?? ''),
    sourceLocation,
    nodeKind: String(attributes.node_kind ?? ''),
    fileType: String(attributes.file_type ?? '').trim().toLowerCase(),
    community: parseCommunityId(attributes.community),
    lineNumber: sourceRange?.start ?? lineNumberFromSourceLocation(attributes.source_location),
    lineNumberDerived: sourceRange === null,
  }
}

function serializeChangedNode(
  candidate: CandidateNode,
  normalizedSourceFile: string,
  communityLabels: Record<number, string>,
  rootPath: string,
): ChangedNode {
  return {
    node_id: candidate.id,
    label: candidate.label,
    source_file: relativizeSourceFile(normalizedSourceFile, rootPath),
    node_kind: candidate.nodeKind,
    community: candidate.community,
    community_label: candidate.community !== null ? (communityLabels[candidate.community] ?? null) : null,
    line_number: candidate.lineNumber > 0 ? candidate.lineNumber : null,
    source_location: candidate.sourceLocation,
  }
}

function compareChangedNodes(left: ChangedGraphNode, right: ChangedGraphNode): number {
  return left.serialized.source_file.localeCompare(right.serialized.source_file)
    || (left.serialized.line_number ?? Number.MAX_SAFE_INTEGER) - (right.serialized.line_number ?? Number.MAX_SAFE_INTEGER)
    || left.serialized.label.localeCompare(right.serialized.label)
}

function findNodesInFiles(
  graph: KnowledgeGraph,
  changedFiles: ParsedChangedFileRanges[],
  projectDir: string,
  communityLabels: Record<number, string>,
): ChangedGraphNode[] {
  const normalizedFiles = new Set(changedFiles.map((file) => normalizeProjectPath(projectDir, file.path)))
  const changedNodes: ChangedGraphNode[] = []

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const candidate = candidateNodeFromGraphEntry(nodeId, attributes)
    const sourceFile = candidate.sourceFile
    if (!sourceFile) {
      continue
    }

    const normalizedSource = normalizeProjectPath(projectDir, sourceFile)
    if (!normalizedFiles.has(normalizedSource)) {
      continue
    }

    changedNodes.push({
      candidate,
      serialized: serializeChangedNode(candidate, normalizedSource, communityLabels, projectDir),
      normalizedSourceFile: normalizedSource,
      sourceRange: sourceRangeFromAttributes(attributes),
    })
  }

  return changedNodes.sort(compareChangedNodes)
}

function rangesOverlap(left: SourceLineRange, right: SourceLineRange): boolean {
  return left.start <= right.end && right.start <= left.end
}

function selectSeedNodes(
  changedNodes: ChangedGraphNode[],
  changedFiles: ParsedChangedFileRanges[],
  projectDir: string,
): PrImpactSeedNode[] {
  const seeds: PrImpactSeedNode[] = []
  const seen = new Set<string>()
  const changedFilesByNormalizedPath = new Map(
    changedFiles.map((changedFile) => [normalizeProjectPath(projectDir, changedFile.path), changedFile] as const),
  )

  const nodesByFile = new Map<string, ChangedGraphNode[]>()
  for (const changedNode of changedNodes) {
    const entries = nodesByFile.get(changedNode.normalizedSourceFile) ?? []
    entries.push(changedNode)
    nodesByFile.set(changedNode.normalizedSourceFile, entries)
  }

  for (const [normalizedSourceFile, fileNodes] of nodesByFile) {
    const changedFile = changedFilesByNormalizedPath.get(normalizedSourceFile)
    const lineRanges = changedFile?.lineRanges ?? []
    const lineMatches = fileNodes.filter((node) =>
      node.sourceRange !== null && lineRanges.some((range) => rangesOverlap(node.sourceRange as SourceLineRange, range)),
    )
    const selectedNodes = lineMatches.length > 0 ? lineMatches : fileNodes.slice(0, MAX_REVIEW_SEEDS)
    const matchKind: PrImpactSeedNode['match_kind'] = lineMatches.length > 0 ? 'line' : 'file'

    for (const node of selectedNodes) {
      if (seen.has(node.candidate.id)) {
        continue
      }
      seen.add(node.candidate.id)
      seeds.push({
        ...node.serialized,
        match_kind: matchKind,
      })
    }
  }

  return seeds
}

function relationWeight(relation: string): number {
  if (relation === 'calls') return 1.5
  if (relation === 'depends_on' || relation === 'imports_from') return 1.25
  if (relation === 'uses' || relation === 'references') return 1
  return 0.75
}

function buildReviewBundle(
  graph: KnowledgeGraph,
  seedNodes: readonly PrImpactSeedNode[],
  budget: number,
  communities: ReturnType<typeof communitiesFromGraph>,
  communityLabels: Record<number, string>,
  rootPath: string,
): PrReviewBundle {
  const candidateScores = new Map<string, number>()
  const candidateKinds = new Map<string, 'seed' | 'first_hop' | 'second_hop'>()
  const seedIds = new Set(seedNodes.map((node) => node.node_id))

  for (const seedNode of seedNodes) {
    candidateScores.set(seedNode.node_id, 10)
    candidateKinds.set(seedNode.node_id, 'seed')
  }

  const firstHopIds = new Set<string>()
  for (const seedNode of seedNodes) {
    for (const predecessor of graph.predecessors(seedNode.node_id)) {
      const relation = String(graph.edgeAttributes(predecessor, seedNode.node_id).relation ?? 'related_to')
      candidateScores.set(predecessor, Math.max(candidateScores.get(predecessor) ?? 0, 6 + relationWeight(relation)))
      if (!candidateKinds.has(predecessor)) {
        candidateKinds.set(predecessor, 'first_hop')
      }
      firstHopIds.add(predecessor)
    }

    for (const successor of graph.successors(seedNode.node_id)) {
      const relation = String(graph.edgeAttributes(seedNode.node_id, successor).relation ?? 'related_to')
      candidateScores.set(successor, Math.max(candidateScores.get(successor) ?? 0, 5 + relationWeight(relation)))
      if (!candidateKinds.has(successor)) {
        candidateKinds.set(successor, 'first_hop')
      }
      firstHopIds.add(successor)
    }
  }

  const secondHopExpansionRoots = [...firstHopIds]
    .filter((nodeId) => !seedIds.has(nodeId))
    .sort((left, right) =>
      (candidateScores.get(right) ?? 0) - (candidateScores.get(left) ?? 0)
      || graph.degree(right) - graph.degree(left)
      || left.localeCompare(right),
    )
    .slice(0, MAX_SECOND_HOP_CANDIDATES)

  const secondHopCandidates = new Map<string, { parentScore: number; paths: number }>()
  for (const nodeId of secondHopExpansionRoots) {
    for (const neighbor of graph.incidentNeighbors(nodeId)) {
      if (seedIds.has(neighbor) || firstHopIds.has(neighbor)) {
        continue
      }

      const entry = secondHopCandidates.get(neighbor) ?? { parentScore: 0, paths: 0 }
      entry.parentScore = Math.max(entry.parentScore, candidateScores.get(nodeId) ?? 0)
      entry.paths += 1
      secondHopCandidates.set(neighbor, entry)
    }
  }

  for (const [nodeId] of [...secondHopCandidates.entries()]
    .sort((left, right) =>
      right[1].parentScore - left[1].parentScore
      || right[1].paths - left[1].paths
      || graph.degree(right[0]) - graph.degree(left[0])
      || left[0].localeCompare(right[0]),
    )
    .slice(0, MAX_SECOND_HOP_CANDIDATES)) {
    candidateScores.set(nodeId, Math.max(candidateScores.get(nodeId) ?? 0, 2.5))
    if (!candidateKinds.has(nodeId)) {
      candidateKinds.set(nodeId, 'second_hop')
    }
  }

  const orderedCandidateIds = [...candidateScores.keys()].sort((left, right) => {
    const leftKind = candidateKinds.get(left)
    const rightKind = candidateKinds.get(right)
    const kindScore = (kind: typeof leftKind): number => kind === 'seed' ? 2 : kind === 'first_hop' ? 1 : 0
    return kindScore(rightKind) - kindScore(leftKind)
      || (candidateScores.get(right) ?? 0) - (candidateScores.get(left) ?? 0)
      || graph.degree(right) - graph.degree(left)
      || left.localeCompare(right)
  })

  const matchedNodes: RetrieveMatchedNode[] = []
  const includedIds = new Set<string>()
  const snippetFileCache = new Map<string, string[] | null>()
  let tokenCount = 0

  for (const candidateId of orderedCandidateIds) {
    const attributes = graph.nodeAttributes(candidateId)
    const candidate = candidateNodeFromGraphEntry(candidateId, attributes)
    if (!candidate.sourceFile) {
      continue
    }

    const normalizedSourceFile = normalizeProjectPath(rootPath, candidate.sourceFile)
    const snippet = readSnippet(normalizedSourceFile, candidate.lineNumber, {
      derived: candidate.lineNumberDerived,
      fileCache: snippetFileCache,
    })
    const serializedSourceFile = relativizeSourceFile(normalizedSourceFile, rootPath)
    const nodeTokens = estimateRetrieveEntryTokens(candidate.label, serializedSourceFile, candidate.lineNumber, snippet)
    if (tokenCount + nodeTokens > budget) {
      break
    }

    matchedNodes.push({
      node_id: candidate.id,
      label: candidate.label,
      source_file: serializedSourceFile,
      line_number: candidate.lineNumber,
      file_type: candidate.fileType,
      snippet,
      match_score: candidateScores.get(candidateId) ?? 0,
      relevance_band: seedIds.has(candidateId) ? 'direct' : candidateKinds.get(candidateId) === 'first_hop' ? 'related' : 'peripheral',
      community: candidate.community,
      community_label: candidate.community !== null ? (communityLabels[candidate.community] ?? null) : null,
      ...(candidate.nodeKind.trim().length > 0 ? { node_kind: candidate.nodeKind } : {}),
    })
    includedIds.add(candidateId)
    tokenCount += nodeTokens
  }

  const communityIds = new Set<number>()
  for (const node of matchedNodes) {
    if (node.community !== null) {
      communityIds.add(node.community)
    }
  }

  const communityContext: RetrieveCommunityContext[] = [...communityIds]
    .map((communityId) => ({
      id: communityId,
      label: communityLabels[communityId] ?? `Community ${communityId}`,
      node_count: (communities[communityId] ?? []).length,
    }))
    .sort((left, right) => right.node_count - left.node_count)

  return {
    budget,
    token_count: tokenCount,
    nodes: matchedNodes,
    relationships: collectRelationships(graph, includedIds),
    community_context: communityContext,
  }
}

export function analyzePrImpact(
  graph: KnowledgeGraph,
  projectDir = '.',
  options: PrImpactOptions = {},
): PrImpactResult {
  const resolvedDir = normalizeProjectPath('.', projectDir)
  const baseBranch = options.baseBranch ?? gitDetectBaseBranch(resolvedDir)
  const changedFiles = gitDiffFiles(resolvedDir, baseBranch)

  if (changedFiles.length === 0) {
    return {
      base_branch: baseBranch,
      changed_files: [],
      changed_ranges: [],
      changed_nodes: [],
      seed_nodes: [],
      per_node_impact: [],
      total_blast_radius: 0,
      affected_files: [],
      affected_communities: [],
      review_bundle: {
        budget: options.budget ?? DEFAULT_REVIEW_BUDGET,
        token_count: 0,
        nodes: [],
        relationships: [],
        community_context: [],
      },
      risk_summary: { high_impact_nodes: [], cross_community_changes: 0, top_risks: [] },
    }
  }

  const communities = communitiesFromGraph(graph)
  const communityLabels: Record<number, string> = {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabelsFromGraph(graph),
  }
  const changedNodes = findNodesInFiles(graph, changedFiles, resolvedDir, communityLabels)
  const seedNodes = selectSeedNodes(changedNodes, changedFiles, resolvedDir)
  const reviewBudget = options.budget ?? DEFAULT_REVIEW_BUDGET
  const reviewBundle = buildReviewBundle(graph, seedNodes, reviewBudget, communities, communityLabels, resolvedDir)
  const bridgeSet = new Set(workspaceBridges(graph, communities, communityLabels, 20).map((bridge) => bridge.label))
  const godSet = new Set(godNodes(graph, 20).map((node) => node.label))

  // Deduplicate by label for impact analysis — skip file-level nodes (e.g. "main.ts")
  const isFileNode = (label: string) => /\.\w{1,5}$/.test(label)
  const impactTargets = seedNodes.length > 0 ? seedNodes : changedNodes.map((node) => node.serialized)
  const uniqueImpactTargets = [...impactTargets.reduce((targets, node) => {
    if (!isFileNode(node.label) && !targets.has(node.label)) {
      targets.set(node.label, node)
    }
    return targets
  }, new Map<string, (typeof impactTargets)[number]>()).values()]

  const perNodeImpact: PrImpactResult['per_node_impact'] = []
  const allAffectedFiles = new Set<string>()
  const allAffectedCommunities = new Map<number, string>()
  const allAffectedNodeIds = new Set<string>()
  const highImpactNodes: string[] = []
  const rankedRisks = []

  for (const target of uniqueImpactTargets) {
    const label = target.label
    const impact: ImpactResult = analyzeImpact(graph, communityLabels, {
      label,
      depth: options.depth ?? 3,
    })

    perNodeImpact.push({
      node: label,
      direct_dependents: impact.direct_dependents.length,
      transitive_dependents: impact.transitive_dependents.length,
      affected_communities: impact.affected_communities.length,
    })

    for (const file of impact.affected_files) {
      allAffectedFiles.add(file)
    }

    for (const community of impact.affected_communities) {
      allAffectedCommunities.set(community.id, community.label)
    }

    for (const dep of [...impact.direct_dependents, ...impact.transitive_dependents]) {
      allAffectedNodeIds.add(dep.label)
    }

    if (impact.total_affected > 10) {
      highImpactNodes.push(label)
    }

    const hotspotKinds = [
      ...(bridgeSet.has(label) ? ['bridge'] : []),
      ...(godSet.has(label) ? ['god node'] : []),
    ]
    const dependentCount = graph.hasNode(target.node_id) ? graph.predecessors(target.node_id).length : 0
    rankedRisks.push(buildRankedRisk({
      label,
      totalAffected: impact.total_affected,
      affectedFiles: impact.affected_files.map((file) => relativizeSourceFile(file, resolvedDir)),
      affectedCommunities: impact.affected_communities.map((community) => community.label),
      hotspotKinds,
      dependentCount,
    }))
  }

  const changedCommunityIds = new Set(impactTargets.map((node) => node.community).filter((id): id is number => id !== null))

  return {
    base_branch: baseBranch,
    changed_files: changedFiles.map((changedFile) => changedFile.path),
    changed_ranges: changedFiles.map((changedFile) => ({
      source_file: changedFile.path,
      line_ranges: changedFile.lineRanges,
    })),
    changed_nodes: changedNodes.map((node) => node.serialized),
    seed_nodes: seedNodes,
    per_node_impact: perNodeImpact.sort((a, b) => (b.direct_dependents + b.transitive_dependents) - (a.direct_dependents + a.transitive_dependents)),
    total_blast_radius: allAffectedNodeIds.size,
    affected_files: [...allAffectedFiles].sort(),
    affected_communities: [...allAffectedCommunities.entries()]
      .map(([id, label]) => ({ id, label, node_count: communities[id]?.length ?? 0 }))
      .sort((a, b) => b.node_count - a.node_count),
    review_bundle: reviewBundle,
    risk_summary: {
      high_impact_nodes: highImpactNodes,
      cross_community_changes: changedCommunityIds.size,
      top_risks: rankedRisks
        .filter((risk) => risk.score > 0)
        .sort(compareRankedRisks)
        .slice(0, MAX_TOP_REVIEW_RISKS)
        .map(({ label, severity, reason }) => ({ label, severity, reason })),
    },
  }
}

export function compactPrImpactResult(result: PrImpactResult): CompactPrImpactResult {
  return {
    base_branch: result.base_branch,
    changed_files: result.changed_files,
    changed_ranges: result.changed_ranges,
    seed_nodes: result.seed_nodes,
    per_node_impact: result.per_node_impact
      .slice(0, MAX_COMPACT_PER_NODE_IMPACT)
      .map((impact) => ({
        node: impact.node,
        total_dependents: impact.direct_dependents + impact.transitive_dependents,
        affected_communities: impact.affected_communities,
      })),
    total_blast_radius: result.total_blast_radius,
    affected_communities: result.affected_communities,
    review_bundle: compactReviewBundle(result.review_bundle, result.seed_nodes),
    risk_summary: result.risk_summary,
  }
}
