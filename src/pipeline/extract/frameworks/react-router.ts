import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import * as ts from 'typescript'

import type { ExtractionNode } from '../../../contracts/types.js'
import { addNode, addUniqueEdge, createEdge, createNode, _makeId } from '../core.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import { resolveImportPath, scriptKindForPath } from './js-import-paths.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const REACT_ROUTER_MATCH_PATTERN = /\bcreateBrowserRouter\b|\bcreateRoutesFromElements\b|<Route\b/

interface RouteNodeRecord {
  id: string
  fullPath: string
  line: number
}

interface AddReferenceOptions {
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  frameworkRole: string
  fallbackSuffix: string
}

interface ImportedRouteReference {
  id: string
  label: string
  sourceFile: string
  line: number
  nodeKind: NonNullable<ExtractionNode['node_kind']>
}

interface JsModuleAnalysis {
  exports: Map<string, ImportedRouteReference>
}

type RouteObjectProperty = ts.PropertyAssignment | ts.MethodDeclaration | ts.ShorthandPropertyAssignment

const jsModuleAnalysisCache = new Map<string, JsModuleAnalysis>()

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }

  return null
}

function findBaseNode(context: JsFrameworkContext, name: string) {
  const candidates = new Set([name, `${name}()`, `.${name}()`])
  return context.baseExtraction.nodes?.find((node) => candidates.has(node.label)) ?? null
}

function createExportedReference(
  filePath: string,
  name: string,
  line: number,
  label: string,
  nodeKind: NonNullable<ExtractionNode['node_kind']>,
): ImportedRouteReference {
  return {
    id: _makeId(resolve(filePath), name),
    label,
    sourceFile: filePath,
    line,
    nodeKind,
  }
}

function referenceForVariableDeclaration(filePath: string, declaration: ts.VariableDeclaration, sourceFile: ts.SourceFile): ImportedRouteReference | null {
  if (!ts.isIdentifier(declaration.name)) {
    return null
  }

  const initializer = declaration.initializer ? unparenthesizeExpression(declaration.initializer) : null
  const name = declaration.name.text
  const line = lineOf(declaration.name, sourceFile)

  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return createExportedReference(filePath, name, line, `${name}()`, 'function')
  }

  if (initializer && ts.isClassExpression(initializer)) {
    return createExportedReference(filePath, name, line, name, 'class')
  }

  return createExportedReference(filePath, name, line, name, 'function')
}

