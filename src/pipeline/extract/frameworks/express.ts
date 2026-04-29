import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'

import * as ts from 'typescript'

import { addNode, addUniqueEdge, createEdge, createNode, _makeId } from '../core.js'
import type { ExtractionFragment } from '../dispatch.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const HTTP_ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete'])
const EXPRESS_ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'use'])
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']

type ExtractionNodeRecord = NonNullable<ExtractionFragment['nodes']>[number]

interface ExpressEntity {
  id: string
  name: string
  kind: 'app' | 'router'
}

interface FunctionInfo {
  line: number
  arity: number
}

interface ImportedBindingTarget {
  id: string
  kind: 'app' | 'router' | 'function'
  sourceFile: string
}

interface RouteAttachment {
  relation: 'middleware' | 'handles_route'
  targetId: string
  ownedByRoute?: boolean
}

interface RouteRecord {
  ownerId: string
  ownerName: string
  method: string
  path: string
  line: number
  sourceFile: string
  attachments: RouteAttachment[]
}

interface MountRecord {
  owner: ExpressEntity
  prefix: string
  line: number
  inheritedMiddleware: RouteAttachment[]
  routerTarget: {
    id: string
    sourceFile: string
  }
}

interface ExpressModuleAnalysis {
  sourceText: string
  exportedBindings: Map<string, ImportedBindingTarget>
  routeRecords: RouteRecord[]
}

const expressModuleAnalysisCache = new Map<string, ExpressModuleAnalysis>()

function normalizedRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  return `/${trimmed.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`
}

function routeNodeId(filePath: string, ownerName: string, method: string, path: string, line: number): string {
  return _makeId(filePath, ownerName, method.toUpperCase(), path, String(line))
}

function expressEntityId(filePath: string, bindingName: string): string {
  return _makeId(filePath, bindingName, 'express')
}

function moduleStem(filePath: string): string {
  return basename(filePath, extname(filePath))
}

function functionNodeId(filePath: string, bindingName: string): string {
  return _makeId(moduleStem(filePath), bindingName)
}

function resolveImportPath(filePath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }

  const resolvedSpecifier = resolve(dirname(filePath), specifier)
  if (existsSync(resolvedSpecifier)) {
    return resolvedSpecifier
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = `${resolvedSpecifier}${extension}`
    if (existsSync(candidate)) {
      return candidate
    }
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = resolve(resolvedSpecifier, `index${extension}`)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return resolvedSpecifier
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.cjs') || filePath.endsWith('.mjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function stringLiteralPath(expression: ts.Expression | undefined): string | null {
  if (!expression) {
    return null
  }

  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return normalizedRoutePath(unwrapped.text)
  }

  return null
}

function flattenedExpressions(expression: ts.Expression): ts.Expression[] {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) {
        return ts.isArrayLiteralExpression(unparenthesizeExpression(element.expression))
          ? flattenedExpressions(element.expression)
          : [element.expression]
      }
      return ts.isExpression(element) ? flattenedExpressions(element) : []
    })
  }

  return [unwrapped]
}

function identifierName(expression: ts.Expression): string | null {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text
  }
  return null
}

function createExpressEntityNode(
  entity: ExpressEntity,
  context: JsFrameworkContext,
  line: number,
  nodes: ReturnType<NonNullable<ExtractionFragment['nodes']>['slice']>,
  seenNodeIds: Set<string>,
  edges: ReturnType<NonNullable<ExtractionFragment['edges']>['slice']>,
  seenEdges: Set<string>,
): void {
  addNode(
    nodes,
    seenNodeIds,
    {
      ...createNode(entity.id, entity.name, context.filePath, line),
      node_kind: 'router',
      framework: 'express',
      framework_role: entity.kind === 'app' ? 'express_app' : 'express_router',
    },
  )
  addUniqueEdge(edges, seenEdges, createEdge(context.fileNodeId, entity.id, 'declares', context.filePath, line))
}

function resolveWrappedTargetExpression(expression: ts.Expression): ts.Expression | null {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isCallExpression(unwrapped)) {
    for (let index = unwrapped.arguments.length - 1; index >= 0; index -= 1) {
      const candidate = resolveWrappedTargetExpression(unwrapped.arguments[index]!)
      if (candidate) {
        return candidate
      }
    }
  }

  if (
    ts.isIdentifier(unwrapped) ||
    ts.isPropertyAccessExpression(unwrapped) ||
    ts.isArrowFunction(unwrapped) ||
    ts.isFunctionExpression(unwrapped)
  ) {
    return unwrapped
  }

  return null
}

