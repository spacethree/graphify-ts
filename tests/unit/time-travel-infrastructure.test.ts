import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXTRACTOR_CACHE_VERSION } from '../../src/pipeline/extract.js'
import { compareRefs, loadOrBuildSnapshot, type CompareRefsDependencies, type SnapshotDependencies } from '../../src/infrastructure/time-travel.js'

const createdRoots = new Set<string>()

function createTestRoot(name: string): string {
  const root = resolve('.test-artifacts', `time-travel-infrastructure-${name}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
  mkdirSync(root, { recursive: true })
  createdRoots.add(root)
  return root
}

function writeGraphArtifacts(root: string, relativeDir: string, schemaVersion = 2): { graphPath: string; reportPath: string } {
  const outputDir = join(root, relativeDir, 'graphify-out')
  mkdirSync(outputDir, { recursive: true })
  const graphPath = join(outputDir, 'graph.json')
  const reportPath = join(outputDir, 'GRAPH_REPORT.md')
  writeFileSync(graphPath, JSON.stringify({
    schema_version: schemaVersion,
    extractor_version: EXTRACTOR_CACHE_VERSION,
    nodes: [],
    edges: [],
  }))
  writeFileSync(reportPath, '# report\n')
  return { graphPath, reportPath }
}

function writeCachedSnapshot(root: string, commitSha: string, schemaVersion = 2): void {
  const snapshotDir = join(root, 'graphify-out', 'time-travel', 'snapshots', commitSha)
  mkdirSync(snapshotDir, { recursive: true })
  writeFileSync(join(snapshotDir, 'graph.json'), JSON.stringify({
    schema_version: schemaVersion,
    extractor_version: EXTRACTOR_CACHE_VERSION,
    nodes: [],
    edges: [],
  }))
  writeFileSync(join(snapshotDir, 'GRAPH_REPORT.md'), '# cached report\n')
  writeFileSync(join(snapshotDir, 'metadata.json'), JSON.stringify({
    commitSha,
    extractorVersion: EXTRACTOR_CACHE_VERSION,
    schemaVersion,
  }))
}

function createSnapshotDependencies(rootDir: string): SnapshotDependencies & {
  git: {
    resolveRef: ReturnType<typeof vi.fn>
    createDetachedWorktree: ReturnType<typeof vi.fn>
    removeWorktree: ReturnType<typeof vi.fn>
  }
  generateGraph: ReturnType<typeof vi.fn>
  loadGraphExtractorVersion: ReturnType<typeof vi.fn>
} {
  const git = {
    resolveRef: vi.fn(async (ref: string) => {
      return ref === 'main' ? 'cached-sha' : 'generated-sha'
    }),
    createDetachedWorktree: vi.fn(async (worktreePath: string) => {
      writeGraphArtifacts(worktreePath, '.')
    }),
    removeWorktree: vi.fn(async () => {}),
  }

  const generateGraph = vi.fn((worktreePath: string) => {
    return {
      graphPath: join(worktreePath, 'graphify-out', 'graph.json'),
      reportPath: join(worktreePath, 'graphify-out', 'GRAPH_REPORT.md'),
    }
  })

  const loadGraphExtractorVersion = vi.fn(() => EXTRACTOR_CACHE_VERSION)

  return {
    rootDir,
    git,
    generateGraph,
    loadGraphExtractorVersion,
  }
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  createdRoots.clear()
})

describe('time travel infrastructure', () => {
  it('reuses an existing snapshot when cache metadata matches', async () => {
    const rootDir = createTestRoot('cache-hit')
    writeCachedSnapshot(rootDir, 'cached-sha')
    const deps = createSnapshotDependencies(rootDir)

    const result = await loadOrBuildSnapshot({ ref: 'main', refresh: false }, deps)

    expect(result.fromCache).toBe(true)
    expect(deps.generateGraph).not.toHaveBeenCalled()
    expect(deps.git.createDetachedWorktree).not.toHaveBeenCalled()
  })

  it('materializes a ref and builds a snapshot on cache miss', async () => {
    const rootDir = createTestRoot('cache-miss')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('commit-head-1')

    const result = await loadOrBuildSnapshot({ ref: 'HEAD~1', refresh: false }, deps)

    expect(deps.git.resolveRef).toHaveBeenCalledWith('HEAD~1')
    expect(deps.generateGraph).toHaveBeenCalled()
    expect(result.fromCache).toBe(false)
    expect(existsSync(join(rootDir, 'graphify-out', 'time-travel', 'snapshots', 'commit-head-1', 'graph.json'))).toBe(true)
    expect(deps.git.removeWorktree).toHaveBeenCalledTimes(1)
  })

  it('forces a rebuild when refresh is true', async () => {
    const rootDir = createTestRoot('refresh')
    writeCachedSnapshot(rootDir, 'tag-sha')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('tag-sha')

    const result = await loadOrBuildSnapshot({ ref: 'v0.8.3', refresh: true }, deps)

    expect(result.fromCache).toBe(false)
    expect(deps.generateGraph).toHaveBeenCalledTimes(1)
  })

  it('reuses an in-flight snapshot build for the same commit', async () => {
    const rootDir = createTestRoot('in-flight')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('shared-sha')

    let releaseBuild: (() => void) | null = null
    const buildStarted = new Promise<void>((resolveStarted) => {
      deps.generateGraph.mockImplementationOnce(async (worktreePath: string) => {
        resolveStarted()
        await new Promise<void>((resolveBuild) => {
          releaseBuild = resolveBuild
        })
        return {
          graphPath: join(worktreePath, 'graphify-out', 'graph.json'),
          reportPath: join(worktreePath, 'graphify-out', 'GRAPH_REPORT.md'),
        }
      })
    })

    const first = loadOrBuildSnapshot({ ref: 'main', refresh: false }, deps)
    await buildStarted
    const second = loadOrBuildSnapshot({ ref: 'origin/main', refresh: false }, deps)
    releaseBuild?.()

    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(deps.generateGraph).toHaveBeenCalledTimes(1)
    expect(firstResult.fromCache).toBe(false)
    expect(secondResult.fromCache).toBe(true)
    expect(secondResult.graphPath).toBe(firstResult.graphPath)
  })

  it('preserves the original failure when worktree cleanup also fails', async () => {
    const rootDir = createTestRoot('cleanup-failure')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('cleanup-sha')
    deps.generateGraph.mockImplementation(() => {
      throw new Error('build failed')
    })
    deps.git.removeWorktree.mockRejectedValue(new Error('cleanup failed'))

    await expect(loadOrBuildSnapshot({ ref: 'HEAD', refresh: false }, deps)).rejects.toThrow('build failed')
  })

  it('loads both snapshots and compares them through the runtime helper', async () => {
    const rootDir = createTestRoot('compare')
    writeCachedSnapshot(rootDir, 'from-sha')
    writeCachedSnapshot(rootDir, 'to-sha')
    const snapshotDeps = createSnapshotDependencies(rootDir)
    snapshotDeps.git.resolveRef
      .mockResolvedValueOnce('from-sha')
      .mockResolvedValueOnce('to-sha')

    const fromGraph = { id: 'from-graph' }
    const toGraph = { id: 'to-graph' }
    const expected = {
      fromRef: 'main',
      toRef: 'HEAD',
      view: 'risk',
      summary: { headline: 'headline', whyItMatters: [] },
      changed: { nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, communities: [] },
      risk: { topImpacts: [] },
      drift: { movedNodes: [] },
      timeline: { events: [] },
    }

    const deps: CompareRefsDependencies = {
      ...snapshotDeps,
      loadGraph: vi.fn((graphPath: string) => (graphPath.includes('from-sha') ? fromGraph : toGraph) as never),
      compareTimeTravelGraphs: vi.fn(() => expected),
    }

    const result = await compareRefs({ fromRef: 'main', toRef: 'HEAD', view: 'risk', limit: 3 }, deps)

    expect(result).toBe(expected)
    expect(deps.loadGraph).toHaveBeenCalledTimes(2)
    expect(deps.compareTimeTravelGraphs).toHaveBeenCalledWith(
      fromGraph,
      toGraph,
      expect.objectContaining({ fromRef: 'main', toRef: 'HEAD', view: 'risk', limit: 3 }),
    )
  })
})