function analyzeJsModule(filePath: string): JsModuleAnalysis {
  const resolvedFilePath = resolve(filePath)
  const cached = jsModuleAnalysisCache.get(resolvedFilePath)
  if (cached) {
    return cached
  }

  const analysis: JsModuleAnalysis = {
    exports: new Map<string, ImportedRouteReference>(),
  }
  jsModuleAnalysisCache.set(resolvedFilePath, analysis)

  let sourceText: string
  try {
    sourceText = readFileSync(resolvedFilePath, 'utf8')
  } catch {
    return analysis
  }

  const sourceFile = ts.createSourceFile(resolvedFilePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(resolvedFilePath))
  const importedBindings = new Map<string, ImportedRouteReference>()
  const localBindings = new Map<string, ImportedRouteReference>()

  const resolveLocalBinding = (name: string): ImportedRouteReference | null => localBindings.get(name) ?? importedBindings.get(name) ?? null

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    const targetFilePath = resolveImportPath(resolvedFilePath, statement.moduleSpecifier.text)
    if (!targetFilePath) {
      continue
    }

    const exportedBindings = analyzeJsModule(targetFilePath).exports
    if (statement.importClause.name) {
      const binding = exportedBindings.get('default')
      if (binding) {
        importedBindings.set(statement.importClause.name.text, binding)
      }
    }

    const namedBindings = statement.importClause.namedBindings
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        const binding = exportedBindings.get(importedName)
        if (binding) {
          importedBindings.set(element.name.text, binding)
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    const defaultExport = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const reference = createExportedReference(resolvedFilePath, statement.name.text, lineOf(statement.name, sourceFile), `${statement.name.text}()`, 'function')
      localBindings.set(statement.name.text, reference)
      if (exported) {
        analysis.exports.set(statement.name.text, reference)
      }
      if (defaultExport) {
        analysis.exports.set('default', reference)
      }
      continue
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const reference = createExportedReference(resolvedFilePath, statement.name.text, lineOf(statement.name, sourceFile), statement.name.text, 'class')
      localBindings.set(statement.name.text, reference)
      if (exported) {
        analysis.exports.set(statement.name.text, reference)
      }
      if (defaultExport) {
        analysis.exports.set('default', reference)
      }
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const reference = referenceForVariableDeclaration(resolvedFilePath, declaration, sourceFile)
        if (!reference || !ts.isIdentifier(declaration.name)) {
          continue
        }

        localBindings.set(declaration.name.text, reference)
        if (exported) {
          analysis.exports.set(declaration.name.text, reference)
        }
      }
      continue
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unparenthesizeExpression(statement.expression)
      if (ts.isIdentifier(expression)) {
        const reference = resolveLocalBinding(expression.text)
        if (reference) {
          analysis.exports.set('default', reference)
        }
      } else if ((ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) && expression.name?.text) {
        analysis.exports.set(
          'default',
          createExportedReference(resolvedFilePath, expression.name.text, lineOf(expression, sourceFile), `${expression.name.text}()`, 'function'),
        )
      } else if (ts.isClassExpression(expression) && expression.name?.text) {
        analysis.exports.set(
          'default',
          createExportedReference(resolvedFilePath, expression.name.text, lineOf(expression, sourceFile), expression.name.text, 'class'),
        )
      } else {
        analysis.exports.set('default', createExportedReference(resolvedFilePath, 'default', lineOf(statement, sourceFile), 'default', 'function'))
      }
      continue
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const targetFilePath =
        statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? resolveImportPath(resolvedFilePath, statement.moduleSpecifier.text)
          : null
      const targetExports = targetFilePath ? analyzeJsModule(targetFilePath).exports : null

      for (const element of statement.exportClause.elements) {
        const exportName = element.name.text
        const localName = element.propertyName?.text ?? element.name.text
        const reference = targetExports?.get(localName) ?? resolveLocalBinding(localName)
        if (reference) {
          analysis.exports.set(exportName, reference)
        }
      }
    }
  }

  return analysis
}

function collectImportedRouteBindings(filePath: string, sourceFile: ts.SourceFile): Map<string, ImportedRouteReference> {
  const importedBindings = new Map<string, ImportedRouteReference>()

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const targetFilePath = resolveImportPath(filePath, node.moduleSpecifier.text)
      const exportedBindings = targetFilePath ? analyzeJsModule(targetFilePath).exports : null
      if (!exportedBindings) {
        ts.forEachChild(node, visit)
        return
      }

      if (node.importClause.name) {
        const binding = exportedBindings.get('default')
        if (binding) {
          importedBindings.set(node.importClause.name.text, binding)
        }
      }

      const namedBindings = node.importClause.namedBindings
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text
          const binding = exportedBindings.get(importedName)
          if (binding) {
            importedBindings.set(element.name.text, binding)
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return importedBindings
}

function addNamedReference(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  name: string,
  line: number,
  options: AddReferenceOptions,
  importedReference: ImportedRouteReference | null = null,
): string {
  const baseNode = findBaseNode(context, name)
  const id = importedReference?.id ?? baseNode?.id ?? _makeId(context.filePath, name, options.fallbackSuffix)
  addNode(nodes, seenIds, {
    ...(importedReference
      ? createNode(importedReference.id, importedReference.label, importedReference.sourceFile, importedReference.line)
      : baseNode ?? createNode(id, name, context.filePath, line)),
    id,
    node_kind: importedReference?.nodeKind ?? baseNode?.node_kind ?? options.nodeKind,
    framework: 'react-router',
    framework_role: options.frameworkRole,
  })
  return id
}

function joinRoutePath(parentPath: string | null, currentPath: string | null, isIndex: boolean): string {
  if (isIndex) {
    return parentPath || '/'
  }

  if (!currentPath || currentPath === '/') {
    return parentPath || '/'
  }

  if (currentPath.startsWith('/')) {
    return currentPath.replace(/\/{2,}/g, '/')
  }

  const base = parentPath && parentPath !== '/' ? parentPath : ''
  return `${base}/${currentPath}`.replace(/\/{2,}/g, '/')
}

function routeLabel(fullPath: string, isIndex: boolean): string {
  return isIndex ? `${fullPath} (index)` : fullPath
}

function objectProperty(node: ts.ObjectLiteralExpression, propertyName: string): RouteObjectProperty | null {
  for (const property of node.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property.name) === propertyName
    ) {
      return property
    }
  }

  return null
}

