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
      '',
      'const app = express()',
      'const router = express.Router()',
      '',
      "app.use('/api', requireAuth, [auditTrail], router)",
      "app.get('/health', (_req: unknown, _res: unknown) => {})",
      "app.post('/users', requireAuth, createUser)",
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
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'app', node_kind: 'router', framework_role: 'express_app' }),
        expect.objectContaining({ label: 'router', node_kind: 'router', framework_role: 'express_router' }),
        expect.objectContaining({ label: 'requireAuth', node_kind: 'function', framework_role: 'express_middleware' }),
        expect.objectContaining({ label: 'createUser', node_kind: 'function', framework_role: 'express_handler' }),
        expect.objectContaining({ label: 'onUserError', node_kind: 'function', framework_role: 'express_error_middleware' }),
        expect.objectContaining({ label: 'USE /api', node_kind: 'route', http_method: 'USE', route_path: '/api' }),
        expect.objectContaining({ label: 'GET /health', node_kind: 'route', http_method: 'GET', route_path: '/health' }),
        expect.objectContaining({ label: 'POST /users', node_kind: 'route', http_method: 'POST', route_path: '/users' }),
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
    const postUsersRouteId = nodeIdForLabel(result, 'POST /users')
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
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: postUsersRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'createUser'), target: postUsersRouteId, relation: 'handles_route' }),
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
    const appSourceText = [
      "import express from 'express'",
      "import { apiRouter } from './virtual-express-child.ts'",
      '',
      'const app = express()',
      "app.use('/api', apiRouter)",
    ].join('\n')
    const routesSourceText = [
      "import express from 'express'",
      '',
      'function listUser() {}',
      'export const apiRouter = express.Router()',
      "apiRouter.get('/users/:id', listUser)",
    ].join('\n')
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
})
