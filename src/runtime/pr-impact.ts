import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import { communitiesFromGraph } from './serve.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { analyzeImpact, type ImpactResult } from './impact.js'

const MAX_DIFF_BYTES = 5_000_000
const MAX_CHANGED_FILES = 200

export interface PrImpactOptions {
  baseBranch?: string
  depth?: number
}

export interface ChangedNode {
  label: string
  source_file: string
  node_kind: string
  community: number | null
  community_label: string | null
}

export interface PrImpactResult {
  base_branch: string
  changed_files: string[]
  changed_nodes: ChangedNode[]
  per_node_impact: Array<{
    node: string
    direct_dependents: number
    transitive_dependents: number
    affected_communities: number
  }>
  total_blast_radius: number
  affected_files: string[]
  affected_communities: Array<{ id: number; label: string; node_count: number }>
  risk_summary: {
    high_impact_nodes: string[]
    cross_community_changes: number
  }
}

function gitDiffNameOnly(projectDir: string, gitArgs: string[]): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', ...gitArgs], {
      cwd: projectDir,
      maxBuffer: MAX_DIFF_BYTES,
      encoding: 'utf8',
      timeout: 10_000,
    })

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

function gitDiffFiles(projectDir: string, baseBranch: string): string[] {
  // 1. Check for uncommitted changes (staged + unstaged) against HEAD
  const uncommitted = [
    ...gitDiffNameOnly(projectDir, ['HEAD']),           // unstaged + staged vs last commit
    ...gitDiffNameOnly(projectDir, ['--cached']),       // staged only (catches newly added files)
  ]

  // 2. Check for committed changes between branches
  const branchChanges = gitDiffNameOnly(projectDir, [`${baseBranch}...HEAD`])

  // Deduplicate and cap
  const allFiles = [...new Set([...uncommitted, ...branchChanges])]
  return allFiles.slice(0, MAX_CHANGED_FILES)
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

function findNodesInFiles(graph: KnowledgeGraph, changedFiles: string[], projectDir: string): ChangedNode[] {
  const normalizedFiles = new Set(changedFiles.map((file) => resolve(projectDir, file)))
  const changedNodes: ChangedNode[] = []

  for (const [, attributes] of graph.nodeEntries()) {
    const sourceFile = String(attributes.source_file ?? '')
    if (!sourceFile) {
      continue
    }

    const normalizedSource = resolve(sourceFile)
    if (!normalizedFiles.has(normalizedSource)) {
      continue
    }

    const community = parseCommunityId(attributes.community)
    changedNodes.push({
      label: String(attributes.label ?? ''),
      source_file: sourceFile,
      node_kind: String(attributes.node_kind ?? ''),
      community,
      community_label: null,
    })
  }

  return changedNodes
}

export function analyzePrImpact(
  graph: KnowledgeGraph,
  projectDir = '.',
  options: PrImpactOptions = {},
): PrImpactResult {
  const resolvedDir = resolve(projectDir)
  const baseBranch = options.baseBranch ?? gitDetectBaseBranch(resolvedDir)
  const changedFiles = gitDiffFiles(resolvedDir, baseBranch)

  if (changedFiles.length === 0) {
    return {
      base_branch: baseBranch,
      changed_files: [],
      changed_nodes: [],
      per_node_impact: [],
      total_blast_radius: 0,
      affected_files: [],
      affected_communities: [],
      risk_summary: { high_impact_nodes: [], cross_community_changes: 0 },
    }
  }

  const communities = communitiesFromGraph(graph)
  const communityLabels = buildCommunityLabels(graph, communities)
  const changedNodes = findNodesInFiles(graph, changedFiles, resolvedDir)

  for (const node of changedNodes) {
    if (node.community !== null) {
      node.community_label = communityLabels[node.community] ?? null
    }
  }

  // Deduplicate by label for impact analysis — skip file-level nodes (e.g. "main.ts")
  const isFileNode = (label: string) => /\.\w{1,5}$/.test(label)
  const uniqueLabels = [...new Set(changedNodes.filter((n) => !isFileNode(n.label)).map((n) => n.label))]

  const perNodeImpact: PrImpactResult['per_node_impact'] = []
  const allAffectedFiles = new Set<string>()
  const allAffectedCommunities = new Map<number, string>()
  const allAffectedNodeIds = new Set<string>()
  const highImpactNodes: string[] = []

  for (const label of uniqueLabels) {
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
  }

  const changedCommunityIds = new Set(changedNodes.map((n) => n.community).filter((id): id is number => id !== null))

  return {
    base_branch: baseBranch,
    changed_files: changedFiles,
    changed_nodes: changedNodes,
    per_node_impact: perNodeImpact.sort((a, b) => (b.direct_dependents + b.transitive_dependents) - (a.direct_dependents + a.transitive_dependents)),
    total_blast_radius: allAffectedNodeIds.size,
    affected_files: [...allAffectedFiles].sort(),
    affected_communities: [...allAffectedCommunities.entries()]
      .map(([id, label]) => ({ id, label, node_count: communities[id]?.length ?? 0 }))
      .sort((a, b) => b.node_count - a.node_count),
    risk_summary: {
      high_impact_nodes: highImpactNodes,
      cross_community_changes: changedCommunityIds.size,
    },
  }
}