function booleanProperty(node: ts.ObjectLiteralExpression, propertyName: string): boolean {
  const property = objectProperty(node, propertyName)
  if (!property) {
    return false
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text === propertyName
  }

  if (!ts.isPropertyAssignment(property)) {
    return false
  }

  const initializer = unparenthesizeExpression(property.initializer)
  return initializer.kind === ts.SyntaxKind.TrueKeyword
}

function stringProperty(node: ts.ObjectLiteralExpression, propertyName: string): string | null {
  const property = objectProperty(node, propertyName)
  if (!property || !ts.isPropertyAssignment(property)) {
    return null
  }

  const initializer = unparenthesizeExpression(property.initializer)
  return ts.isStringLiteralLike(initializer) ? initializer.text : null
}

function expressionProperty(node: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | null {
  const property = objectProperty(node, propertyName)
  if (!property || !ts.isPropertyAssignment(property)) {
    return null
  }

  return unparenthesizeExpression(property.initializer)
}

function identifierFromExpression(expression: ts.Expression): string | null {
  const candidate = unparenthesizeExpression(expression)
  if (ts.isIdentifier(candidate)) {
    return candidate.text
  }
  if (ts.isPropertyAccessExpression(candidate)) {
    return candidate.name.text
  }
  return null
}

function componentNameFromElementExpression(expression: ts.Expression): string | null {
  const candidate = unparenthesizeExpression(expression)
  if (ts.isJsxSelfClosingElement(candidate)) {
    return ts.isIdentifier(candidate.tagName) ? candidate.tagName.text : candidate.tagName.getText()
  }
  if (ts.isJsxElement(candidate)) {
    return ts.isIdentifier(candidate.openingElement.tagName)
      ? candidate.openingElement.tagName.text
      : candidate.openingElement.tagName.getText()
  }
  if (ts.isIdentifier(candidate) || ts.isPropertyAccessExpression(candidate)) {
    return identifierFromExpression(candidate)
  }
  return null
}

function createRouteNode(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  fullPath: string,
  routePath: string,
  line: number,
  isIndex: boolean,
): RouteNodeRecord {
  const id = _makeId(context.filePath, 'route', fullPath, String(line))
  addNode(nodes, seenIds, {
    ...createNode(id, routeLabel(fullPath, isIndex), context.filePath, line),
    node_kind: 'route',
    route_path: routePath,
    framework: 'react-router',
    framework_role: 'react_router_route',
  })
  return { id, fullPath, line }
}

function addRouteBindings(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  route: RouteNodeRecord,
  componentExpression: ts.Expression | null,
  loaderExpression: ts.Expression | null,
  actionExpression: ts.Expression | null,
  importedBindings: ReadonlyMap<string, ImportedRouteReference>,
): void {
  const componentName = componentExpression ? componentNameFromElementExpression(componentExpression) : null
  if (componentName) {
    const componentId = addNamedReference(
      context,
      nodes,
      seenIds,
      componentName,
      lineOf(componentExpression!, context.sourceFile),
      {
        nodeKind: 'component',
        frameworkRole: 'react_router_component',
        fallbackSuffix: 'component',
      },
      importedBindings.get(componentName) ?? null,
    )
    addUniqueEdge(edges, seenEdges, createEdge(route.id, componentId, 'renders', context.filePath, route.line))
  }

  const loaderName = loaderExpression ? identifierFromExpression(loaderExpression) : null
  if (loaderName) {
    const loaderId = addNamedReference(
      context,
      nodes,
      seenIds,
      loaderName,
      lineOf(loaderExpression!, context.sourceFile),
      {
        nodeKind: 'function',
        frameworkRole: 'react_router_loader',
        fallbackSuffix: 'loader',
      },
      importedBindings.get(loaderName) ?? null,
    )
    addUniqueEdge(edges, seenEdges, createEdge(route.id, loaderId, 'loads_route', context.filePath, route.line))
  }

  const actionName = actionExpression ? identifierFromExpression(actionExpression) : null
  if (actionName) {
    const actionId = addNamedReference(
      context,
      nodes,
      seenIds,
      actionName,
      lineOf(actionExpression!, context.sourceFile),
      {
        nodeKind: 'function',
        frameworkRole: 'react_router_action',
        fallbackSuffix: 'action',
      },
      importedBindings.get(actionName) ?? null,
    )
    addUniqueEdge(edges, seenEdges, createEdge(route.id, actionId, 'submits_route', context.filePath, route.line))
  }
}

function jsxAttributeExpression(attribute: ts.JsxAttribute | undefined): ts.Expression | null {
  if (!attribute?.initializer) {
    return null
  }

  if (ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression ? unparenthesizeExpression(attribute.initializer.expression) : null
  }

  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer
  }

  return null
}

function jsxAttribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
  )
}

function routeNodeFromJsxElement(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  routerId: string,
  element: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  parentRoute: RouteNodeRecord | null,
  importedBindings: ReadonlyMap<string, ImportedRouteReference>,
): RouteNodeRecord | null {
  if (ts.isJsxFragment(element)) {
    for (const child of element.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        routeNodeFromJsxElement(context, nodes, edges, seenIds, seenEdges, routerId, child, parentRoute, importedBindings)
      }
    }
    return null
  }

  const openingElement = ts.isJsxElement(element) ? element.openingElement : element
  if (!ts.isIdentifier(openingElement.tagName) || openingElement.tagName.text !== 'Route') {
    return null
  }

  const pathExpression = jsxAttributeExpression(jsxAttribute(openingElement, 'path'))
  const isIndex = Boolean(jsxAttribute(openingElement, 'index'))
  const routePath = joinRoutePath(
    parentRoute?.fullPath ?? null,
    pathExpression && ts.isStringLiteralLike(pathExpression) ? pathExpression.text : null,
    isIndex,
  )
  const route = createRouteNode(
    context,
    nodes,
    seenIds,
    routePath,
    routePath,
    lineOf(openingElement, context.sourceFile),
    isIndex,
  )

  addUniqueEdge(
    edges,
    seenEdges,
    createEdge(parentRoute ? parentRoute.id : routerId, route.id, parentRoute ? 'contains' : 'registers_route', context.filePath, route.line),
  )

  addRouteBindings(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    route,
    jsxAttributeExpression(jsxAttribute(openingElement, 'Component')) ??
      jsxAttributeExpression(jsxAttribute(openingElement, 'element')),
    jsxAttributeExpression(jsxAttribute(openingElement, 'loader')),
    jsxAttributeExpression(jsxAttribute(openingElement, 'action')),
    importedBindings,
  )

  if (ts.isJsxElement(element)) {
    for (const child of element.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        routeNodeFromJsxElement(context, nodes, edges, seenIds, seenEdges, routerId, child, route, importedBindings)
      }
    }
  }

  return route
}