function frameworkRoleForCallable(relation: 'middleware' | 'handles_route', arity: number | null): string {
  if (relation === 'handles_route') {
    return 'express_handler'
  }

  return arity !== null && arity >= 4 ? 'express_error_middleware' : 'express_middleware'
}

function resolveNamedBaseNodeId(name: string, baseNodeIdsByLabel: ReadonlyMap<string, string>): string | null {
  for (const candidate of [name, `${name}()`, `.${name}()`]) {
    const nodeId = baseNodeIdsByLabel.get(candidate.toLowerCase())
    if (nodeId) {
      return nodeId
    }
  }
  return null
}

function joinRoutePaths(prefix: string, path: string): string {
  if (prefix === '/') {
    return path
  }
  if (path === '/') {
    return prefix
  }
  return normalizedRoutePath(`${prefix}/${path}`)
}

function routeRecordKey(record: RouteRecord): string {
  return [record.ownerId, record.method, record.path, String(record.line), record.sourceFile].join('|')
}

function dedupeRouteRecords(records: readonly RouteRecord[]): RouteRecord[] {
  const seen = new Set<string>()
  const deduped: RouteRecord[] = []

  for (const record of records) {
    const key = routeRecordKey(record)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(record)
  }

  return deduped
}

function ownedRouteCacheKey(ownerId: string, seenTargets: ReadonlySet<string>): string {
  return `${ownerId}|${[...seenTargets].sort().join(',')}`
}

function createMountedRouteRecord(mountRecord: MountRecord, descendantRoute: RouteRecord): RouteRecord {
  return {
    ownerId: mountRecord.owner.id,
    ownerName: `${mountRecord.owner.name}->${descendantRoute.ownerName}`,
    method: descendantRoute.method,
    path: joinRoutePaths(mountRecord.prefix, descendantRoute.path),
    line: descendantRoute.line,
    sourceFile: descendantRoute.sourceFile,
    attachments: [...mountRecord.inheritedMiddleware, ...descendantRoute.attachments],
  }
}

function createRouteRecordResolver(
  filePath: string,
  routeRecords: readonly RouteRecord[],
  mountRecords: readonly MountRecord[],
  resolveExternalRoutes: (routerTarget: MountRecord['routerTarget']) => readonly RouteRecord[],
): (routerTarget: MountRecord['routerTarget']) => RouteRecord[] {
  const directRouteRecordsByOwner = new Map<string, RouteRecord[]>()
  const mountRecordsByOwner = new Map<string, MountRecord[]>()
  const ownedRouteCache = new Map<string, RouteRecord[]>()

  for (const routeRecord of routeRecords) {
    const records = directRouteRecordsByOwner.get(routeRecord.ownerId)
    if (records) {
      records.push(routeRecord)
    } else {
      directRouteRecordsByOwner.set(routeRecord.ownerId, [routeRecord])
    }
  }

  for (const mountRecord of mountRecords) {
    const records = mountRecordsByOwner.get(mountRecord.owner.id)
    if (records) {
      records.push(mountRecord)
    } else {
      mountRecordsByOwner.set(mountRecord.owner.id, [mountRecord])
    }
  }

  const collectOwnedRoutes = (ownerId: string, seenTargets: Set<string>): RouteRecord[] => {
    const cacheKey = ownedRouteCacheKey(ownerId, seenTargets)
    const cached = ownedRouteCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const ownedRoutes = [...(directRouteRecordsByOwner.get(ownerId) ?? [])]
    for (const mountRecord of mountRecordsByOwner.get(ownerId) ?? []) {
      const targetKey = `${mountRecord.routerTarget.sourceFile}:${mountRecord.routerTarget.id}`
      if (seenTargets.has(targetKey)) {
        continue
      }

      const descendantRoutes =
        mountRecord.routerTarget.sourceFile === filePath
          ? collectOwnedRoutes(mountRecord.routerTarget.id, new Set([...seenTargets, targetKey]))
          : resolveExternalRoutes(mountRecord.routerTarget)

      for (const descendantRoute of descendantRoutes) {
        ownedRoutes.push(createMountedRouteRecord(mountRecord, descendantRoute))
      }
    }

    const dedupedRoutes = dedupeRouteRecords(ownedRoutes)
    ownedRouteCache.set(cacheKey, dedupedRoutes)
    return dedupedRoutes
  }

  return (routerTarget) =>
    routerTarget.sourceFile === filePath
      ? collectOwnedRoutes(routerTarget.id, new Set([`${routerTarget.sourceFile}:${routerTarget.id}`]))
      : [...resolveExternalRoutes(routerTarget)]
}

