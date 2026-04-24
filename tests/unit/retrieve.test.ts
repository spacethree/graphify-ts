import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { retrieveContext, scoreNode, tokenizeLabel, tokenizeQuestion } from '../../src/runtime/retrieve.js'

describe('retrieve', () => {
  describe('tokenizeQuestion', () => {
    it('splits words and removes stop words', () => {
      const tokens = tokenizeQuestion('how does auth middleware work?')
      expect(tokens).toEqual(['auth', 'middleware', 'work'])
    })

    it('splits camelCase in questions', () => {
      const tokens = tokenizeQuestion('authenticateUser flow')
      expect(tokens).toEqual(['authenticate', 'user', 'flow'])
    })

    it('returns empty for all stop words', () => {
      expect(tokenizeQuestion('how does the')).toEqual([])
    })

    it('filters single character tokens', () => {
      expect(tokenizeQuestion('a b c auth')).toEqual(['auth'])
    })
  })

  describe('tokenizeLabel', () => {
    it('splits camelCase labels', () => {
      expect(tokenizeLabel('authenticateUser')).toEqual(['authenticate', 'user'])
    })

    it('splits snake_case labels', () => {
      expect(tokenizeLabel('session_manager')).toEqual(['session', 'manager'])
    })

    it('splits mixed separators', () => {
      expect(tokenizeLabel('auth-middleware.handler')).toEqual(['auth', 'middleware', 'handler'])
    })

    it('handles all lowercase', () => {
      expect(tokenizeLabel('database')).toEqual(['database'])
    })
  })

  describe('scoreNode', () => {
    it('scores prefix matches', () => {
      const score = scoreNode(['auth'], ['authenticate', 'user'])
      expect(score).toBe(1)
    })

    it('scores reverse prefix matches', () => {
      const score = scoreNode(['authentication'], ['auth'])
      expect(score).toBe(1)
    })

    it('scores zero for unrelated terms', () => {
      const score = scoreNode(['database'], ['authenticate', 'user'])
      expect(score).toBe(0)
    })

    it('scores multiple matches', () => {
      const score = scoreNode(['auth', 'user'], ['authenticate', 'user'])
      expect(score).toBe(2)
    })
  })

  describe('retrieveContext', () => {
    function buildTestGraph(): KnowledgeGraph {
      const graph = new KnowledgeGraph()

      graph.addNode('auth_user', {
        label: 'authenticateUser',
        source_file: '/src/auth.ts',
        line_number: 10,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('session_mgr', {
        label: 'SessionManager',
        source_file: '/src/session.ts',
        line_number: 5,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('db_conn', {
        label: 'DatabaseConnection',
        source_file: '/src/db.ts',
        line_number: 1,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })

      graph.addNode('user_model', {
        label: 'UserModel',
        source_file: '/src/models/user.ts',
        line_number: 3,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('logger', {
        label: 'Logger',
        source_file: '/src/utils/logger.ts',
        line_number: 1,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })

      graph.addEdge('auth_user', 'session_mgr', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
      graph.addEdge('auth_user', 'user_model', { relation: 'uses', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
      graph.addEdge('session_mgr', 'db_conn', { relation: 'depends_on', confidence: 'EXTRACTED', source_file: '/src/session.ts' })
      graph.addEdge('auth_user', 'logger', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })

      return graph
    }

    it('returns empty result for no matching tokens', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'how does the', budget: 5000 })

      expect(result.question).toBe('how does the')
      expect(result.token_count).toBe(0)
      expect(result.matched_nodes).toEqual([])
      expect(result.relationships).toEqual([])
    })

    it('matches nodes by label tokens', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth user', budget: 5000 })

      expect(result.matched_nodes.length).toBeGreaterThan(0)
      const labels = result.matched_nodes.map((n) => n.label)
      expect(labels).toContain('authenticateUser')
    })

    it('includes neighbors of matched nodes', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      const labels = result.matched_nodes.map((n) => n.label)
      expect(labels).toContain('authenticateUser')
      // SessionManager is a neighbor of authenticateUser
      expect(labels).toContain('SessionManager')
    })

    it('includes relationships between matched nodes', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      expect(result.relationships.length).toBeGreaterThan(0)
      const callsEdge = result.relationships.find((r) => r.from === 'authenticateUser' && r.to === 'SessionManager')
      expect(callsEdge).toBeDefined()
      expect(callsEdge?.relation).toBe('calls')
    })

    it('includes community context for matched nodes', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      expect(result.community_context.length).toBeGreaterThan(0)
      const community0 = result.community_context.find((c) => c.id === 0)
      expect(community0).toBeDefined()
    })

    it('respects community filter', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'database', budget: 5000, community: 1 })

      for (const node of result.matched_nodes) {
        expect(node.community).toBe(1)
      }
    })

    it('respects file type filter', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000, fileType: 'code' })

      for (const node of result.matched_nodes) {
        expect(node.file_type).toBe('code')
      }
    })

    it('respects token budget', () => {
      const graph = buildTestGraph()
      // Very small budget should limit results
      const smallResult = retrieveContext(graph, { question: 'auth', budget: 10 })
      const largeResult = retrieveContext(graph, { question: 'auth', budget: 50000 })

      expect(smallResult.matched_nodes.length).toBeLessThanOrEqual(largeResult.matched_nodes.length)
      // First node always included even if it exceeds budget
      expect(smallResult.token_count).toBeLessThan(largeResult.token_count)
    })

    it('returns token_count reflecting actual usage', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      expect(result.token_count).toBeGreaterThan(0)
      expect(result.token_count).toBeLessThanOrEqual(5000)
    })

    it('assigns higher match_score to direct matches than neighbors', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      const authNode = result.matched_nodes.find((n) => n.label === 'authenticateUser')
      const otherNodes = result.matched_nodes.filter((n) => n.label !== 'authenticateUser')

      expect(authNode).toBeDefined()
      expect(authNode!.match_score).toBeGreaterThan(0)
      for (const other of otherNodes) {
        expect(authNode!.match_score).toBeGreaterThanOrEqual(other.match_score)
      }
    })

    it('returns matches even when a query token appears in every node', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_service', { label: 'AuthService', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L1' })
      const result = retrieveContext(graph, { question: 'auth', budget: 3000 })

      expect(result.matched_nodes.length).toBeGreaterThan(0)
      expect(result.matched_nodes[0]!.match_score).toBeGreaterThan(0)
    })

    it('returns snippet as null when source file does not exist', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      // Files don't exist on disk in test, so all snippets should be null
      for (const node of result.matched_nodes) {
        expect(node.snippet).toBeNull()
      }
    })

    it('preserves question in result', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'how does auth work?', budget: 5000 })

      expect(result.question).toBe('how does auth work?')
    })
  })
})
