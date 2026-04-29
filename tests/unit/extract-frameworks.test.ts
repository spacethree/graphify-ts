import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as ts from 'typescript'

import { buildFromJson } from '../../src/pipeline/build.js'
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
})