function resolveLocalRouteAttachment(
  expression: ts.Expression,
  routeLabel: string,
  relation: 'middleware' | 'handles_route',
  sourceFile: ts.SourceFile,
  filePath: string,
  functionInfoByName: ReadonlyMap<string, FunctionInfo>,
): RouteAttachment | null {
  const candidate = resolveWrappedTargetExpression(expression)
  if (!candidate) {
    return null
  }

  const label = identifierName(candidate)
  if (label && functionInfoByName.has(label)) {
    return {
      relation,
      targetId: functionNodeId(filePath, label),
    }
  }

  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
    const functionName = candidate.name?.text ?? `inline ${relation} ${routeLabel}`
    return {
      relation,
      targetId: _makeId(filePath, relation, routeLabel, String(lineOf(candidate, sourceFile)), functionName),
      ownedByRoute: relation === 'handles_route',
    }
  }

  return null
}

function analyzeExpressModule(filePath: string): ExpressModuleAnalysis {
  const sourceText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const cached = expressModuleAnalysisCache.get(filePath)
  if (cached && cached.sourceText === sourceText) {
    return cached
  }

  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
  const expressFactoryAliases = new Set<string>()
  const expressRouterAliases = new Set<string>()
  const importedBindingsByLocalName = new Map<string, ImportedBindingTarget>()
  const expressEntities = new Map<string, ExpressEntity>()
  const functionInfoByName = new Map<string, FunctionInfo>()
  const routeRecords: RouteRecord[] = []
  const mountRecords: MountRecord[] = []
  const exportedBindings = new Map<string, ImportedBindingTarget>()

  const registerExpressEntity = (name: string, kind: ExpressEntity['kind']): void => {
    if (expressEntities.has(name)) {
      return
    }
    expressEntities.set(name, {
      id: expressEntityId(filePath, name),
      name,
      kind,
    })
  }

  const registerImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text
      const importClause = node.importClause
      if (moduleSpecifier === 'express') {
        if (importClause?.name) {
          expressFactoryAliases.add(importClause.name.text)
        }
        const bindings = importClause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          expressFactoryAliases.add(bindings.name.text)
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text
            if (importedName === 'Router') {
              expressRouterAliases.add(element.name.text)
            }
          }
        }
      } else {
        const resolvedImportPath = resolveImportPath(filePath, moduleSpecifier)
        const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
        if (resolvedImportPath && importedModule && importClause?.name) {
          const importedTarget = importedModule.exportedBindings.get('default')
          if (importedTarget) {
            importedBindingsByLocalName.set(importClause.name.text, importedTarget)
          }
        }
        const bindings = importClause?.namedBindings
        if (resolvedImportPath && importedModule && bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
            const importedTarget = importedModule.exportedBindings.get(importedName)
            if (importedTarget) {
              importedBindingsByLocalName.set(element.name.text, importedTarget)
            }
          }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      ts.isStringLiteral(node.initializer.arguments[0]!)
    ) {
      const requiredModule = node.initializer.arguments[0]!.text
      if (requiredModule === 'express') {
        expressFactoryAliases.add(node.name.text)
      } else {
        const resolvedImportPath = resolveImportPath(filePath, requiredModule)
        const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
        if (resolvedImportPath && importedModule) {
          const importedTarget = importedModule.exportedBindings.get('default')
          if (importedTarget) {
            importedBindingsByLocalName.set(node.name.text, importedTarget)
          }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      ts.isStringLiteral(node.initializer.arguments[0]!)
    ) {
      const requiredModule = node.initializer.arguments[0]!.text
      if (requiredModule === 'express') {
        for (const element of node.name.elements) {
          const importedName =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.getText(sourceFile)
          if (importedName === 'Router' && ts.isIdentifier(element.name)) {
            expressRouterAliases.add(element.name.text)
          }
        }
      } else {
        const resolvedImportPath = resolveImportPath(filePath, requiredModule)
        const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
        if (resolvedImportPath && importedModule) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) {
              continue
            }
            const importedName =
              !element.propertyName || ts.isIdentifier(element.propertyName)
                ? (element.propertyName?.text ?? element.name.text)
                : element.propertyName.getText(sourceFile)
            const importedTarget = importedModule.exportedBindings.get(importedName)
            if (importedTarget) {
              importedBindingsByLocalName.set(element.name.text, importedTarget)
            }
          }
        }
      }
    }

    ts.forEachChild(node, registerImports)
  }

  const collectFunctionInfo = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionInfoByName.set(node.name.text, {
        line: lineOf(node, sourceFile),
        arity: node.parameters.length,
      })
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functionInfoByName.set(node.name.text, {
        line: lineOf(node, sourceFile),
        arity: node.initializer.parameters.length,
      })
    }

    ts.forEachChild(node, collectFunctionInfo)
  }

  const registerBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const initializer = node.initializer
      const callee = unparenthesizeExpression(initializer.expression)

      if (ts.isIdentifier(callee) && expressFactoryAliases.has(callee.text)) {
        registerExpressEntity(node.name.text, 'app')
      }

      if (
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          expressFactoryAliases.has(callee.expression.text) &&
          callee.name.text === 'Router') ||
        (ts.isIdentifier(callee) && expressRouterAliases.has(callee.text))
      ) {
        registerExpressEntity(node.name.text, 'router')
      }
    }

    ts.forEachChild(node, registerBindings)
  }

  const resolveExportedBinding = (localName: string): ImportedBindingTarget | null => {
    const entity = expressEntities.get(localName)
    if (entity) {
      return {
        id: entity.id,
        kind: entity.kind,
        sourceFile: filePath,
      }
    }

    if (functionInfoByName.has(localName)) {
      return {
        id: functionNodeId(filePath, localName),
        kind: 'function',
        sourceFile: filePath,
      }
    }

    return null
  }

  const addExportedBinding = (exportName: string, localName: string): void => {
    const binding = resolveExportedBinding(localName)
    if (binding) {
      exportedBindings.set(exportName, binding)
    }
  }

  registerImports(sourceFile)
  collectFunctionInfo(sourceFile)
  registerBindings(sourceFile)

  const collectRoutes = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const parsedRoute = parseRouteCall(node, expressEntities)
      if (parsedRoute) {
        const method = parsedRoute.method.toUpperCase()
        const routeLabel = `${method} ${parsedRoute.path}`
        const flattenedArgs = parsedRoute.routeArgs.flatMap((argument) => flattenedExpressions(argument))
        const attachments: RouteAttachment[] = []

        if (parsedRoute.method === 'use') {
          for (const argument of flattenedArgs) {
            const routerName = ts.isIdentifier(argument) ? argument.text : null
            const localRouter = routerName ? expressEntities.get(routerName) : null
            const importedRouter = routerName ? importedBindingsByLocalName.get(routerName) ?? null : null
            const routerTarget =
              localRouter && (localRouter.kind === 'router' || localRouter.kind === 'app')
                ? { id: localRouter.id, sourceFile: filePath }
                : importedRouter && (importedRouter.kind === 'router' || importedRouter.kind === 'app')
                  ? { id: importedRouter.id, sourceFile: importedRouter.sourceFile }
                  : null

            if (routerTarget) {
              mountRecords.push({
                owner: parsedRoute.owner,
                prefix: parsedRoute.path,
                line: lineOf(node, sourceFile),
                inheritedMiddleware: [...attachments],
                routerTarget,
              })
              continue
            }

            const attachment = resolveLocalRouteAttachment(
              argument,
              routeLabel,
              'middleware',
              sourceFile,
              filePath,
              functionInfoByName,
            )
            if (attachment) {
              attachments.push(attachment)
            }
          }
        } else if (HTTP_ROUTE_METHODS.has(parsedRoute.method) && flattenedArgs.length > 0) {
          for (let index = 0; index < flattenedArgs.length; index += 1) {
            const relation = index === flattenedArgs.length - 1 ? 'handles_route' : 'middleware'
            const attachment = resolveLocalRouteAttachment(
              flattenedArgs[index]!,
              routeLabel,
              relation,
              sourceFile,
              filePath,
              functionInfoByName,
            )
            if (attachment) {
              attachments.push(attachment)
            }
          }
        }

        routeRecords.push({
          ownerId: parsedRoute.owner.id,
          ownerName: parsedRoute.owner.name,
          method,
          path: parsedRoute.path,
          line: lineOf(node, sourceFile),
          sourceFile: filePath,
          attachments,
        })
      }
    }

    ts.forEachChild(node, collectRoutes)
  }

  const collectExports = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        addExportedBinding(node.name.text, node.name.text)
      }
    }

    if (ts.isVariableStatement(node)) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            addExportedBinding(declaration.name.text, declaration.name.text)
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) && !node.moduleSpecifier) {
      for (const element of node.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text
        addExportedBinding(element.name.text, localName)
      }
    }

    if (ts.isExportAssignment(node)) {
      const exportName = identifierName(node.expression)
      if (exportName) {
        addExportedBinding('default', exportName)
      } else if (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression)) {
        exportedBindings.set('default', {
          id: _makeId(moduleStem(filePath), 'default'),
          kind: 'function',
          sourceFile: filePath,
        })
      }
    }

    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unparenthesizeExpression(node.expression.left)
      const right = unparenthesizeExpression(node.expression.right)

      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === 'module' &&
        left.name.text === 'exports'
      ) {
        const exportName = identifierName(right)
        if (exportName) {
          addExportedBinding('default', exportName)
        }
      }

      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === 'exports'
      ) {
        const exportName = identifierName(right)
        if (exportName) {
          addExportedBinding(left.name.text, exportName)
        }
      }
    }

    ts.forEachChild(node, collectExports)
  }

  collectRoutes(sourceFile)
  collectExports(sourceFile)

  const resolveRouteRecords = createRouteRecordResolver(filePath, routeRecords, mountRecords, (routerTarget) =>
    analyzeExpressModule(routerTarget.sourceFile).routeRecords.filter((record) => record.ownerId === routerTarget.id),
  )
  const expandedRouteRecords = dedupeRouteRecords([
    ...routeRecords,
    ...mountRecords.flatMap((mountRecord) => resolveRouteRecords(mountRecord.routerTarget).map((record) => createMountedRouteRecord(mountRecord, record))),
  ])

  const analysis = { sourceText, exportedBindings, routeRecords: expandedRouteRecords }
  expressModuleAnalysisCache.set(filePath, analysis)
  return analysis
}

