import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { ExtractionData, ExtractionNode } from '../../src/contracts/types.js'
import { resolveCrossFilePythonImports } from '../../src/pipeline/extract/cross-file.js'

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'graphify-ts-extract-cross-file-'))
}

describe('resolveCrossFilePythonImports', () => {
  it('adds inferred inherits and uses edges across python files', () => {
    const root = createTempRoot()
    try {
      const modelsPath = join(root, 'models.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(modelsPath, ['class Response:', '    pass', '', 'class BaseAuth:', '    pass'].join('\n'), 'utf8')
      writeFileSync(
        authPath,
        [
          'from .models import Response as ApiResponse, BaseAuth',
          '',
          'class DigestAuth(BaseAuth):',
          '    def build(self) -> ApiResponse:',
          '        return ApiResponse()',
        ].join('\n'),
        'utf8',
      )

      const resolved = resolveCrossFilePythonImports([authPath, modelsPath], {
        nodes: [
          { id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath },
          { id: 'response', label: 'Response', file_type: 'code', source_file: modelsPath },
          { id: 'base', label: 'BaseAuth', file_type: 'code', source_file: modelsPath },
        ],
        edges: [],
        input_tokens: 0,
        output_tokens: 0,
      })

      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'auth_digestauth', target: 'base', relation: 'inherits', confidence: 'INFERRED' }),
          expect.objectContaining({ source: 'auth_digestauth', target: 'response', relation: 'uses', confidence: 'INFERRED' }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('can resolve imported targets from context nodes without adding them to the returned extraction payload', () => {
    const root = createTempRoot()
    try {
      const modelsPath = join(root, 'models.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(modelsPath, ['class Response:', '    pass', '', 'class BaseAuth:', '    pass'].join('\n'), 'utf8')
      writeFileSync(
        authPath,
        [
          'from .models import Response as ApiResponse, BaseAuth',
          '',
          'class DigestAuth(BaseAuth):',
          '    def build(self) -> ApiResponse:',
          '        return ApiResponse()',
        ].join('\n'),
        'utf8',
      )

      const combined: ExtractionData = {
        nodes: [{ id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath }],
        edges: [],
        input_tokens: 0,
        output_tokens: 0,
      }
      const contextNodes: ExtractionNode[] = [
        { id: 'response', label: 'Response', file_type: 'code', source_file: modelsPath },
        { id: 'base', label: 'BaseAuth', file_type: 'code', source_file: modelsPath },
      ]

      const resolved = resolveCrossFilePythonImports([authPath, modelsPath], combined, { contextNodes })

      expect(resolved.nodes).toEqual(combined.nodes)
      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'auth_digestauth', target: 'base', relation: 'inherits' }),
          expect.objectContaining({ source: 'auth_digestauth', target: 'response', relation: 'uses' }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips unreadable python files while still resolving links from readable files', () => {
    const root = createTempRoot()
    try {
      const missingModelsPath = join(root, 'models.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(
        authPath,
        [
          'from .models import Response as ApiResponse, BaseAuth',
          '',
          'class DigestAuth(BaseAuth):',
          '    def build(self) -> ApiResponse:',
          '        return ApiResponse()',
        ].join('\n'),
        'utf8',
      )

      const resolved = resolveCrossFilePythonImports(
        [authPath, missingModelsPath],
        {
          nodes: [{ id: 'auth_digestauth', label: 'DigestAuth', file_type: 'code', source_file: authPath }],
          edges: [],
          input_tokens: 0,
          output_tokens: 0,
        },
        {
          contextNodes: [
            { id: 'response', label: 'Response', file_type: 'code', source_file: missingModelsPath },
            { id: 'base', label: 'BaseAuth', file_type: 'code', source_file: missingModelsPath },
          ],
        },
      )

      expect(resolved.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'auth_digestauth', target: 'base', relation: 'inherits' }),
          expect.objectContaining({ source: 'auth_digestauth', target: 'response', relation: 'uses' }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
