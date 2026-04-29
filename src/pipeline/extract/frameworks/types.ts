import type * as ts from 'typescript'

import type { ExtractionFragment } from '../dispatch.js'

export interface JsFrameworkContext {
  filePath: string
  sourceText: string
  sourceFile: ts.SourceFile
  stem: string
  fileNodeId: string
  isJsxFile: boolean
  baseExtraction: Readonly<ExtractionFragment>
}

export interface JsFrameworkAdapter {
  id: string
  matches(filePath: string, sourceText: string): boolean
  extract(context: JsFrameworkContext): ExtractionFragment
}