function resolveTargetNodeId(
  expression: ts.Expression,
  routeLabel: string,
  relation: 'middleware' | 'handles_route',
  context: JsFrameworkContext,
  baseNodeIdsByLabel: ReadonlyMap<string, string>,
  baseNodesById: ReadonlyMap<string, ExtractionNodeRecord>,
  functionInfoByName: ReadonlyMap<string, FunctionInfo>,
  importedBindingsByLocalName: ReadonlyMap<string, ImportedBindingTarget>,
  nodes: ReturnType<NonNullable<ExtractionFragment['nodes']>['slice']>,
  seenNodeIds: Set<string>,
): RouteAttachment | null {
  const candidate = resolveWrappedTargetExpression(expression)
  if (!candidate) {
    return null
  }

  const label = identifierName(candidate)
  if (label) {
    const nodeId = resolveNamedBaseNodeId(label, baseNodeIdsByLabel)
    if (nodeId) {
      const baseNode = baseNodesById.get(nodeId)
      const functionInfo = functionInfoByName.get(label)
      if (baseNode) {
        addNode(
          nodes,
          seenNodeIds,
          {
            ...baseNode,
            node_kind: 'function',
            framework: 'express',
            framework_role: frameworkRoleForCallable(relation, functionInfo?.arity ?? null),
          },
        )
      }
      return { relation, targetId: nodeId }
    }

    const importedBinding = ts.isIdentifier(candidate) ? importedBindingsByLocalName.get(label) ?? null : null
    if (importedBinding?.kind === 'function') {
      return { relation, targetId: importedBinding.id }
    }
  }

  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
    const functionName = candidate.name?.text ?? `inline ${relation} ${routeLabel}`
    const id = _makeId(context.filePath, relation, routeLabel, String(lineOf(candidate, context.sourceFile)), functionName)
    addNode(
      nodes,
      seenNodeIds,
      {
        ...createNode(id, functionName, context.filePath, lineOf(candidate, context.sourceFile)),
        node_kind: 'function',
        framework: 'express',
        framework_role: frameworkRoleForCallable(relation, candidate.parameters.length),
      },
    )
    return { relation, targetId: id, ownedByRoute: relation === 'handles_route' }
  }

  return null
}

