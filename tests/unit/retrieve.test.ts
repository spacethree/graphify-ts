import { join } from 'node:path'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { build } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { inspectReduxModuleExports } from '../../src/pipeline/extract/frameworks/redux.js'
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

    function stripFileNodes(extraction: ReturnType<typeof extractJs>): ReturnType<typeof extractJs> {
      const nodeIds = new Set(extraction.nodes.filter((node) => String(node.node_kind ?? '') !== '').map((node) => node.id))
      return {
        ...extraction,
        nodes: extraction.nodes.filter((node) => nodeIds.has(node.id)),
        edges: extraction.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
      }
    }

    function buildReduxAliasBaselineGraph(
      sliceExtraction: ReturnType<typeof extractJs>,
      storeExtraction: ReturnType<typeof extractJs>,
      sliceFilePath: string,
    ): KnowledgeGraph {
      const exportedBindings = inspectReduxModuleExports(sliceFilePath)
      const semanticSliceNode = sliceExtraction.nodes.find((node) => node.label === 'auth slice')
      const semanticSelectorNode = sliceExtraction.nodes.find((node) => node.label === 'selectAuthStatus')
      const semanticStoreNode = storeExtraction.nodes.find((node) => node.label === 'store')

      expect(semanticSliceNode).toBeDefined()
      expect(semanticSelectorNode).toBeDefined()
      expect(semanticStoreNode).toBeDefined()
      expect(exportedBindings.get('authSlice')).toBeDefined()
      expect(exportedBindings.get('authReducer')).toBeDefined()
      expect(exportedBindings.get('selectAuthStatus')).toBeDefined()

      const authSliceBinding = exportedBindings.get('authSlice')!
      const authReducerBinding = exportedBindings.get('authReducer')!
      const selectAuthStatusBinding = exportedBindings.get('selectAuthStatus')!

      return build(
        [
          {
            nodes: [
              {
                ...semanticStoreNode!,
                framework: undefined,
                framework_role: undefined,
              },
              {
                ...semanticSliceNode!,
                id: `${semanticSliceNode!.id}__authSlice`,
                label: 'authSlice',
                node_kind: 'function',
                framework: undefined,
                framework_role: undefined,
                line_number: authSliceBinding.line,
              },
              {
                ...semanticSliceNode!,
                id: `${semanticSliceNode!.id}__authReducer`,
                label: 'authReducer',
                node_kind: 'function',
                framework: undefined,
                framework_role: undefined,
                line_number: authReducerBinding.line,
              },
              {
                ...semanticSelectorNode!,
                id: `${semanticSelectorNode!.id}__selectAuthStatus`,
                label: 'selectAuthStatus',
                framework: undefined,
                framework_role: undefined,
                line_number: selectAuthStatusBinding.line,
              },
            ],
            edges: [
              {
                source: semanticStoreNode!.id,
                target: `${semanticSliceNode!.id}__authReducer`,
                relation: 'uses',
                confidence: 'INFERRED',
                source_file: semanticStoreNode!.source_file,
                line_number: semanticStoreNode!.line_number,
              },
              {
                source: `${semanticSliceNode!.id}__authSlice`,
                target: `${semanticSliceNode!.id}__authReducer`,
                relation: 'defines',
                confidence: 'INFERRED',
                source_file: authSliceBinding.sourceFile,
                line_number: authReducerBinding.line,
              },
              {
                source: `${semanticSliceNode!.id}__authSlice`,
                target: `${semanticSelectorNode!.id}__selectAuthStatus`,
                relation: 'uses',
                confidence: 'INFERRED',
                source_file: authSliceBinding.sourceFile,
                line_number: selectAuthStatusBinding.line,
              },
            ],
          },
        ],
        { directed: true },
      )
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

    it('prefers express route summaries for middleware-shaped questions over helper functions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('route_users_show', {
        label: 'GET /users/:id',
        source_file: '/src/routes/users.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('require_auth', {
        label: 'requireAuth',
        source_file: '/src/middleware/auth.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_middleware',
        community: 0,
      })
      graph.addNode('show_user', {
        label: 'showUser',
        source_file: '/src/controllers/users.ts',
        line_number: 7,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 0,
      })
      graph.addNode('auth_users_helper', {
        label: 'authUsersMiddlewareHelper',
        source_file: '/src/utils/auth-users.ts',
        line_number: 20,
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
      graph.addEdge('auth_users_helper', 'require_auth', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/auth-users.ts',
      })

      const result = retrieveContext(graph, {
        question: 'which express route uses auth middleware for users',
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
      expect(result.matched_nodes.slice(0, 3).map((node) => node.label)).toEqual(expect.arrayContaining(['requireAuth']))
      expect(result.matched_nodes.findIndex((node) => node.label === 'GET /users/:id')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'authUsersMiddlewareHelper'),
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

    it('ranks patch and all express route nodes by their verb labels', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([extractJs(join(fixturesDir, 'express-patch-all.ts'))])

      const patchResult = retrieveContext(graph, {
        question: 'where is PATCH /users/:id/profile defined',
        budget: 5000,
        fileType: 'code',
      })
      const allResult = retrieveContext(graph, {
        question: 'where is ALL /users/:id/audit defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(patchResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'PATCH /users/:id/profile',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(allResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'ALL /users/:id/audit',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('ranks routes registered on imported express owners without local express imports', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-imported-owner-router-child.ts')),
        extractJs(join(fixturesDir, 'express-imported-owner-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-imported-owner-app-child.ts')),
        extractJs(join(fixturesDir, 'express-imported-owner-app-parent.ts')),
      ])

      const namedResult = retrieveContext(graph, {
        question: 'where is GET /users/:id defined',
        budget: 5000,
        fileType: 'code',
      })
      const defaultResult = retrieveContext(graph, {
        question: 'where is POST /users defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(namedResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(defaultResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'POST /users',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('ranks module-object mounted express route nodes by their propagated prefixes', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const namespaceGraph = build([
        extractJs(join(fixturesDir, 'express-namespace-module-parent.ts')),
        extractJs(join(fixturesDir, 'express-namespace-module-child.ts')),
      ])
      const commonjsGraph = build([
        extractJs(join(fixturesDir, 'express-commonjs-module-parent.ts')),
        extractJs(join(fixturesDir, 'express-commonjs-module-child.ts')),
      ])

      const namespaceResult = retrieveContext(namespaceGraph, {
        question: 'where is GET /api/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })
      const commonjsResult = retrieveContext(commonjsGraph, {
        question: 'where is GET /api/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(namespaceResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(commonjsResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('answers auth slice questions from extracted redux toolkit graphs with fewer low-level baseline matches', () => {
      const sliceFilePath = join(process.cwd(), 'tests', 'fixtures', 'redux-retrieve-auth-slice.ts')
      const storeFilePath = join(process.cwd(), 'tests', 'fixtures', 'redux-retrieve-auth-store.ts')
      const semanticSliceExtraction = stripFileNodes(extractJs(sliceFilePath))
      const semanticStoreExtraction = stripFileNodes(extractJs(storeFilePath))
      const semanticGraph = build([semanticSliceExtraction, semanticStoreExtraction], { directed: true })
      const baselineGraph = buildReduxAliasBaselineGraph(semanticSliceExtraction, semanticStoreExtraction, sliceFilePath)

      const semanticResult = retrieveContext(semanticGraph, {
        question: 'which slice owns auth state',
        budget: 5000,
        fileType: 'code',
      })
      const baselineResult = retrieveContext(baselineGraph, {
        question: 'which slice owns auth state',
        budget: 5000,
        fileType: 'code',
      })

      const isLowLevelMatch = (label: string, nodeKind: string): boolean =>
        nodeKind !== 'slice' &&
        nodeKind !== 'store' &&
        tokenizeLabel(label).some((token) => ['auth', 'state', 'slice'].some((queryToken) => token.startsWith(queryToken) || queryToken.startsWith(token)))
      const semanticLowLevelMatches = semanticResult.matched_nodes.filter((node) => isLowLevelMatch(node.label, node.node_kind))
      const baselineLowLevelMatches = baselineResult.matched_nodes.filter((node) => isLowLevelMatch(node.label, node.node_kind))

      expect(semanticResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'auth slice',
          node_kind: 'slice',
          relevance_band: 'direct',
        }),
      )
      expect(semanticResult.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'auth slice',
            to: 'store',
            relation: 'registered_in_store',
          }),
        ]),
      )
      expect(semanticLowLevelMatches.map((node) => node.label)).toEqual(expect.arrayContaining(['selectAuthStatus']))
      expect(baselineLowLevelMatches.map((node) => node.label)).toEqual(
        expect.arrayContaining(['authSlice', 'authReducer', 'selectAuthStatus']),
      )
      expect(semanticLowLevelMatches.length).toBeLessThan(baselineLowLevelMatches.length)
      expect(semanticResult.token_count).toBeLessThan(baselineResult.token_count)
    })

    it('prefers redux slice and selector summaries over utility helpers for redux-shaped questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('auth_slice', {
        label: 'auth slice',
        source_file: '/src/state/authSlice.ts',
        line_number: 5,
        node_kind: 'slice',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_slice',
        community: 0,
      })
      graph.addNode('select_auth_status', {
        label: 'selectAuthStatus',
        source_file: '/src/state/authSlice.ts',
        line_number: 24,
        node_kind: 'function',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_selector',
        community: 0,
      })
      graph.addNode('store', {
        label: 'store',
        source_file: '/src/state/store.ts',
        line_number: 3,
        node_kind: 'store',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_store',
        community: 0,
      })
      graph.addNode('auth_state_helpers', {
        label: 'authStateHelpers',
        source_file: '/src/utils/authStateHelpers.ts',
        line_number: 9,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addEdge('auth_slice', 'select_auth_status', {
        relation: 'defines_selector',
        confidence: 'EXTRACTED',
        source_file: '/src/state/authSlice.ts',
      })
      graph.addEdge('auth_slice', 'store', {
        relation: 'registered_in_store',
        confidence: 'EXTRACTED',
        source_file: '/src/state/store.ts',
      })
      graph.addEdge('auth_state_helpers', 'select_auth_status', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/authStateHelpers.ts',
      })

      const result = retrieveContext(graph, {
        question: 'which redux selector reads auth state',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes.slice(0, 2).map((node) => node.label)).toEqual(
        expect.arrayContaining(['auth slice', 'selectAuthStatus']),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === 'auth slice')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'authStateHelpers'),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === 'selectAuthStatus')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'authStateHelpers'),
      )
    })

    it('does not boost redux metadata for non-framework-shaped questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('auth_status_helper', {
        label: 'AuthStatus',
        source_file: '/src/utils/auth-status.ts',
        line_number: 8,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_status_selector', {
        label: 'AuthStatus',
        source_file: '/src/state/auth-status.ts',
        line_number: 12,
        node_kind: 'function',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_selector',
        community: 0,
      })
      graph.addNode('status_formatter', {
        label: 'StatusFormatter',
        source_file: '/src/utils/status-formatter.ts',
        line_number: 18,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('status_labels', {
        label: 'statusLabels',
        source_file: '/src/utils/status-labels.ts',
        line_number: 4,
        node_kind: 'variable',
        file_type: 'code',
        community: 0,
      })

      graph.addEdge('status_formatter', 'auth_status_helper', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/status-formatter.ts',
      })
      graph.addEdge('status_labels', 'auth_status_helper', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/status-labels.ts',
      })

      const result = retrieveContext(graph, {
        question: 'auth status',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'AuthStatus',
          source_file: '/src/utils/auth-status.ts',
        }),
      )
      expect(result.matched_nodes.findIndex((node) => node.source_file === '/src/utils/auth-status.ts')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.source_file === '/src/state/auth-status.ts'),
      )
    })

    it('does not treat a generic path query as framework-shaped', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('path_builder', {
        label: 'PathBuilder',
        source_file: '/src/utils/path-builder.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('settings_route', {
        label: '/settings/path',
        source_file: '/src/routes/settings.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })

      const result = retrieveContext(graph, {
        question: 'path',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes.slice(0, 2).map((node) => node.label)).toEqual(['PathBuilder', '/settings/path'])
      expect(result.matched_nodes.find((node) => node.label === 'PathBuilder')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === '/settings/path')?.relevance_band).toBe('direct')
    })

    it('answers route rendering questions with extracted react router route semantics', () => {
      const routerFilePath = join(process.cwd(), 'tests', 'fixtures', 'react-router-imported-router.tsx')
      const moduleFilePath = join(process.cwd(), 'tests', 'fixtures', 'react-router-imported-module.tsx')
      const semanticExtraction = extractJs(routerFilePath)
      const semanticNodeIds = new Set(
        semanticExtraction.nodes.filter((node) => node.label !== 'react-router-imported-router.tsx').map((node) => node.id),
      )
      const semanticGraph = build(
        [
          {
            ...semanticExtraction,
            nodes: semanticExtraction.nodes.filter((node) => semanticNodeIds.has(node.id)),
            edges: semanticExtraction.edges.filter((edge) => semanticNodeIds.has(edge.source) && semanticNodeIds.has(edge.target)),
          },
        ],
        { directed: true },
      )

      const baselineGraph = new KnowledgeGraph({ directed: true })
      baselineGraph.addNode('router_variable', {
        label: 'router',
        source_file: routerFilePath,
        line_number: 1,
        node_kind: 'variable',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addNode('settings_page_component', {
        label: 'SettingsPage()',
        source_file: moduleFilePath,
        line_number: 2,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addNode('settings_loader_baseline', {
        label: 'settingsLoader()',
        source_file: moduleFilePath,
        line_number: 12,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addNode('settings_action_baseline', {
        label: 'settingsAction()',
        source_file: moduleFilePath,
        line_number: 16,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addEdge('router_variable', 'settings_page_component', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: routerFilePath,
      })
      baselineGraph.addEdge('router_variable', 'settings_loader_baseline', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: routerFilePath,
      })
      baselineGraph.addEdge('router_variable', 'settings_action_baseline', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: routerFilePath,
      })

      const semanticResult = retrieveContext(semanticGraph, {
        question: 'which route renders settings page',
        budget: 5000,
        fileType: 'code',
      })
      const baselineResult = retrieveContext(baselineGraph, {
        question: 'which route renders settings page',
        budget: 5000,
        fileType: 'code',
      })
      const semanticLowLevelMatches = semanticResult.matched_nodes.filter(
        (node) => node.node_kind !== 'route' && node.node_kind !== 'router',
      )
      const baselineLowLevelMatches = baselineResult.matched_nodes

      expect(semanticResult.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: '/settings',
            node_kind: 'route',
            relevance_band: 'direct',
          }),
        ]),
      )
      expect(baselineResult.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'router',
          }),
        ]),
      )
      expect(semanticResult.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: '/settings', to: 'SettingsPage()', relation: 'renders' }),
        ]),
      )
      expect(semanticLowLevelMatches).toHaveLength(3)
      expect(baselineLowLevelMatches.map((node) => node.label)).toEqual(
        expect.arrayContaining(['router', 'SettingsPage()', 'settingsLoader()', 'settingsAction()']),
      )
      expect(semanticLowLevelMatches.length).toBeLessThan(baselineLowLevelMatches.length)
    })

    it('keeps framework boosts for framework-shaped react router path questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('settings_route', {
        label: '/settings/path',
        source_file: '/src/routes/settings.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('settings_page', {
        label: 'SettingsPage',
        source_file: '/src/routes/settings-page.tsx',
        line_number: 20,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addNode('path_builder', {
        label: 'PathBuilder',
        source_file: '/src/utils/path-builder.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('settings_route', 'settings_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which react router path renders settings page',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: '/settings/path',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(result.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: '/settings/path', to: 'SettingsPage', relation: 'renders' }),
        ]),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === '/settings/path')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'PathBuilder'),
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
