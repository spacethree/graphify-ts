import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { analyzeImpact, callChains } from '../../src/runtime/impact.js'

function buildTestGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('auth', { label: 'authenticateUser', source_file: '/src/auth.ts', node_kind: 'function', file_type: 'code', community: 0 })
  graph.addNode('session', { label: 'SessionManager', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('user', { label: 'UserModel', source_file: '/src/models/user.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('logger', { label: 'Logger', source_file: '/src/utils/logger.ts', node_kind: 'class', file_type: 'code', community: 3 })

  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('auth', 'user', { relation: 'uses', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/session.ts' })
  graph.addEdge('auth', 'logger', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })

  return graph
}

describe('impact', () => {
  describe('analyzeImpact', () => {
    it('finds direct dependents of a node', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'authenticateUser' })

      expect(result.target).toBe('authenticateUser')
      expect(result.direct_dependents.map((d) => d.label)).toEqual(['ApiHandler'])
    })

    it('finds transitive dependents at depth 2+', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      const transitiveLabels = result.transitive_dependents.map((d) => d.label)
      expect(transitiveLabels).toContain('authenticateUser')
      expect(transitiveLabels).toContain('ApiHandler')
    })

    it('reports affected files', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      expect(result.affected_files.length).toBeGreaterThan(0)
      expect(result.affected_files).toContain('/src/session.ts')
    })

    it('reports affected communities', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, { 0: 'Auth Module', 1: 'Database', 2: 'API Layer' }, { label: 'DatabaseConnection', depth: 3 })

      expect(result.affected_communities.length).toBeGreaterThan(0)
    })

    it('returns empty result for unknown label', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'nonexistent' })

      expect(result.total_affected).toBe(0)
      expect(result.direct_dependents).toEqual([])
    })

    it('respects depth limit', () => {
      const graph = buildTestGraph()
      const shallow = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 1 })
      const deep = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      expect(shallow.total_affected).toBeLessThanOrEqual(deep.total_affected)
      expect(shallow.transitive_dependents.length).toBe(0)
    })

    it('filters by edge types', () => {
      const graph = buildTestGraph()
      const callsOnly = analyzeImpact(graph, {}, { label: 'DatabaseConnection', edgeTypes: ['calls'] })
      const allEdges = analyzeImpact(graph, {}, { label: 'DatabaseConnection' })

      expect(callsOnly.total_affected).toBeLessThanOrEqual(allEdges.total_affected)
    })

    it('includes distance on each dependent', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      for (const dep of result.direct_dependents) {
        expect(dep.distance).toBe(1)
      }
      for (const dep of result.transitive_dependents) {
        expect(dep.distance).toBeGreaterThan(1)
      }
    })

    it('returns shortest path evidence per affected community', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, { 0: 'Auth Module', 2: 'API Layer' }, { label: 'SessionManager', depth: 3 })

      expect(result.top_paths_per_community).toEqual([
        {
          id: 0,
          label: 'Auth Module',
          distance: 1,
          path: ['SessionManager', 'authenticateUser'],
        },
        {
          id: 2,
          label: 'API Layer',
          distance: 2,
          path: ['SessionManager', 'authenticateUser', 'ApiHandler'],
        },
      ])
    })
  })

  describe('callChains', () => {
    it('finds execution paths between two nodes', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'ApiHandler', 'DatabaseConnection')

      expect(chains.length).toBeGreaterThan(0)
      // Should find: ApiHandler -> authenticateUser -> SessionManager -> DatabaseConnection
      const longChain = chains.find((c) => c.length === 4)
      expect(longChain).toBeDefined()
      expect(longChain![0]).toBe('ApiHandler')
      expect(longChain![longChain!.length - 1]).toBe('DatabaseConnection')
    })

    it('returns empty for unknown labels', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'Nonexistent1', 'Nonexistent2')

      expect(chains.length).toBe(0)
    })

    it('returns empty for single unknown label', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'nonexistent', 'DatabaseConnection')

      expect(chains.length).toBe(0)
    })

    it('respects max hops', () => {
      const graph = buildTestGraph()
      const short = callChains(graph, 'ApiHandler', 'DatabaseConnection', 2)
      const long = callChains(graph, 'ApiHandler', 'DatabaseConnection', 8)

      expect(short.length).toBeLessThanOrEqual(long.length)
    })

    it('returns chains sorted by length', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'ApiHandler', 'DatabaseConnection')

      for (let i = 1; i < chains.length; i++) {
        expect(chains[i]!.length).toBeGreaterThanOrEqual(chains[i - 1]!.length)
      }
    })
  })
})