function addRouteAttachmentEdges(
  edges: ReturnType<NonNullable<ExtractionFragment['edges']>['slice']>,
  seenEdges: Set<string>,
  sourceFile: string,
  line: number,
  routeId: string,
  attachment: RouteAttachment,
): void {
  addUniqueEdge(edges, seenEdges, createEdge(attachment.targetId, routeId, attachment.relation, sourceFile, line))
  addUniqueEdge(edges, seenEdges, createEdge(routeId, attachment.targetId, 'depends_on', sourceFile, line))
  if (attachment.ownedByRoute) {
    addUniqueEdge(edges, seenEdges, createEdge(routeId, attachment.targetId, 'contains', sourceFile, line))
  }
}

function parseRouteCall(
  call: ts.CallExpression,
  expressEntities: ReadonlyMap<string, ExpressEntity>,
): { owner: ExpressEntity; method: string; path: string; routeArgs: readonly ts.Expression[] } | null {
  const callee = unparenthesizeExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee)) {
    return null
  }

  const method = callee.name.text
  if (!EXPRESS_ROUTE_METHODS.has(method)) {
    return null
  }

  const resolveRouteTarget = (expression: ts.Expression): { owner: ExpressEntity; path: string } | null => {
    const unwrapped = unparenthesizeExpression(expression)
    if (ts.isIdentifier(unwrapped)) {
      const owner = expressEntities.get(unwrapped.text)
      return owner ? { owner, path: '/' } : null
    }

    if (!ts.isCallExpression(unwrapped)) {
      return null
    }

    const routeCallee = unparenthesizeExpression(unwrapped.expression)
    if (ts.isPropertyAccessExpression(routeCallee) && routeCallee.name.text === 'route') {
      const routeOwnerExpression = unparenthesizeExpression(routeCallee.expression)
      if (!ts.isIdentifier(routeOwnerExpression)) {
        return null
      }

      const owner = expressEntities.get(routeOwnerExpression.text)
      const path = stringLiteralPath(unwrapped.arguments[0])
      return owner && path ? { owner, path } : null
    }

    if (ts.isPropertyAccessExpression(routeCallee) && EXPRESS_ROUTE_METHODS.has(routeCallee.name.text)) {
      return resolveRouteTarget(routeCallee.expression)
    }

    return null
  }

  const ownerExpression = unparenthesizeExpression(callee.expression)
  if (ts.isIdentifier(ownerExpression)) {
    const owner = expressEntities.get(ownerExpression.text)
    if (!owner) {
      return null
    }

    const path = stringLiteralPath(call.arguments[0]) ?? (method === 'use' ? '/' : null)
    if (!path) {
      return null
    }

    return {
      owner,
      method,
      path,
      routeArgs: call.arguments.slice(stringLiteralPath(call.arguments[0]) ? 1 : 0),
    }
  }

  const routeTarget = resolveRouteTarget(ownerExpression)
  if (!routeTarget || method === 'use') {
    return null
  }

  return {
    owner: routeTarget.owner,
    method,
    path: routeTarget.path,
    routeArgs: call.arguments,
  }
}