function routeNodeFromObjectLiteral(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  routerId: string,
  routeObject: ts.ObjectLiteralExpression,
  parentRoute: RouteNodeRecord | null,
  importedBindings: ReadonlyMap<string, ImportedRouteReference>,
): RouteNodeRecord {
  const isIndex = booleanProperty(routeObject, 'index')
  const path = stringProperty(routeObject, 'path')
  const fullPath = joinRoutePath(parentRoute?.fullPath ?? null, path, isIndex)
  const route = createRouteNode(context, nodes, seenIds, fullPath, fullPath, lineOf(routeObject, context.sourceFile), isIndex)

  addUniqueEdge(
    edges,
    seenEdges,
    createEdge(parentRoute ? parentRoute.id : routerId, route.id, parentRoute ? 'contains' : 'registers_route', context.filePath, route.line),
  )

  addRouteBindings(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    route,
    expressionProperty(routeObject, 'Component') ?? expressionProperty(routeObject, 'element'),
    expressionProperty(routeObject, 'loader'),
    expressionProperty(routeObject, 'action'),
    importedBindings,
  )

  const childrenExpression = expressionProperty(routeObject, 'children')
  if (childrenExpression && ts.isArrayLiteralExpression(childrenExpression)) {
    for (const child of childrenExpression.elements) {
      const candidate = unparenthesizeExpression(child)
      if (ts.isObjectLiteralExpression(candidate)) {
        routeNodeFromObjectLiteral(context, nodes, edges, seenIds, seenEdges, routerId, candidate, route, importedBindings)
      }
    }
  }

  return route
}

function resolveInitializerExpression(
  expression: ts.Expression,
  initializers: ReadonlyMap<string, ts.Expression>,
): ts.Expression {
  const candidate = unparenthesizeExpression(expression)
  return ts.isIdentifier(candidate) ? unparenthesizeExpression(initializers.get(candidate.text) ?? candidate) : candidate
}

export const reactRouterAdapter: JsFrameworkAdapter = {
  id: 'react-router',
  matches(_filePath, sourceText) {
    return REACT_ROUTER_MATCH_PATTERN.test(sourceText)
  },
  extract(context) {
    const nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']> = []
    const edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']> = []
    const seenIds = new Set<string>()
    const seenEdges = new Set<string>()
    const initializers = new Map<string, ts.Expression>()
    const importedBindings = collectImportedRouteBindings(context.filePath, context.sourceFile)

    const collectInitializers = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        initializers.set(node.name.text, node.initializer)
      }
      ts.forEachChild(node, collectInitializers)
    }
    collectInitializers(context.sourceFile)

    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unparenthesizeExpression(node.initializer)
        const callee = ts.isCallExpression(initializer) ? unparenthesizeExpression(initializer.expression) : null
        if (ts.isCallExpression(initializer) && callee && ts.isIdentifier(callee) && callee.text === 'createBrowserRouter') {
          const routerId = addNamedReference(context, nodes, seenIds, node.name.text, lineOf(node.name, context.sourceFile), {
            nodeKind: 'router',
            frameworkRole: 'react_router',
            fallbackSuffix: 'router',
          })
          const routesExpression = initializer.arguments[0]
            ? resolveInitializerExpression(initializer.arguments[0], initializers)
            : null

          if (routesExpression && ts.isArrayLiteralExpression(routesExpression)) {
            for (const element of routesExpression.elements) {
              const candidate = unparenthesizeExpression(element)
              if (ts.isObjectLiteralExpression(candidate)) {
                routeNodeFromObjectLiteral(context, nodes, edges, seenIds, seenEdges, routerId, candidate, null, importedBindings)
              }
            }
          } else if (routesExpression && ts.isCallExpression(routesExpression)) {
            const routeFactory = unparenthesizeExpression(routesExpression.expression)
            if (ts.isIdentifier(routeFactory) && routeFactory.text === 'createRoutesFromElements') {
              const rootElement = routesExpression.arguments[0]
                ? resolveInitializerExpression(routesExpression.arguments[0], initializers)
                : null
              if (rootElement && (ts.isJsxElement(rootElement) || ts.isJsxSelfClosingElement(rootElement) || ts.isJsxFragment(rootElement))) {
                routeNodeFromJsxElement(context, nodes, edges, seenIds, seenEdges, routerId, rootElement, null, importedBindings)
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(context.sourceFile)

    return { nodes, edges }
  },
}
