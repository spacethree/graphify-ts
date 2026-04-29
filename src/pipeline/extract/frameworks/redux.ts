import * as ts from 'typescript'

import type { ExtractionNode } from '../../../contracts/types.js'
import { addNode, addUniqueEdge, createEdge, createNode, _makeId } from '../core.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const REDUX_MATCH_PATTERN = /\bcreateSlice\b|\bconfigureStore\b|\bcreateAsyncThunk\b/

interface SliceRecord {
  nodeId: string
}

interface NamedReferenceOptions {
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  frameworkRole: string
  fallbackSuffix: string
}

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

function addNamedNode(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  name: string,
  line: number,
  options: NamedReferenceOptions,
): string {
  const baseNode = findBaseNode(context, name)
  const id = baseNode?.id ?? _makeId(context.filePath, name, options.fallbackSuffix)
  addNode(nodes, seenIds, {
    ...(baseNode ?? createNode(id, name, context.filePath, line)),
    id,
    node_kind: options.nodeKind,
    framework: 'redux-toolkit',
    framework_role: options.frameworkRole,
  })
  return id
}

function stringPropertyValue(node: ts.ObjectLiteralExpression, propertyName: string): string | null {
  for (const property of node.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property.name) === propertyName
    ) {
      const initializer = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : unparenthesizeExpression(property.initializer)
      if (ts.isStringLiteralLike(initializer)) {
        return initializer.text
      }
    }
  }

  return null
}

function objectProperty(node: ts.ObjectLiteralExpression, propertyName: string): ts.ObjectLiteralElementLike | null {
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

function recordActionOrSelectorMembers(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slice: SliceRecord,
  property: ts.ObjectLiteralElementLike | null,
  relation: 'defines_action' | 'defines_selector',
  frameworkRole: 'redux_action' | 'redux_selector',
): void {
  if (!property || !(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))) {
    return
  }

  if (ts.isMethodDeclaration(property)) {
    return
  }

  const initializer = unparenthesizeExpression(property.initializer)
  const members = ts.isObjectLiteralExpression(initializer) ? initializer.properties : []

  for (const member of members) {
    if (!('name' in member) || !member.name) {
      continue
    }

    const memberName = propertyNameText(member.name)
    if (!memberName) {
      continue
    }

    const memberId = addNamedNode(context, nodes, seenIds, memberName, lineOf(member, context.sourceFile), {
      nodeKind: 'function',
      frameworkRole,
      fallbackSuffix: frameworkRole,
    })
    addUniqueEdge(edges, seenEdges, createEdge(slice.nodeId, memberId, relation, context.filePath, lineOf(member, context.sourceFile)))
  }
}

function recordThunkReferences(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slice: SliceRecord,
  extraReducersProperty: ts.ObjectLiteralElementLike | null,
): void {
  if (!extraReducersProperty || !(ts.isPropertyAssignment(extraReducersProperty) || ts.isMethodDeclaration(extraReducersProperty))) {
    return
  }

  const callback = ts.isMethodDeclaration(extraReducersProperty)
    ? extraReducersProperty
    : (() => {
        const initializer = unparenthesizeExpression(extraReducersProperty.initializer)
        return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : null
      })()

  if (!callback) {
    return
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (() => {
        const expression = unparenthesizeExpression(node.expression)
        return ts.isPropertyAccessExpression(expression) && expression.name.text === 'addCase'
      })() &&
      node.arguments.length > 0
    ) {
      const firstArgument = unparenthesizeExpression(node.arguments[0]!)
      const thunkExpression =
        ts.isPropertyAccessExpression(firstArgument) && ts.isIdentifier(firstArgument.expression)
          ? firstArgument.expression
          : ts.isIdentifier(firstArgument)
            ? firstArgument
            : null

      if (thunkExpression) {
        const thunkId = addNamedNode(context, nodes, seenIds, thunkExpression.text, lineOf(thunkExpression, context.sourceFile), {
          nodeKind: 'function',
          frameworkRole: 'redux_thunk',
          fallbackSuffix: 'thunk',
        })
        addUniqueEdge(
          edges,
          seenEdges,
          createEdge(thunkId, slice.nodeId, 'updates_slice', context.filePath, lineOf(node, context.sourceFile)),
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  const callbackBody = callback.body
  if (callbackBody) {
    visit(callbackBody)
  }
}

function sliceReducerTarget(expression: ts.Expression, slicesByBinding: ReadonlyMap<string, SliceRecord>): SliceRecord | null {
  const candidate = unparenthesizeExpression(expression)
  if (
    ts.isPropertyAccessExpression(candidate) &&
    candidate.name.text === 'reducer' &&
    ts.isIdentifier(candidate.expression)
  ) {
    return slicesByBinding.get(candidate.expression.text) ?? null
  }

  return null
}

function handleStoreRegistration(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slicesByBinding: ReadonlyMap<string, SliceRecord>,
  declaration: ts.VariableDeclaration,
): void {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return
  }

  const initializer = unparenthesizeExpression(declaration.initializer)
  if (!ts.isCallExpression(initializer)) {
    return
  }
  const callee = unparenthesizeExpression(initializer.expression)
  if (!ts.isIdentifier(callee)) {
    return
  }
  if (callee.text !== 'configureStore') {
    return
  }

  const options = initializer.arguments[0]
  const optionsExpression = options ? unparenthesizeExpression(options) : null
  if (!optionsExpression || !ts.isObjectLiteralExpression(optionsExpression)) {
    return
  }

  const storeId = addNamedNode(context, nodes, seenIds, declaration.name.text, lineOf(declaration.name, context.sourceFile), {
    nodeKind: 'store',
    frameworkRole: 'redux_store',
    fallbackSuffix: 'store',
  })
  const reducerProperty = objectProperty(optionsExpression, 'reducer')
  if (!reducerProperty || !(ts.isPropertyAssignment(reducerProperty) || ts.isShorthandPropertyAssignment(reducerProperty))) {
    return
  }

  const reducerInitializer = ts.isShorthandPropertyAssignment(reducerProperty)
    ? reducerProperty.name
    : unparenthesizeExpression(reducerProperty.initializer)

  if (ts.isObjectLiteralExpression(reducerInitializer)) {
    for (const property of reducerInitializer.properties) {
      if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
        continue
      }

      const targetSlice = sliceReducerTarget(
        ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
        slicesByBinding,
      )
      if (!targetSlice) {
        continue
      }

      addUniqueEdge(
        edges,
        seenEdges,
        createEdge(targetSlice.nodeId, storeId, 'registered_in_store', context.filePath, lineOf(property, context.sourceFile)),
      )
    }
    return
  }

  const targetSlice = sliceReducerTarget(reducerInitializer, slicesByBinding)
  if (!targetSlice) {
    return
  }

  addUniqueEdge(
    edges,
    seenEdges,
    createEdge(targetSlice.nodeId, storeId, 'registered_in_store', context.filePath, lineOf(reducerProperty, context.sourceFile)),
  )
}

function handleExportedMembers(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slicesByBinding: ReadonlyMap<string, SliceRecord>,
  declaration: ts.VariableDeclaration,
): void {
  if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) {
    return
  }

  const initializer = unparenthesizeExpression(declaration.initializer)
  if (!ts.isPropertyAccessExpression(initializer) || !ts.isIdentifier(initializer.expression)) {
    return
  }

  const slice = slicesByBinding.get(initializer.expression.text)
  if (!slice) {
    return
  }

  const kind = initializer.name.text === 'actions'
    ? {
        relation: 'defines_action' as const,
        frameworkRole: 'redux_action' as const,
        fallbackSuffix: 'action',
      }
    : initializer.name.text === 'selectors'
      ? {
          relation: 'defines_selector' as const,
          frameworkRole: 'redux_selector' as const,
          fallbackSuffix: 'selector',
        }
      : null

  if (!kind) {
    return
  }

  for (const element of declaration.name.elements) {
    const exportName = ts.isIdentifier(element.name) ? element.name.text : null
    if (!exportName) {
      continue
    }

    const nodeId = addNamedNode(context, nodes, seenIds, exportName, lineOf(element.name, context.sourceFile), {
      nodeKind: 'function',
      frameworkRole: kind.frameworkRole,
      fallbackSuffix: kind.fallbackSuffix,
    })
    addUniqueEdge(edges, seenEdges, createEdge(slice.nodeId, nodeId, kind.relation, context.filePath, lineOf(element, context.sourceFile)))
  }
}