export const expressAdapter: JsFrameworkAdapter = {
  id: 'js:express',
  matches(_filePath, sourceText) {
    return /\bexpress\b/.test(sourceText)
  },
  extract(context) {
    const nodes: NonNullable<ExtractionFragment['nodes']> = []
    const edges: NonNullable<ExtractionFragment['edges']> = []
    const seenNodeIds = new Set<string>()
    const seenEdges = new Set<string>()
    const baseNodeIdsByLabel = new Map(
      (context.baseExtraction.nodes ?? []).map((node) => [String(node.label).toLowerCase(), node.id] as const),
    )
    const baseNodesById = new Map((context.baseExtraction.nodes ?? []).map((node) => [node.id, node] as const))
    const expressFactoryAliases = new Set<string>()
    const expressRouterAliases = new Set<string>()
    const importedBindingsByLocalName = new Map<string, ImportedBindingTarget>()
    const expressEntities = new Map<string, ExpressEntity>()
    const functionInfoByName = new Map<string, FunctionInfo>()
    const routeRecords: RouteRecord[] = []
    const mountRecords: MountRecord[] = []

    const registerExpressEntity = (name: string, kind: ExpressEntity['kind'], line: number): void => {
      if (expressEntities.has(name)) {
        return
      }

      const entity: ExpressEntity = {
        id: expressEntityId(context.filePath, name),
        name,
        kind,
      }
      expressEntities.set(name, entity)
      createExpressEntityNode(entity, context, line, nodes, seenNodeIds, edges, seenEdges)
    }

    const registerImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleSpecifier = node.moduleSpecifier.text
        const importClause = node.importClause
        if (moduleSpecifier === 'express') {
          if (importClause?.name) {
            expressFactoryAliases.add(importClause.name.text)
          }
          const bindings = importClause?.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) {
            expressFactoryAliases.add(bindings.name.text)
          }
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const importedName = element.propertyName?.text ?? element.name.text
              if (importedName === 'Router') {
                expressRouterAliases.add(element.name.text)
              }
            }
          }
        } else {
          const resolvedImportPath = resolveImportPath(context.filePath, moduleSpecifier)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath && importedModule && importClause?.name) {
            const importedTarget = importedModule.exportedBindings.get('default')
            if (importedTarget) {
              importedBindingsByLocalName.set(importClause.name.text, importedTarget)
            }
          }
          const bindings = importClause?.namedBindings
          if (resolvedImportPath && importedModule && bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const importedName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
              const importedTarget = importedModule.exportedBindings.get(importedName)
              if (importedTarget) {
                importedBindingsByLocalName.set(element.name.text, importedTarget)
              }
            }
          }
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'require' &&
        ts.isStringLiteral(node.initializer.arguments[0]!)
      ) {
        const requiredModule = node.initializer.arguments[0]!.text
        if (requiredModule === 'express') {
          expressFactoryAliases.add(node.name.text)
        } else {
          const resolvedImportPath = resolveImportPath(context.filePath, requiredModule)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath && importedModule) {
            const importedTarget = importedModule.exportedBindings.get('default')
            if (importedTarget) {
              importedBindingsByLocalName.set(node.name.text, importedTarget)
            }
          }
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'require' &&
        ts.isStringLiteral(node.initializer.arguments[0]!)
      ) {
        const requiredModule = node.initializer.arguments[0]!.text
        if (requiredModule === 'express') {
          for (const element of node.name.elements) {
            const importedName =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.getText(context.sourceFile)
            if (importedName === 'Router' && ts.isIdentifier(element.name)) {
              expressRouterAliases.add(element.name.text)
            }
          }
        } else {
          const resolvedImportPath = resolveImportPath(context.filePath, requiredModule)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath && importedModule) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) {
                continue
              }
              const importedName =
                !element.propertyName || ts.isIdentifier(element.propertyName)
                  ? (element.propertyName?.text ?? element.name.text)
                  : element.propertyName.getText(context.sourceFile)
              const importedTarget = importedModule.exportedBindings.get(importedName)
              if (importedTarget) {
                importedBindingsByLocalName.set(element.name.text, importedTarget)
              }
            }
          }
        }
      }

      ts.forEachChild(node, registerImports)
    }

    registerImports(context.sourceFile)

    const collectFunctionInfo = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        functionInfoByName.set(node.name.text, {
          line: lineOf(node, context.sourceFile),
          arity: node.parameters.length,
        })
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        functionInfoByName.set(node.name.text, {
          line: lineOf(node, context.sourceFile),
          arity: node.initializer.parameters.length,
        })
      }

      ts.forEachChild(node, collectFunctionInfo)
    }

    collectFunctionInfo(context.sourceFile)

    const registerBindings = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const initializer = node.initializer
        const callee = unparenthesizeExpression(initializer.expression)
        const line = lineOf(node, context.sourceFile)

        if (ts.isIdentifier(callee) && expressFactoryAliases.has(callee.text)) {
          registerExpressEntity(node.name.text, 'app', line)
        }

        if (
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            expressFactoryAliases.has(callee.expression.text) &&
            callee.name.text === 'Router') ||
          (ts.isIdentifier(callee) && expressRouterAliases.has(callee.text))
        ) {
          registerExpressEntity(node.name.text, 'router', line)
        }
      }

      ts.forEachChild(node, registerBindings)
    }

    registerBindings(context.sourceFile)

    const visitRoutes = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const parsedRoute = parseRouteCall(node, expressEntities)
        if (parsedRoute) {
          const method = parsedRoute.method.toUpperCase()
          const routeLabel = `${method} ${parsedRoute.path}`
          const routeLine = lineOf(node, context.sourceFile)
          const routeId = routeNodeId(context.filePath, parsedRoute.owner.name, method, parsedRoute.path, routeLine)

          addNode(
            nodes,
            seenNodeIds,
            {
              ...createNode(routeId, routeLabel, context.filePath, routeLine),
              node_kind: 'route',
              framework: 'express',
              framework_role: 'express_route',
              http_method: method,
              route_path: parsedRoute.path,
            },
          )
          addUniqueEdge(edges, seenEdges, createEdge(context.fileNodeId, routeId, 'declares', context.filePath, routeLine))
          addUniqueEdge(edges, seenEdges, createEdge(parsedRoute.owner.id, routeId, 'registers_route', context.filePath, routeLine))

          const flattenedArgs = parsedRoute.routeArgs.flatMap((argument) => flattenedExpressions(argument))
          const routeRecord: RouteRecord = {
            ownerId: parsedRoute.owner.id,
            ownerName: parsedRoute.owner.name,
            method,
            path: parsedRoute.path,
            line: routeLine,
            sourceFile: context.filePath,
            attachments: [],
          }

          if (parsedRoute.method === 'use') {
            const inheritedMiddleware: RouteAttachment[] = []
            for (const argument of flattenedArgs) {
              const routerName = ts.isIdentifier(argument) ? argument.text : null
              const localRouter = routerName ? expressEntities.get(routerName) : null
              const importedRouter = routerName ? importedBindingsByLocalName.get(routerName) ?? null : null
              const routerTarget =
                localRouter && (localRouter.kind === 'router' || localRouter.kind === 'app')
                  ? { id: localRouter.id, sourceFile: context.filePath }
                  : importedRouter && (importedRouter.kind === 'router' || importedRouter.kind === 'app')
                    ? { id: importedRouter.id, sourceFile: importedRouter.sourceFile }
                    : null

              if (routerTarget) {
                addUniqueEdge(edges, seenEdges, createEdge(parsedRoute.owner.id, routerTarget.id, 'mounts_router', context.filePath, routeLine))
                mountRecords.push({
                  owner: parsedRoute.owner,
                  prefix: parsedRoute.path,
                  line: routeLine,
                  inheritedMiddleware: [...inheritedMiddleware],
                  routerTarget,
                })
                continue
              }

              const middlewareAttachment = resolveTargetNodeId(
                argument,
                routeLabel,
                'middleware',
                context,
                baseNodeIdsByLabel,
                baseNodesById,
                functionInfoByName,
                importedBindingsByLocalName,
                nodes,
                seenNodeIds,
              )
              if (middlewareAttachment) {
                addRouteAttachmentEdges(edges, seenEdges, context.filePath, routeLine, routeId, middlewareAttachment)
                inheritedMiddleware.push(middlewareAttachment)
                routeRecord.attachments.push(middlewareAttachment)
              }
            }
          } else if (HTTP_ROUTE_METHODS.has(parsedRoute.method) && flattenedArgs.length > 0) {
            for (let index = 0; index < flattenedArgs.length; index += 1) {
              const argument = flattenedArgs[index]!
              const relation = index === flattenedArgs.length - 1 ? 'handles_route' : 'middleware'
              const attachment = resolveTargetNodeId(
                argument,
                routeLabel,
                relation,
                context,
                baseNodeIdsByLabel,
                baseNodesById,
                functionInfoByName,
                importedBindingsByLocalName,
                nodes,
                seenNodeIds,
              )
              if (attachment) {
                addRouteAttachmentEdges(edges, seenEdges, context.filePath, routeLine, routeId, attachment)
                routeRecord.attachments.push(attachment)
              }
            }
          }

          routeRecords.push(routeRecord)
        }
      }

      ts.forEachChild(node, visitRoutes)
    }

    visitRoutes(context.sourceFile)

    const resolveRouteRecords = createRouteRecordResolver(context.filePath, routeRecords, mountRecords, (routerTarget) =>
      analyzeExpressModule(routerTarget.sourceFile).routeRecords.filter((record) => record.ownerId === routerTarget.id),
    )

    for (const mountRecord of mountRecords) {
      const descendantRoutes = resolveRouteRecords(mountRecord.routerTarget)

      for (const descendantRoute of descendantRoutes) {
        const mountedRouteRecord = createMountedRouteRecord(mountRecord, descendantRoute)
        const mountedLabel = `${mountedRouteRecord.method} ${mountedRouteRecord.path}`
        const mountedRouteId = routeNodeId(
          context.filePath,
          mountedRouteRecord.ownerName,
          mountedRouteRecord.method,
          mountedRouteRecord.path,
          mountedRouteRecord.line,
        )

        addNode(
          nodes,
          seenNodeIds,
          {
            ...createNode(mountedRouteId, mountedLabel, mountedRouteRecord.sourceFile, mountedRouteRecord.line),
            node_kind: 'route',
            framework: 'express',
            framework_role: 'express_route',
            http_method: mountedRouteRecord.method,
            route_path: mountedRouteRecord.path,
          },
        )
        addUniqueEdge(edges, seenEdges, createEdge(context.fileNodeId, mountedRouteId, 'declares', context.filePath, mountRecord.line))
        addUniqueEdge(edges, seenEdges, createEdge(mountRecord.owner.id, mountedRouteId, 'registers_route', context.filePath, mountRecord.line))

        for (const attachment of mountedRouteRecord.attachments) {
          addRouteAttachmentEdges(edges, seenEdges, context.filePath, mountRecord.line, mountedRouteId, attachment)
        }
      }
    }

    return { nodes, edges }
  },
}
