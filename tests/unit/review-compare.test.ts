import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  executeReviewCompareRuns,
  formatReviewCompareSummary,
  generateReviewCompareArtifacts,
} from '../../src/infrastructure/review-compare.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'graphify-ts-review-compare-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, 'graphify-out'), { recursive: true })

  writeFileSync(join(root, 'src', 'auth.ts'), [
    'export function authenticateUser(token: string) {',
    '  const parsed = token.trim()',
    '  const status = "ok"',
    '  return parsed.length > 0 ? status : "fail"',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'api.ts'), [
    'export function ApiHandler(token: string) {',
    '  return authenticateUser(token)',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'audit-log.ts'), [
    'export function appendAuthAudit(actor: string, status: string) {',
    '  return `${actor}:${status}`.toLowerCase()',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'tests', 'auth.test.ts'), 'describe("auth", () => {})\n', 'utf8')

  writeFileSync(
    join(root, 'graphify-out', 'graph.json'),
    JSON.stringify({
      directed: true,
      community_labels: {
        '0': 'Auth Layer',
        '1': 'API Layer',
        '2': 'Audit Trail',
      },
      nodes: [
        {
          id: 'auth_user',
          label: 'authenticateUser',
          source_file: join(root, 'src', 'auth.ts'),
          source_location: 'L1-L5',
          node_kind: 'function',
          file_type: 'code',
          community: 0,
        },
        {
          id: 'api_handler',
          label: 'ApiHandler',
          source_file: join(root, 'src', 'api.ts'),
          source_location: 'L1-L3',
          node_kind: 'function',
          file_type: 'code',
          community: 1,
        },
        {
          id: 'audit_logger',
          label: 'appendAuthAudit',
          source_file: join(root, 'src', 'audit-log.ts'),
          source_location: 'L1-L3',
          node_kind: 'function',
          file_type: 'code',
          community: 2,
        },
      ],
      edges: [
        {
          source: 'api_handler',
          target: 'auth_user',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: join(root, 'src', 'api.ts'),
        },
        {
          source: 'auth_user',
          target: 'audit_logger',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: join(root, 'src', 'auth.ts'),
        },
      ],
      hyperedges: [],
      root_path: root,
    }),
    'utf8',
  )

  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'graphify@example.com'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Graphify Test'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: root, stdio: 'pipe' })
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    [
      'export function authenticateUser(token: string) {',
      '  const parsed = token.trim()',
      '  const status = token.startsWith("Bearer ") ? "ok" : "fail"',
      '  return parsed.length > 0 ? status : "fail"',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )

  return root
}

describe('review compare', () => {
  const repoRoots: string[] = []

  afterEach(() => {
    for (const root of repoRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes verbose and compact review prompt artifacts with reduction metrics', () => {
    const root = createRepo()
    repoRoots.push(root)

    const result = generateReviewCompareArtifacts({
      graphPath: join(root, 'graphify-out', 'graph.json'),
      outputDir: join(root, 'graphify-out', 'review-compare'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      now: new Date('2026-05-01T21:00:00.000Z'),
    })

    const verbosePrompt = readFileSync(result.report.paths.verbose_prompt, 'utf8')
    const compactPrompt = readFileSync(result.report.paths.compact_prompt, 'utf8')

    expect(result.report.changed_files).toEqual(['src/auth.ts'])
    expect(result.report.seed_count).toBe(1)
    expect(result.report.verbose_payload_tokens).toBeGreaterThan(result.report.compact_payload_tokens)
    expect(result.report.verbose_prompt_tokens).toBe(estimateQueryTokens(verbosePrompt))
    expect(result.report.compact_prompt_tokens).toBe(estimateQueryTokens(compactPrompt))
    expect(result.report.reduction_ratio).toBeGreaterThan(1)
    expect(verbosePrompt).toContain('"changed_files"')
    expect(compactPrompt).toContain('"review_context"')
    expect(compactPrompt).toContain('"supporting_paths"')
  })

  it('allows nested output directories whose parent does not exist yet', () => {
    const root = createRepo()
    repoRoots.push(root)

    const result = generateReviewCompareArtifacts({
      graphPath: join(root, 'graphify-out', 'graph.json'),
      outputDir: join(root, 'graphify-out', 'review-compare', 'session1'),
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      now: new Date('2026-05-01T21:00:00.000Z'),
    })

    expect(result.report.paths.output_dir).toContain(join('review-compare', 'session1'))
    expect(readFileSync(result.report.paths.verbose_prompt, 'utf8')).toContain('"changed_files"')
    expect(readFileSync(result.report.paths.compact_prompt, 'utf8')).toContain('"review_context"')
  })

  it('executes review compare prompts sequentially and saves answer artifacts', async () => {
    const root = createRepo()
    repoRoots.push(root)
    const executions: Array<{ mode: string; promptFile: string; outputFile: string }> = []

    const result = await executeReviewCompareRuns(
      {
        graphPath: join(root, 'graphify-out', 'graph.json'),
        outputDir: join(root, 'graphify-out', 'review-compare'),
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        now: new Date('2026-05-01T21:00:00.000Z'),
      },
      {
        runner: async (execution) => {
          executions.push(execution)
          return {
            exitCode: 0,
            stdout: `${execution.mode} answer\n`,
            stderr: '',
            elapsedMs: execution.mode === 'verbose' ? 15 : 9,
          }
        },
      },
    )

    expect(executions.map((execution) => execution.mode)).toEqual(['verbose', 'compact'])
    expect(readFileSync(result.report.answer_paths.verbose, 'utf8')).toBe('verbose answer\n')
    expect(readFileSync(result.report.answer_paths.compact, 'utf8')).toBe('compact answer\n')
    expect(result.report.status).toEqual({
      verbose: 'succeeded',
      compact: 'succeeded',
    })
    expect(result.report.elapsed_ms).toEqual({
      verbose: 15,
      compact: 9,
    })
    expect(formatReviewCompareSummary(result)).toContain('Prompt tokens')
  })
})