function handleSliceDeclaration(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slicesByBinding: Map<string, SliceRecord>,
  declaration: ts.VariableDeclaration,
): void {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return
  }

  const initializer = unparenthesizeExpression(declaration.initializer)
  if (!ts.isCallExpression(initializer)) {
    return
  }
  const callee = unparenthesizeExpression(initializer.expression)
  if (!ts.isIdentifier(callee)) {
    return
  }
  if (callee.text !== 'createSlice') {
    return
  }

  const options = initializer.arguments[0]
  const optionsExpression = options ? unparenthesizeExpression(options) : null
  if (!optionsExpression || !ts.isObjectLiteralExpression(optionsExpression)) {
    return
  }

  const sliceOptions = optionsExpression
  const sliceName = stringPropertyValue(sliceOptions, 'name') ?? declaration.name.text
  const sliceNodeId = _makeId(context.filePath, sliceName, 'slice')
  addNode(nodes, seenIds, {
    ...createNode(sliceNodeId, `${sliceName} slice`, context.filePath, lineOf(declaration.name, context.sourceFile)),
    node_kind: 'slice',
    framework: 'redux-toolkit',
    framework_role: 'redux_slice',
  })

  const sliceRecord: SliceRecord = { nodeId: sliceNodeId }
  slicesByBinding.set(declaration.name.text, sliceRecord)

  recordActionOrSelectorMembers(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    sliceRecord,
    objectProperty(sliceOptions, 'reducers'),
    'defines_action',
    'redux_action',
  )
  recordActionOrSelectorMembers(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    sliceRecord,
    objectProperty(sliceOptions, 'selectors'),
    'defines_selector',
    'redux_selector',
  )
  recordThunkReferences(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    sliceRecord,
    objectProperty(sliceOptions, 'extraReducers'),
  )
}

export const reduxAdapter: JsFrameworkAdapter = {
  id: 'redux-toolkit',
  matches(_filePath, sourceText) {
    return REDUX_MATCH_PATTERN.test(sourceText)
  },
  extract(context) {
    const nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']> = []
    const edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']> = []
    const seenIds = new Set<string>()
    const seenEdges = new Set<string>()
    const slicesByBinding = new Map<string, SliceRecord>()

    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node)) {
        handleSliceDeclaration(context, nodes, edges, seenIds, seenEdges, slicesByBinding, node)
        handleStoreRegistration(context, nodes, edges, seenIds, seenEdges, slicesByBinding, node)
        handleExportedMembers(context, nodes, edges, seenIds, seenEdges, slicesByBinding, node)
      }

      ts.forEachChild(node, visit)
    }

    visit(context.sourceFile)

    return { nodes, edges }
  },
}
