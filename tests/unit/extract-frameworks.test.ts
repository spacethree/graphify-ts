import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as ts from 'typescript'

import { build, buildFromJson } from '../../src/pipeline/build.js'
import { _makeId, createEdge, createNode } from '../../src/pipeline/extract/core.js'
import { applyJsFrameworkAdapters } from '../../src/pipeline/extract/frameworks/core.js'
import type { ExtractionFragment } from '../../src/pipeline/extract/dispatch.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from '../../src/pipeline/extract/frameworks/types.js'
import { extractJs } from '../../src/pipeline/extract.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function createFrameworkContext(filePath: string, sourceText: string, baseExtraction: ExtractionFragment): JsFrameworkContext {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : filePath.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS

  return {
    filePath,
    sourceText,
    sourceFile: ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind),
    stem: 'app',
    fileNodeId: _makeId('app'),
    isJsxFile: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
    baseExtraction,
  }
}

function createBaseExtraction(filePath: string, stem: string, labels: readonly string[]): ExtractionFragment {
  return {
    nodes: [
      createNode(_makeId(stem), `${stem}.ts`, filePath, 1),
      ...labels.map((label, index) => createNode(_makeId(stem, label), label, filePath, index + 2)),
    ],
    edges: [],
  }
}

function nodeIdForLabel(fragment: ExtractionFragment, label: string): string {
  const nodeId = fragment.nodes?.find((node) => node.label === label)?.id
  expect(nodeId).toBeDefined()
  return nodeId!
}

function graphNodeIdForLabel(graph: ReturnType<typeof build>, label: string): string {
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    if (attributes.label === label) {
      return nodeId
    }
  }
  throw new Error(`Missing graph node for label: ${label}`)
}

