import { join } from 'node:path'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { build } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext, scoreNode, tokenWeightsForQuestion, tokenizeLabel, tokenizeQuestion } from '../../src/runtime/retrieve.js'

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

    function buildExpansionGraph(): KnowledgeGraph {
      const graph = new KnowledgeGraph()

      graph.addNode('auth_user', {
        label: 'authenticateUser',
        source_file: '/src/auth.ts',
        line_number: 10,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_flow_controller', {
        label: 'AuthFlowController',
        source_file: '/src/auth/flow-controller.ts',
        line_number: 20,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_guard', {
        label: 'AuthGuard',
        source_file: '/src/auth/guard.ts',
        line_number: 30,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_policy', {
        label: 'AuthPolicy',
        source_file: '/src/auth/policy.ts',
        line_number: 40,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('session_mgr', {
        label: 'SessionManager',
        source_file: '/src/session.ts',
        line_number: 5,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })
      graph.addNode('session_validator', {
        label: 'SessionValidator',
        source_file: '/src/session-validator.ts',
        line_number: 6,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })
      graph.addNode('session_router', {
        label: 'SessionRouter',
        source_file: '/src/session-router.ts',
        line_number: 7,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })
      graph.addNode('session_policy', {
        label: 'SessionPolicy',
        source_file: '/src/session-policy.ts',
        line_number: 8,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })

      graph.addNode('billing_store', {
        label: 'BillingStore',
        source_file: '/src/billing.ts',
        line_number: 9,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('billing_cache', {
        label: 'BillingCache',
        source_file: '/src/billing-cache.ts',
        line_number: 10,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('invoice_ledger', {
        label: 'InvoiceLedger',
        source_file: '/src/invoice-ledger.ts',
        line_number: 11,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('tax_rules', {
        label: 'TaxRules',
        source_file: '/src/tax-rules.ts',
        line_number: 12,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })

      graph.addEdge('auth_user', 'session_mgr', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
      graph.addEdge('auth_flow_controller', 'session_validator', {
        relation: 'imports_from',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/flow-controller.ts',
      })
      graph.addEdge('auth_guard', 'session_router', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/guard.ts',
      })
      graph.addEdge('auth_policy', 'session_policy', {
        relation: 'defines',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/policy.ts',
      })
      graph.addEdge('auth_guard', 'billing_store', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/guard.ts',
      })
      graph.addEdge('billing_store', 'billing_cache', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/billing.ts',
      })
      graph.addEdge('billing_store', 'invoice_ledger', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/billing.ts',
      })
      graph.addEdge('billing_store', 'tax_rules', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/billing.ts',
      })
      graph.graph.community_labels = {
        0: 'Authentication',
        1: 'Billing',
        2: 'Session',
      }

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

    it('ranks express route nodes first for route-shaped questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('route_users_show', {
        label: 'GET /users/:id',
        source_file: '/src/routes/users.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('require_auth', {
        label: 'requireAuth',
        source_file: '/src/middleware/auth.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('show_user', {
        label: 'showUser',
        source_file: '/src/controllers/users.ts',
        line_number: 7,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('require_auth', 'route_users_show', {
        relation: 'middleware',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/users.ts',
      })
      graph.addEdge('show_user', 'route_users_show', {
        relation: 'handles_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/users.ts',
      })
      graph.addEdge('route_users_show', 'require_auth', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/users.ts',
      })
      graph.addEdge('route_users_show', 'show_user', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/users.ts',
      })

      const result = retrieveContext(graph, {
        question: 'where is GET /users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('ranks mounted express route nodes by their propagated prefix', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-mounted-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-mounted-router-child.ts')),
      ])

      const result = retrieveContext(graph, {
        question: 'where is GET /api/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('ranks recursively mounted express route nodes by their propagated prefixes', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-nested-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-nested-router-child.ts')),
        extractJs(join(fixturesDir, 'express-nested-router-grandchild.ts')),
      ])

      const result = retrieveContext(graph, {
        question: 'where is GET /api/v1/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/v1/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('keeps direct symbol matches above path-only matches after structural boosts', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('direct_symbol', {
        label: 'LoginController',
        source_file: '/src/controllers.ts',
        line_number: 1,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('path_only', {
        label: 'RenderPage',
        source_file: '/src/login/handler.ts',
        line_number: 2,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('guide_a', {
        label: 'LoginHandlerGuideA',
        source_file: '/docs/login-a.md',
        line_number: 3,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_b', {
        label: 'LoginHandlerGuideB',
        source_file: '/docs/login-b.md',
        line_number: 4,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_c', {
        label: 'LoginHandlerGuideC',
        source_file: '/docs/login-c.md',
        line_number: 5,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_d', {
        label: 'LoginHandlerGuideD',
        source_file: '/docs/login-d.md',
        line_number: 6,
        node_kind: 'section',
        file_type: 'document',
        community: 1,
      })
      graph.addEdge('path_only', 'guide_a', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/login/handler.ts',
      })
      graph.addEdge('path_only', 'guide_d', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/login/handler.ts',
      })

      const result = retrieveContext(graph, { question: 'login', budget: 5000, fileType: 'code' })

      expect(result.matched_nodes.map((node) => node.label).slice(0, 2)).toEqual(['LoginController', 'RenderPage'])
      expect(result.matched_nodes.find((node) => node.label === 'LoginController')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === 'RenderPage')?.relevance_band).toBe('related')
    })

    it('keeps direct symbol matches above community-only matches after structural boosts', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('direct_symbol', {
        label: 'AuthGateway',
        source_file: '/src/auth.ts',
        line_number: 1,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('community_only', {
        label: 'SessionCoordinator',
        source_file: '/src/session.ts',
        line_number: 2,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('guide_a', {
        label: 'AuthGuideA',
        source_file: '/docs/auth-a.md',
        line_number: 3,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_b', {
        label: 'AuthGuideB',
        source_file: '/docs/auth-b.md',
        line_number: 4,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_c', {
        label: 'AuthGuideC',
        source_file: '/docs/auth-c.md',
        line_number: 5,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_d', {
        label: 'AuthGuideD',
        source_file: '/docs/auth-d.md',
        line_number: 6,
        node_kind: 'section',
        file_type: 'document',
        community: 1,
      })
      graph.addEdge('community_only', 'guide_a', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/session.ts',
      })
      graph.addEdge('community_only', 'guide_d', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/session.ts',
      })
      graph.graph.community_labels = { 0: 'Auth' }

      const result = retrieveContext(graph, { question: 'auth', budget: 5000, fileType: 'code' })

      expect(result.matched_nodes.map((node) => node.label).slice(0, 2)).toEqual(['AuthGateway', 'SessionCoordinator'])
      expect(result.matched_nodes.find((node) => node.label === 'AuthGateway')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === 'SessionCoordinator')?.relevance_band).toBe('related')
    })

    it('includes neighbors of matched nodes', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      const labels = result.matched_nodes.map((n) => n.label)
      expect(labels).toContain('authenticateUser')
      // SessionManager is a neighbor of authenticateUser
      expect(labels).toContain('SessionManager')
    })

    it('includes predecessors of matched nodes in directed graphs', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('caller', {
        label: 'CallerService',
        source_file: '/src/caller.ts',
        line_number: 1,
        node_kind: 'function',
        file_type: 'code',
      })
      graph.addNode('target', {
        label: 'TargetHandler',
        source_file: '/src/target.ts',
        line_number: 2,
        node_kind: 'function',
        file_type: 'code',
      })
      graph.addEdge('caller', 'target', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/caller.ts',
      })

      const result = retrieveContext(graph, { question: 'target', budget: 5000 })
      const labels = result.matched_nodes.map((node) => node.label)

      expect(labels).toContain('TargetHandler')
      expect(labels).toContain('CallerService')
      expect(result.matched_nodes.find((node) => node.label === 'CallerService')?.relevance_band).toBe('related')
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

    it('prefers calls and imports edges over generic second-hop expansion', () => {
      const graph = buildExpansionGraph()

      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })
      const labels = result.matched_nodes.map((node) => node.label)

      expect(labels).toContain('SessionValidator')
      expect(labels).toContain('SessionRouter')
      expect(labels).toContain('SessionManager')
      expect(labels).toContain('BillingCache')
      expect(labels).toContain('InvoiceLedger')
      expect(labels).toContain('TaxRules')
      expect(labels.indexOf('SessionValidator')).toBeLessThan(labels.indexOf('BillingCache'))
      expect(labels.indexOf('SessionRouter')).toBeLessThan(labels.indexOf('InvoiceLedger'))
      expect(labels.indexOf('SessionManager')).toBeLessThan(labels.indexOf('TaxRules'))
      expect(result.matched_nodes.find((node) => node.label === 'BillingCache')?.relevance_band).toBe('peripheral')
    })

    it('avoids promoting weak peripheral nodes when budget is tight', () => {
      const graph = buildExpansionGraph()

      const result = retrieveContext(graph, { question: 'auth flow', budget: 80 })
      const labels = result.matched_nodes.map((node) => node.label)

      expect(labels).toEqual(expect.arrayContaining(['authenticateUser']))
      expect(labels).not.toContain('BillingCache')
      expect(labels).not.toContain('InvoiceLedger')
      expect(labels).not.toContain('TaxRules')
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

    it('labels matched nodes with direct, related, and peripheral relevance bands', () => {
      const graph = buildTestGraph()
      graph.addNode('billing_store', {
        label: 'BillingStore',
        source_file: '/src/billing.ts',
        line_number: 2,
        node_kind: 'class',
        file_type: 'code',
      })
      graph.addEdge('session_mgr', 'billing_store', { relation: 'depends_on', confidence: 'EXTRACTED', source_file: '/src/session.ts' })
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      expect(result.matched_nodes.find((node) => node.label === 'authenticateUser')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === 'SessionManager')?.relevance_band).toBe('related')
      expect(result.matched_nodes.find((node) => node.label === 'BillingStore')?.relevance_band).toBe('peripheral')
    })
  })

  describe('tokenWeightsForQuestion', () => {
    it('reuses cached token weights for the same graph instance and query tokens', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_service', { label: 'AuthService' })
      graph.addNode('auth_controller', { label: 'AuthController' })

      const questionTokens = tokenizeQuestion('auth flow')
      const first = tokenWeightsForQuestion(graph, questionTokens)
      const second = tokenWeightsForQuestion(graph, questionTokens)
      const different = tokenWeightsForQuestion(graph, tokenizeQuestion('controller'))

      expect(second).toBe(first)
      expect(different).not.toBe(first)
    })
  })
})