describe('js framework extraction contract', () => {
  it('returns no extra nodes for plain ts utility files', () => {
    const filePath = join(FIXTURES_DIR, 'sample.ts')
    const result = extractJs(filePath)

    expect(result.nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining(['sample.ts', 'HttpClient', '.constructor()', '.get()', '.post()', 'buildHeaders()']),
    )
    expect(result.nodes).toHaveLength(6)
    expect(result.edges.filter((edge) => edge.relation.startsWith('framework_'))).toHaveLength(0)
  })

  it('accepts js/ts ast context and keeps emitted nodes through graph building', () => {
    const filePath = join(FIXTURES_DIR, 'app.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const routeNodeId = _makeId('app', 'route')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-route',
      matches(candidatePath, candidateSourceText) {
        return candidatePath === filePath && candidateSourceText === sourceText
      },
      extract(context) {
        expect(context.filePath).toBe(filePath)
        expect(context.sourceText).toBe(sourceText)
        expect(context.sourceFile.fileName).toBe(filePath)
        expect(ts.isSourceFile(context.sourceFile)).toBe(true)
        expect(context.baseExtraction).toEqual(baseExtraction)

        return {
          nodes: [createNode(routeNodeId, 'AppRoute', filePath, 1)],
          edges: [createEdge(context.fileNodeId, routeNodeId, 'framework_declares_route', filePath, 1)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildFromJson({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(result.nodes.find((node) => node.id === routeNodeId)?.label).toBe('AppRoute')
    expect(graph.hasNode(routeNodeId)).toBe(true)
    expect(graph.edgeAttributes(fileNodeId, routeNodeId).relation).toBe('framework_declares_route')
  })

  it('allows adapters to augment existing nodes with additional attributes', () => {
    const filePath = join(FIXTURES_DIR, 'app.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const componentNodeId = _makeId('app', 'app')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1), createNode(componentNodeId, 'App', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-augmentation',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [
            {
              ...createNode(componentNodeId, 'App', filePath, 1),
              node_kind: 'component',
              framework_role: 'root',
            },
          ],
          edges: [],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildFromJson({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(result.nodes.find((node) => node.id === componentNodeId)).toEqual(
      expect.objectContaining({
        id: componentNodeId,
        label: 'App',
        node_kind: 'component',
        framework_role: 'root',
      }),
    )
    expect(graph.nodeAttributes(componentNodeId)).toEqual(
      expect.objectContaining({
        label: 'App',
        node_kind: 'component',
        framework_role: 'root',
      }),
    )
  })

  it('preserves stable explicit relation names from framework adapters', () => {
    const filePath = join(FIXTURES_DIR, 'router.tsx')
    const sourceText = readFileSync(join(FIXTURES_DIR, 'sample.ts'), 'utf8')
    const fileNodeId = _makeId('app')
    const routerNodeId = _makeId('app', 'router')
    const providerNodeId = _makeId('app', 'provider')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'router.tsx', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-relations',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [createNode(routerNodeId, 'AppRouter', filePath, 1), createNode(providerNodeId, 'RouterProvider', filePath, 1)],
          edges: [
            createEdge(fileNodeId, routerNodeId, 'framework_registers_router', filePath, 1),
            createEdge(routerNodeId, providerNodeId, 'framework_renders_provider', filePath, 1),
          ],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: fileNodeId, target: routerNodeId, relation: 'framework_registers_router' }),
        expect.objectContaining({ source: routerNodeId, target: providerNodeId, relation: 'framework_renders_provider' }),
      ]),
    )
  })

  it('does not let same-pair framework edges replace baseline relations in the default undirected graph build', () => {
    const filePath = join(FIXTURES_DIR, 'router.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const componentNodeId = _makeId('app', 'component')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1), createNode(componentNodeId, 'App', filePath, 1)],
      edges: [createEdge(fileNodeId, componentNodeId, 'declares', filePath, 1)],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-edge-collision',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [],
          edges: [createEdge(fileNodeId, componentNodeId, 'framework_declares_component', filePath, 2)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildFromJson({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(graph.edgeAttributes(fileNodeId, componentNodeId)).toEqual(
      expect.objectContaining({
        relation: 'declares',
      }),
    )
  })

  it('preserves reverse-direction framework edges in extraction output while keeping the baseline relation in the default undirected build', () => {
    const filePath = join(FIXTURES_DIR, 'router.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const componentNodeId = _makeId('app', 'component')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1), createNode(componentNodeId, 'App', filePath, 1)],
      edges: [createEdge(fileNodeId, componentNodeId, 'declares', filePath, 1)],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-reverse-edge-collision',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [],
          edges: [createEdge(componentNodeId, fileNodeId, 'framework_references_component', filePath, 2)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildFromJson({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(result.edges.filter((edge) => new Set([edge.source, edge.target]).size === 2)).toEqual([
      expect.objectContaining({ source: componentNodeId, target: fileNodeId, relation: 'framework_references_component' }),
      expect.objectContaining({ source: fileNodeId, target: componentNodeId, relation: 'declares' }),
    ])
    expect(graph.edgeAttributes(fileNodeId, componentNodeId)).toEqual(
      expect.objectContaining({
        relation: 'declares',
      }),
    )
  })

  it('preserves reverse-direction framework edges for directed graph builds', () => {
    const filePath = join(FIXTURES_DIR, 'router.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const componentNodeId = _makeId('app', 'component')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1), createNode(componentNodeId, 'App', filePath, 1)],
      edges: [createEdge(fileNodeId, componentNodeId, 'declares', filePath, 1)],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-directed-reverse-edge',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [],
          edges: [createEdge(componentNodeId, fileNodeId, 'framework_references_component', filePath, 2)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildFromJson(
      {
        nodes: result.nodes,
        edges: result.edges,
      },
      { directed: true },
    )

    expect(result.edges.filter((edge) => new Set([edge.source, edge.target]).size === 2)).toEqual([
      expect.objectContaining({ source: componentNodeId, target: fileNodeId, relation: 'framework_references_component' }),
      expect.objectContaining({ source: fileNodeId, target: componentNodeId, relation: 'declares' }),
    ])
    expect(graph.edgeAttributes(fileNodeId, componentNodeId)).toEqual(
      expect.objectContaining({
        relation: 'declares',
      }),
    )
    expect(graph.edgeAttributes(componentNodeId, fileNodeId)).toEqual(
      expect.objectContaining({
        relation: 'framework_references_component',
      }),
    )
  })

  it('preserves framework-scoped cross-file edges until the combined graph contains their targets', () => {
    const filePath = join(FIXTURES_DIR, 'app.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const routeNodeId = _makeId('routes', 'app-route')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-cross-file-edge',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [],
          edges: [createEdge(fileNodeId, routeNodeId, 'framework_registers_route', filePath, 2)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])

    expect(result.edges).toEqual([
      expect.objectContaining({
        source: fileNodeId,
        target: routeNodeId,
        relation: 'framework_registers_route',
      }),
    ])

    const graph = build([
      {
        schema_version: 1,
        nodes: result.nodes,
        edges: result.edges,
      },
      {
        schema_version: 1,
        nodes: [createNode(routeNodeId, 'AppRoute', join(FIXTURES_DIR, 'routes.ts'), 1)],
        edges: [],
      },
    ])

    expect(graph.hasNode(routeNodeId)).toBe(true)
    expect(graph.edgeAttributes(fileNodeId, routeNodeId)).toEqual(
      expect.objectContaining({
        relation: 'framework_registers_route',
      }),
    )
  })

  it('extracts express routes, middleware, handlers, and same-file router mounts', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-app.ts')
    const sourceText = [
      "import express from 'express'",
      '',
      'function requireAuth(_req: unknown, _res: unknown, next: () => void) {',
      '  next()',
      '}',
      '',
      'const auditTrail = (_req: unknown, _res: unknown, next: () => void) => next()',
      '',
      'function showUser() {}',
      'function createUser() {}',
      'function updateUser() {}',
      'function patchUser() {}',
      'function replaceUser() {}',
      'function removeUser() {}',
      'function fallbackHandler() {}',
      '',
      'const app = express()',
      'const router = express.Router()',
      '',
      "app.use('/api', requireAuth, [auditTrail], router)",
      "app.get('/health', (_req: unknown, _res: unknown) => {})",
      "app.post('/users', requireAuth, createUser)",
      "app.patch('/users/:id/profile', requireAuth, patchUser)",
      "app.put('/users/:id/profile', requireAuth, replaceUser)",
      "app.delete('/users/:id/profile', requireAuth, removeUser)",
      "app.all('/users/:id/audit', requireAuth, fallbackHandler)",
      "app.route('/users/:id').put([requireAuth], updateUser).delete(controller(showUser))",
      '',
      "router.get('/profile/:id', auditTrail, showUser)",
      "router.post('/users/:id/notes', auditTrail, createUser)",
      "router.use('/errors/:id', requireAuth, function onUserError(_err: unknown, _req: unknown, _res: unknown, next: () => void) {",
      '  next()',
      '})',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-app', [
      'requireAuth',
      'auditTrail',
      'showUser',
      'createUser',
      'updateUser',
      'patchUser',
      'replaceUser',
      'removeUser',
      'fallbackHandler',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'app', node_kind: 'router', framework_role: 'express_app' }),
        expect.objectContaining({ label: 'router', node_kind: 'router', framework_role: 'express_router' }),
        expect.objectContaining({ label: 'requireAuth', node_kind: 'function', framework_role: 'express_middleware' }),
        expect.objectContaining({ label: 'createUser', node_kind: 'function', framework_role: 'express_handler' }),
        expect.objectContaining({ label: 'inline handles_route GET /health', node_kind: 'function', framework_role: 'express_handler' }),
        expect.objectContaining({ label: 'onUserError', node_kind: 'function', framework_role: 'express_error_middleware' }),
        expect.objectContaining({ label: 'USE /api', node_kind: 'route', http_method: 'USE', route_path: '/api' }),
        expect.objectContaining({ label: 'GET /health', node_kind: 'route', http_method: 'GET', route_path: '/health' }),
        expect.objectContaining({ label: 'POST /users', node_kind: 'route', http_method: 'POST', route_path: '/users' }),
        expect.objectContaining({ label: 'PATCH /users/:id/profile', node_kind: 'route', http_method: 'PATCH', route_path: '/users/:id/profile' }),
        expect.objectContaining({ label: 'PUT /users/:id/profile', node_kind: 'route', http_method: 'PUT', route_path: '/users/:id/profile' }),
        expect.objectContaining({ label: 'DELETE /users/:id/profile', node_kind: 'route', http_method: 'DELETE', route_path: '/users/:id/profile' }),
        expect.objectContaining({ label: 'ALL /users/:id/audit', node_kind: 'route', http_method: 'ALL', route_path: '/users/:id/audit' }),
        expect.objectContaining({ label: 'PUT /users/:id', node_kind: 'route', http_method: 'PUT', route_path: '/users/:id' }),
        expect.objectContaining({ label: 'DELETE /users/:id', node_kind: 'route', http_method: 'DELETE', route_path: '/users/:id' }),
        expect.objectContaining({ label: 'GET /profile/:id', node_kind: 'route', http_method: 'GET', route_path: '/profile/:id' }),
        expect.objectContaining({ label: 'POST /users/:id/notes', node_kind: 'route', http_method: 'POST', route_path: '/users/:id/notes' }),
        expect.objectContaining({ label: 'USE /errors/:id', node_kind: 'route', http_method: 'USE', route_path: '/errors/:id' }),
      ]),
    )

    const appNodeId = nodeIdForLabel(result, 'app')
    const routerNodeId = nodeIdForLabel(result, 'router')
    const useApiRouteId = nodeIdForLabel(result, 'USE /api')
    const getHealthRouteId = nodeIdForLabel(result, 'GET /health')
    const getHealthInlineHandlerId = nodeIdForLabel(result, 'inline handles_route GET /health')
    const postUsersRouteId = nodeIdForLabel(result, 'POST /users')
    const patchProfileRouteId = nodeIdForLabel(result, 'PATCH /users/:id/profile')
    const putProfileRouteId = nodeIdForLabel(result, 'PUT /users/:id/profile')
    const deleteProfileRouteId = nodeIdForLabel(result, 'DELETE /users/:id/profile')
    const allAuditRouteId = nodeIdForLabel(result, 'ALL /users/:id/audit')
    const putUsersRouteId = nodeIdForLabel(result, 'PUT /users/:id')
    const deleteUsersRouteId = nodeIdForLabel(result, 'DELETE /users/:id')
    const getProfileRouteId = nodeIdForLabel(result, 'GET /profile/:id')
    const postNotesRouteId = nodeIdForLabel(result, 'POST /users/:id/notes')
    const useErrorsRouteId = nodeIdForLabel(result, 'USE /errors/:id')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: routerNodeId, relation: 'mounts_router' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: useApiRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'auditTrail'), target: useApiRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: getHealthInlineHandlerId, target: getHealthRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: getHealthRouteId, target: getHealthInlineHandlerId, relation: 'contains' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: postUsersRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'createUser'), target: postUsersRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: patchProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'patchUser'), target: patchProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: putProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'replaceUser'), target: putProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: deleteProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'removeUser'), target: deleteProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: allAuditRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'fallbackHandler'), target: allAuditRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: putUsersRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'updateUser'), target: putUsersRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'showUser'), target: deleteUsersRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'auditTrail'), target: getProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'showUser'), target: getProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'auditTrail'), target: postNotesRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'createUser'), target: postNotesRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: useErrorsRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'onUserError'), target: useErrorsRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: appNodeId, target: getHealthRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: routerNodeId, target: getProfileRouteId, relation: 'registers_route' }),
      ]),
    )
  })

  it('preserves imported express router mounts until the mounted router node is available', () => {
    const appFilePath = join(FIXTURES_DIR, 'virtual-express-parent.ts')
    const routesFilePath = join(FIXTURES_DIR, 'virtual-express-child.ts')
    const appSourceText = readFileSync(appFilePath, 'utf8')
    const routesSourceText = readFileSync(routesFilePath, 'utf8')
    const appBaseExtraction = createBaseExtraction(appFilePath, 'virtual-express-parent', [])
    const routesBaseExtraction = createBaseExtraction(routesFilePath, 'virtual-express-child', ['listUser'])

    const appResult = applyJsFrameworkAdapters(
      appBaseExtraction,
      createFrameworkContext(appFilePath, appSourceText, appBaseExtraction),
    )
    const routesResult = applyJsFrameworkAdapters(
      routesBaseExtraction,
      createFrameworkContext(routesFilePath, routesSourceText, routesBaseExtraction),
    )

    const appNodeId = nodeIdForLabel(appResult, 'app')
    const apiRouterNodeId = nodeIdForLabel(routesResult, 'apiRouter')

    expect(appResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: apiRouterNodeId, relation: 'mounts_router' }),
      ]),
    )

    const graph = build([
      {
        schema_version: 1,
        nodes: appResult.nodes ?? [],
        edges: appResult.edges ?? [],
      },
      {
        schema_version: 1,
        nodes: routesResult.nodes ?? [],
        edges: routesResult.edges ?? [],
      },
    ])

    expect(graph.hasNode(apiRouterNodeId)).toBe(true)
    expect(graph.edgeAttributes(appNodeId, apiRouterNodeId)).toEqual(
      expect.objectContaining({
        relation: 'mounts_router',
      }),
    )
  })

  it('preserves imported express router mounts for default imports and CommonJS require bindings', () => {
    const defaultAppFilePath = join(FIXTURES_DIR, 'express-default-import-parent.ts')
    const defaultRoutesFilePath = join(FIXTURES_DIR, 'express-default-import-child.ts')
    const requireAppFilePath = join(FIXTURES_DIR, 'express-commonjs-parent.ts')
    const requireRoutesFilePath = join(FIXTURES_DIR, 'express-commonjs-child.ts')

    const defaultAppSourceText = readFileSync(defaultAppFilePath, 'utf8')
    const defaultRoutesSourceText = readFileSync(defaultRoutesFilePath, 'utf8')
    const requireAppSourceText = readFileSync(requireAppFilePath, 'utf8')
    const requireRoutesSourceText = readFileSync(requireRoutesFilePath, 'utf8')

    const defaultAppBaseExtraction = createBaseExtraction(defaultAppFilePath, 'virtual-express-default-parent', [])
    const defaultRoutesBaseExtraction = createBaseExtraction(defaultRoutesFilePath, 'virtual-express-default-child', ['listUser'])
    const requireAppBaseExtraction = createBaseExtraction(requireAppFilePath, 'virtual-express-require-parent', [])
    const requireRoutesBaseExtraction = createBaseExtraction(requireRoutesFilePath, 'virtual-express-require-child', ['listUser'])

    const defaultAppResult = applyJsFrameworkAdapters(
      defaultAppBaseExtraction,
      createFrameworkContext(defaultAppFilePath, defaultAppSourceText, defaultAppBaseExtraction),
    )
    const defaultRoutesResult = applyJsFrameworkAdapters(
      defaultRoutesBaseExtraction,
      createFrameworkContext(defaultRoutesFilePath, defaultRoutesSourceText, defaultRoutesBaseExtraction),
    )
    const requireAppResult = applyJsFrameworkAdapters(
      requireAppBaseExtraction,
      createFrameworkContext(requireAppFilePath, requireAppSourceText, requireAppBaseExtraction),
    )
    const requireRoutesResult = applyJsFrameworkAdapters(
      requireRoutesBaseExtraction,
      createFrameworkContext(requireRoutesFilePath, requireRoutesSourceText, requireRoutesBaseExtraction),
    )

    const defaultAppNodeId = nodeIdForLabel(defaultAppResult, 'app')
    const defaultRouterNodeId = nodeIdForLabel(defaultRoutesResult, 'apiRouter')
    const requireAppNodeId = nodeIdForLabel(requireAppResult, 'app')
    const requireRouterNodeId = nodeIdForLabel(requireRoutesResult, 'router')

    expect(defaultAppResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: defaultAppNodeId, target: defaultRouterNodeId, relation: 'mounts_router' }),
      ]),
    )
    expect(requireAppResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: requireAppNodeId, target: requireRouterNodeId, relation: 'mounts_router' }),
      ]),
    )
  })

  it('resolves imported express router mounts from namespace and CommonJS module-object bindings', () => {
    const namespaceParentFilePath = join(FIXTURES_DIR, 'express-namespace-module-parent.ts')
    const namespaceChildFilePath = join(FIXTURES_DIR, 'express-namespace-module-child.ts')
    const commonjsParentFilePath = join(FIXTURES_DIR, 'express-commonjs-module-parent.ts')
    const commonjsChildFilePath = join(FIXTURES_DIR, 'express-commonjs-module-child.ts')

    const namespaceParentResult = extractJs(namespaceParentFilePath)
    const namespaceChildResult = extractJs(namespaceChildFilePath)
    const commonjsParentResult = extractJs(commonjsParentFilePath)
    const commonjsChildResult = extractJs(commonjsChildFilePath)

    expect(namespaceParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(namespaceParentResult, 'app'),
          target: nodeIdForLabel(namespaceChildResult, 'router'),
          relation: 'mounts_router',
        }),
      ]),
    )
    expect(commonjsParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(commonjsParentResult, 'app'),
          target: nodeIdForLabel(commonjsChildResult, 'router'),
          relation: 'mounts_router',
        }),
      ]),
    )

    const namespaceGraph = build([namespaceParentResult, namespaceChildResult])
    const commonjsGraph = build([commonjsParentResult, commonjsChildResult])

    expect(graphNodeIdForLabel(namespaceGraph, 'GET /api/users/:id')).toBeDefined()
    expect(graphNodeIdForLabel(commonjsGraph, 'GET /api/users/:id')).toBeDefined()
  })

  it('recognizes direct CommonJS express app and router construction', () => {
    const directAppFilePath = join(FIXTURES_DIR, 'express-commonjs-direct-app.ts')
    const directRouterFilePath = join(FIXTURES_DIR, 'express-commonjs-direct-router.ts')

    const directAppResult = extractJs(directAppFilePath)
    const directRouterResult = extractJs(directRouterFilePath)

    const appNodeId = nodeIdForLabel(directAppResult, 'app')
    const appRouteId = nodeIdForLabel(directAppResult, 'GET /health')
    const appHandlerId = nodeIdForLabel(directAppResult, 'listHealth()')
    const routerNodeId = nodeIdForLabel(directRouterResult, 'router')
    const routerRouteId = nodeIdForLabel(directRouterResult, 'GET /users/:id')
    const routerHandlerId = nodeIdForLabel(directRouterResult, 'listUser()')

    expect(directAppResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'app', node_kind: 'router', framework_role: 'express_app' }),
        expect.objectContaining({ label: 'GET /health', node_kind: 'route', route_path: '/health' }),
      ]),
    )
    expect(directRouterResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'router', node_kind: 'router', framework_role: 'express_router' }),
        expect.objectContaining({ label: 'GET /users/:id', node_kind: 'route', route_path: '/users/:id' }),
      ]),
    )

    expect(directAppResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: appRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: appHandlerId, target: appRouteId, relation: 'handles_route' }),
      ]),
    )
    expect(directRouterResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: routerNodeId, target: routerRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: routerHandlerId, target: routerRouteId, relation: 'handles_route' }),
      ]),
    )
  })

  it('uses each literal path for direct chained app and router verb calls', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-direct-chained.ts')
    const sourceText = [
      "import express from 'express'",
      '',
      'function first() {}',
      'function second() {}',
      'function showUser() {}',
      'function createUser() {}',
      '',
      'const app = express()',
      'const router = express.Router()',
      '',
      "app.get('/a', first).post('/b', second)",
      "router.get('/users/:id', showUser).post('/users', createUser)",
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-direct-chained', [
      'first',
      'second',
      'showUser',
      'createUser',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'GET /a', node_kind: 'route', route_path: '/a' }),
        expect.objectContaining({ label: 'POST /b', node_kind: 'route', route_path: '/b' }),
        expect.objectContaining({ label: 'GET /users/:id', node_kind: 'route', route_path: '/users/:id' }),
        expect.objectContaining({ label: 'POST /users', node_kind: 'route', route_path: '/users' }),
      ]),
    )
    expect(result.nodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'POST /', node_kind: 'route' })]))

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(result, 'first'),
          target: nodeIdForLabel(result, 'GET /a'),
          relation: 'handles_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(result, 'second'),
          target: nodeIdForLabel(result, 'POST /b'),
          relation: 'handles_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(result, 'showUser'),
          target: nodeIdForLabel(result, 'GET /users/:id'),
          relation: 'handles_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(result, 'createUser'),
          target: nodeIdForLabel(result, 'POST /users'),
          relation: 'handles_route',
        }),
      ]),
    )
  })

  it('recognizes TypeScript import-equals express app construction', () => {
    const filePath = join(FIXTURES_DIR, 'express-import-equals-app.ts')

    const result = extractJs(filePath)

    const appNodeId = nodeIdForLabel(result, 'app')
    const routeId = nodeIdForLabel(result, 'GET /health')
    const handlerId = nodeIdForLabel(result, 'listHealth()')

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'app', node_kind: 'router', framework_role: 'express_app' }),
        expect.objectContaining({ label: 'GET /health', node_kind: 'route', route_path: '/health' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: routeId, relation: 'registers_route' }),
        expect.objectContaining({ source: handlerId, target: routeId, relation: 'handles_route' }),
      ]),
    )
  })

  it('resolves import-equals child routers exported through module.exports properties', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-import-equals-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-import-equals-child.ts')

    const graph = build([extractJs(parentFilePath), extractJs(childFilePath)], { directed: true })

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/users/:id'))).toEqual(
      expect.objectContaining({ route_path: '/api/users/:id' }),
    )
  })

  it('resolves child routers exported through module.exports object literals', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-commonjs-object-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-commonjs-object-child.ts')

    const graph = build([extractJs(parentFilePath), extractJs(childFilePath)], { directed: true })

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/users/:id'))).toEqual(
      expect.objectContaining({ route_path: '/api/users/:id' }),
    )
  })

  it('ignores malformed direct CommonJS expressions without crashing', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-malformed.ts')
    const sourceText = [
      "const express = require('express')",
      'const app = require()()',
      'const router = require().Router()',
      "const extraArgApp = require('express', 'extra')()",
      "const extraArgRouter = require('express', 'extra').Router()",
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-malformed', [])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes?.filter((node) => node.framework === 'express')).toEqual([])
  })

  it('extractJs preserves named middleware and method handlers with real base labels', () => {
    const filePath = join(FIXTURES_DIR, 'express-named-handlers.ts')
    const result = extractJs(filePath)

    const routeId = nodeIdForLabel(result, 'GET /users/:id')
    const middlewareId = nodeIdForLabel(result, 'requireAuth()')
    const handlerId = nodeIdForLabel(result, '.showUser()')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: middlewareId, target: routeId, relation: 'middleware' }),
        expect.objectContaining({ source: handlerId, target: routeId, relation: 'handles_route' }),
      ]),
    )
  })

  it('treats imported middleware passed to use() as middleware instead of a mounted router', () => {
    const middlewareFilePath = join(FIXTURES_DIR, 'express-imported-middleware.ts')
    const parentFilePath = join(FIXTURES_DIR, 'express-imported-middleware-parent.ts')

    const middlewareResult = extractJs(middlewareFilePath)
    const parentResult = extractJs(parentFilePath)

    const routeId = nodeIdForLabel(parentResult, 'USE /api')
    const middlewareId = nodeIdForLabel(middlewareResult, 'requireAuth()')

    expect(parentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: middlewareId, target: routeId, relation: 'middleware' }),
      ]),
    )
    expect(parentResult.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'mounts_router', target: middlewareId }),
      ]),
    )
  })

  it('resolves default-exported express callables from ESM imports and CommonJS bindings', () => {
    const esmMiddlewareFilePath = join(FIXTURES_DIR, 'express-default-export-middleware.ts')
    const esmHandlerFilePath = join(FIXTURES_DIR, 'express-default-export-handler-class.ts')
    const esmParentFilePath = join(FIXTURES_DIR, 'express-default-export-callables-parent.ts')
    const commonjsMiddlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-default-middleware.ts')
    const commonjsHandlerFilePath = join(FIXTURES_DIR, 'express-commonjs-default-handler-class.ts')
    const commonjsParentFilePath = join(FIXTURES_DIR, 'express-commonjs-default-callables-parent.ts')

    const esmMiddlewareResult = extractJs(esmMiddlewareFilePath)
    const esmHandlerResult = extractJs(esmHandlerFilePath)
    const esmParentResult = extractJs(esmParentFilePath)
    const commonjsMiddlewareResult = extractJs(commonjsMiddlewareFilePath)
    const commonjsHandlerResult = extractJs(commonjsHandlerFilePath)
    const commonjsParentResult = extractJs(commonjsParentFilePath)

    const esmRouteId = nodeIdForLabel(esmParentResult, 'GET /users/:id')
    const commonjsRouteId = nodeIdForLabel(commonjsParentResult, 'GET /users/:id')
    const commonjsMiddlewareId = nodeIdForLabel(commonjsParentResult, 'requireAuth()')
    const commonjsHandlerId = nodeIdForLabel(commonjsParentResult, 'ShowUser')

    expect(esmParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(esmMiddlewareResult, 'requireAuth()'),
          target: esmRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(esmHandlerResult, 'ShowUser'),
          target: esmRouteId,
          relation: 'handles_route',
        }),
      ]),
    )
    expect(commonjsParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(commonjsParentResult, 'requireAuth()'),
          target: commonjsRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: commonjsHandlerId,
          target: commonjsRouteId,
          relation: 'handles_route',
        }),
      ]),
    )

    const esmGraph = build([esmMiddlewareResult, esmHandlerResult, esmParentResult], { directed: true })
    const commonjsGraph = build([commonjsMiddlewareResult, commonjsHandlerResult, commonjsParentResult], { directed: true })

    expect(esmGraph.hasNode(nodeIdForLabel(esmMiddlewareResult, 'requireAuth()'))).toBe(true)
    expect(commonjsGraph.hasNode(commonjsMiddlewareId)).toBe(true)
    expect(commonjsGraph.edgeAttributes(commonjsHandlerId, commonjsRouteId)).toEqual(
      expect.objectContaining({ relation: 'handles_route' }),
    )
  })

  it('resolves callable CommonJS default exports through ES default imports', () => {
    const middlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-default-arrow-middleware.ts')
    const handlerFilePath = join(FIXTURES_DIR, 'express-commonjs-default-function-handler.ts')
    const parentFilePath = join(FIXTURES_DIR, 'express-commonjs-default-import-callables-parent.js')

    const middlewareResult = extractJs(middlewareFilePath)
    const handlerResult = extractJs(handlerFilePath)
    const parentResult = extractJs(parentFilePath)

    const routeId = nodeIdForLabel(parentResult, 'GET /users/:id')
    const handlerId = nodeIdForLabel(parentResult, 'showUser()')
    const middlewareEdge = parentResult.edges.find((edge) => edge.target === routeId && edge.relation === 'middleware')

    expect(middlewareEdge).toBeDefined()

    expect(parentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: middlewareEdge!.source,
          target: routeId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: handlerId,
          target: routeId,
          relation: 'handles_route',
        }),
      ]),
    )

    const graph = build([middlewareResult, handlerResult, parentResult], { directed: true })

    expect(graph.hasNode(middlewareEdge!.source)).toBe(true)
    expect(graph.hasNode(handlerId)).toBe(true)
  })

  it('resolves callable CommonJS property exports through ES named imports and require destructuring', () => {
    const moduleMiddlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-module-callable-middleware.ts')
    const moduleHandlerFilePath = join(FIXTURES_DIR, 'express-commonjs-module-callable-handler.ts')
    const moduleParentFilePath = join(FIXTURES_DIR, 'express-commonjs-module-callables-parent.js')
    const exportsMiddlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-exports-callable-middleware.ts')
    const exportsHandlerFilePath = join(FIXTURES_DIR, 'express-commonjs-exports-callable-handler.ts')
    const exportsParentFilePath = join(FIXTURES_DIR, 'express-commonjs-exports-callables-parent.js')

    const moduleMiddlewareResult = extractJs(moduleMiddlewareFilePath)
    const moduleHandlerResult = extractJs(moduleHandlerFilePath)
    const moduleParentResult = extractJs(moduleParentFilePath)
    const exportsMiddlewareResult = extractJs(exportsMiddlewareFilePath)
    const exportsHandlerResult = extractJs(exportsHandlerFilePath)
    const exportsParentResult = extractJs(exportsParentFilePath)

    const moduleRouteId = nodeIdForLabel(moduleParentResult, 'GET /users/:id')
    const exportsRouteId = nodeIdForLabel(exportsParentResult, 'GET /users/:id')
    const moduleMiddlewareId = nodeIdForLabel(moduleParentResult, 'requireAuth()')
    const moduleHandlerId = nodeIdForLabel(moduleParentResult, 'showUser()')
    const exportsMiddlewareId = nodeIdForLabel(exportsParentResult, 'requireAuth()')
    const exportsHandlerId = nodeIdForLabel(exportsParentResult, 'showUser()')

    expect(moduleParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: moduleMiddlewareId,
          target: moduleRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: moduleHandlerId,
          target: moduleRouteId,
          relation: 'handles_route',
        }),
      ]),
    )
    expect(exportsParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: exportsMiddlewareId,
          target: exportsRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: exportsHandlerId,
          target: exportsRouteId,
          relation: 'handles_route',
        }),
      ]),
    )

    const moduleGraph = build([moduleMiddlewareResult, moduleHandlerResult, moduleParentResult], { directed: true })
    const exportsGraph = build([exportsMiddlewareResult, exportsHandlerResult, exportsParentResult], { directed: true })

    expect(moduleGraph.hasNode(moduleMiddlewareId)).toBe(true)
    expect(moduleGraph.hasNode(moduleHandlerId)).toBe(true)
    expect(exportsGraph.hasNode(exportsMiddlewareId)).toBe(true)
    expect(exportsGraph.hasNode(exportsHandlerId)).toBe(true)
  })

  it('propagates mount prefixes and inherited middleware to mounted child router routes', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-mounted-router-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-mounted-router-child.ts')

    const graph = build([extractJs(parentFilePath), extractJs(childFilePath)], { directed: true })

    const mountedRouteId = graphNodeIdForLabel(graph, 'GET /api/users/:id')
    const middlewareId = graphNodeIdForLabel(graph, 'requireAuth()')
    const handlerId = graphNodeIdForLabel(graph, 'showUser()')

    expect(graph.nodeAttributes(mountedRouteId)).toEqual(
      expect.objectContaining({
        label: 'GET /api/users/:id',
        node_kind: 'route',
        route_path: '/api/users/:id',
      }),
    )
    expect(graph.edgeAttributes(middlewareId, mountedRouteId)).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.edgeAttributes(handlerId, mountedRouteId)).toEqual(expect.objectContaining({ relation: 'handles_route' }))
  })

  it('recursively propagates nested mounted router prefixes and inherited middleware', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-nested-router-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-nested-router-child.ts')
    const grandchildFilePath = join(FIXTURES_DIR, 'express-nested-router-grandchild.ts')

    const graph = build([extractJs(parentFilePath), extractJs(childFilePath), extractJs(grandchildFilePath)], { directed: true })

    const mountedRouteId = graphNodeIdForLabel(graph, 'GET /api/v1/users/:id')
    const authMiddlewareId = graphNodeIdForLabel(graph, 'requireAuth()')
    const auditMiddlewareId = graphNodeIdForLabel(graph, 'auditTrail()')
    const handlerId = graphNodeIdForLabel(graph, 'showUser()')

    expect(graph.nodeAttributes(mountedRouteId)).toEqual(
      expect.objectContaining({
        label: 'GET /api/v1/users/:id',
        node_kind: 'route',
        route_path: '/api/v1/users/:id',
      }),
    )
    expect(graph.edgeAttributes(authMiddlewareId, mountedRouteId)).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.edgeAttributes(auditMiddlewareId, mountedRouteId)).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.edgeAttributes(handlerId, mountedRouteId)).toEqual(expect.objectContaining({ relation: 'handles_route' }))
  })

  it('handles circular cross-file router imports without recursing indefinitely', () => {
    const appFilePath = join(FIXTURES_DIR, 'express-cross-file-cycle-app.ts')
    const routerAFilePath = join(FIXTURES_DIR, 'express-cross-file-cycle-router-a.ts')
    const routerBFilePath = join(FIXTURES_DIR, 'express-cross-file-cycle-router-b.ts')

    const graph = build([extractJs(appFilePath), extractJs(routerAFilePath), extractJs(routerBFilePath)], { directed: true })

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/local'))).toEqual(
      expect.objectContaining({ route_path: '/api/local' }),
    )
    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/b/leaf'))).toEqual(
      expect.objectContaining({ route_path: '/api/b/leaf' }),
    )
  })

  it('resolves directory router imports to index files before extraction', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-directory-import-parent.ts')
    const routesFilePath = join(FIXTURES_DIR, 'express-directory-routes', 'index.ts')

    const graph = build([extractJs(parentFilePath), extractJs(routesFilePath)], { directed: true })

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/users'))).toEqual(
      expect.objectContaining({ route_path: '/api/users' }),
    )
  })

  it('does not let recursive mount cycle detection poison sibling mounted router expansions', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-cycle.ts')
    const sourceText = [
      "import express from 'express'",
      '',
      'function showUser() {}',
      '',
      'const app = express()',
      'const routerA = express.Router()',
      'const routerB = express.Router()',
      '',
      "routerA.use('/sub', routerB)",
      "routerB.use('/loop', routerA)",
      "routerB.get('/leaf', showUser)",
      '',
      "app.use('/a', routerA)",
      "app.use('/b', routerB)",
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-cycle', ['showUser'])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))
    const graph = build([result], { directed: true })

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /a/sub/leaf'))).toEqual(
      expect.objectContaining({ route_path: '/a/sub/leaf' }),
    )
    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /b/leaf'))).toEqual(
      expect.objectContaining({ route_path: '/b/leaf' }),
    )
  })
})
