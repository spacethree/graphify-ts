import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { strToU8, zipSync } from 'fflate'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  buildBaselinePromptPack,
  buildGraphifyPromptPack,
  generateCompareArtifacts,
  resolveCompareQuestions,
} from '../../src/infrastructure/compare.js'
import { saveManifest } from '../../src/pipeline/manifest.js'
import { toJson } from '../../src/pipeline/export.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { MAX_TEXT_BYTES } from '../../src/shared/security.js'

const PROJECT_FIXTURE_ROOT = resolve('graphify-out', 'test-runtime', 'compare-runtime-project')
const GRAPH_FIXTURE_ROOT = join(PROJECT_FIXTURE_ROOT, 'graphify-out')
const COMPARE_OUTPUT_ROOT = resolve('graphify-out', 'compare', 'test-runtime')

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('auth_user', {
    label: 'authenticateUser',
    source_file: 'src/auth.ts',
    source_location: 'L10',
    line_number: 10,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_manager', {
    label: 'SessionManager',
    source_file: 'src/session.ts',
    source_location: 'L3',
    line_number: 3,
    node_kind: 'class',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_store', {
    label: 'SessionStore',
    source_file: 'src/session-store.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'class',
    file_type: 'code',
    community: 1,
  })
  graph.addEdge('auth_user', 'session_manager', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: 'src/auth.ts',
  })
  graph.addEdge('session_manager', 'session_store', {
    relation: 'uses',
    confidence: 'EXTRACTED',
    source_file: 'src/session.ts',
  })
  return graph
}

function makeProjectFiles(): Record<string, string> {
  return {
    'src/auth.ts': [
      'export function authenticateUser(credentials) {',
      '  return new SessionManager().createSession(credentials.userId)',
      '}',
    ].join('\n'),
    'src/session.ts': [
      'export class SessionManager {',
      '  createSession(userId) {',
      '    return new SessionStore().write(userId)',
      '  }',
      '}',
    ].join('\n'),
    'src/session-store.ts': [
      'export class SessionStore {',
      '  write(userId) {',
      '    return `session:${userId}`',
      '  }',
      '}',
    ].join('\n'),
    'src/routes.ts': [
      'export function registerRoutes(app) {',
      '  app.post("/login", authenticateUser)',
      '  app.get("/health", () => "ok")',
      '}',
    ].join('\n'),
    'src/config.ts': [
      'export const config = {',
      '  sessionCookieName: "sid",',
      '  sessionTtlSeconds: 86400,',
      '  loginAuditChannel: "auth-login",',
      '}',
    ].join('\n'),
    'docs/architecture.md': [
      'The login flow starts in the HTTP route, validates credentials, and writes a session through the session manager.',
      'The billing system, reporting jobs, and queue worker are unrelated to login but live in the same repository corpus.',
      'This full-corpus baseline intentionally includes unrelated material so the compare prompt has more naive context to carry.',
    ].join('\n'),
    'src/billing.ts': [
      'export function buildInvoiceSummary(accountId) {',
      '  return { accountId, total: 0, currency: "USD" }',
      '}',
    ].join('\n'),
    'src/reports.ts': [
      'export function buildMonthlyRevenueReport() {',
      '  return []',
      '}',
    ].join('\n'),
  }
}

function makeCorpusText(): string {
  return Object.entries(makeProjectFiles())
    .flatMap(([path, content]) => [path, content, ''])
    .join('\n')
    .trimEnd()
}

function makeGraphBackedNonCodeFixture(kind: 'pdf' | 'docx' | 'xlsx'): {
  relativePath: string
  fileType: 'paper' | 'document'
  nodeLabel: string
  expectedExcerpt: string
  content: Buffer | string
} {
  if (kind === 'pdf') {
    return {
      relativePath: 'docs/login-flow.pdf',
      fileType: 'paper',
      nodeLabel: 'Login Flow PDF',
      expectedExcerpt: 'PDF login flow creates a session token',
      content: [
        '%PDF-1.4',
        '1 0 obj',
        '<< /Title (Login Flow PDF) /Author (graphify-ts) /Subject (Authentication) >>',
        'endobj',
        'BT',
        '(PDF login flow creates a session token) Tj',
        'ET',
      ].join('\n'),
    }
  }

  if (kind === 'docx') {
    return {
      relativePath: 'docs/login-flow.docx',
      fileType: 'document',
      nodeLabel: 'Login Flow Docx',
      expectedExcerpt: 'DOCX login flow creates a session token',
      content: Buffer.from(
        zipSync({
          'word/document.xml': strToU8(
            [
              '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
              '  <w:body>',
              '    <w:p><w:r><w:t>DOCX login flow creates a session token</w:t></w:r></w:p>',
              '  </w:body>',
              '</w:document>',
            ].join(''),
          ),
          'docProps/core.xml': strToU8(
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Login Flow Docx</dc:title></cp:coreProperties>',
          ),
        }),
      ),
    }
  }

  return {
    relativePath: 'docs/login-flow.xlsx',
    fileType: 'document',
    nodeLabel: 'Login Flow Workbook',
    expectedExcerpt: 'XLSX login flow creates a session token',
    content: Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8(
          [
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <sheets>',
            '    <sheet name="LoginFlow" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
            '  </sheets>',
            '</workbook>',
          ].join(''),
        ),
        'xl/sharedStrings.xml': strToU8(
          [
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <si><t>XLSX login flow creates a session token</t></si>',
            '</sst>',
          ].join(''),
        ),
      }),
    ),
  }
}

function makeLongGraphBackedExcerpt(kind: 'pdf' | 'docx' | 'xlsx'): string {
  return `${kind.toUpperCase()} login flow creates a session token ${'and preserves long extracted context '.repeat(8)}`.trim()
}

function makeSingleSourceGraph(relativePath: string, nodeLabel: string, fileType: 'paper' | 'document'): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('graph_backed_source', {
    label: nodeLabel,
    source_file: relativePath,
    source_location: 'L1',
    line_number: 1,
    node_kind: 'document',
    file_type: fileType,
    community: 0,
  })
  return graph
}

function writeProjectFiles(projectRoot: string = PROJECT_FIXTURE_ROOT): void {
  for (const [relativePath, content] of Object.entries(makeProjectFiles())) {
    const absolutePath = join(projectRoot, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, `${content}\n`, 'utf8')
  }
}

function writeGraphFixture(graph: KnowledgeGraph, graphFixtureRoot: string = GRAPH_FIXTURE_ROOT): string {
  mkdirSync(graphFixtureRoot, { recursive: true })
  const graphPath = join(graphFixtureRoot, 'graph.json')
  toJson(graph, { 0: ['auth_user', 'session_manager'], 1: ['session_store'] }, graphPath)
  return graphPath
}

function writeManifestFixture(projectRoot: string = PROJECT_FIXTURE_ROOT, graphFixtureRoot: string = GRAPH_FIXTURE_ROOT): string {
  const manifestPath = join(graphFixtureRoot, 'manifest.json')
  saveManifest(
    {
      code: Object.keys(makeProjectFiles())
        .filter((relativePath) => relativePath.endsWith('.ts'))
        .map((relativePath) => join(projectRoot, relativePath)),
      document: [],
      paper: [],
      image: [],
      audio: [],
      video: [],
    },
    manifestPath,
  )
  return manifestPath
}

beforeEach(() => {
  rmSync(PROJECT_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(GRAPH_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(COMPARE_OUTPUT_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(PROJECT_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(GRAPH_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(COMPARE_OUTPUT_ROOT, { recursive: true, force: true })
})

describe('compare runtime', () => {
  it('builds a baseline prompt pack from graph and corpus input', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()

    const fullPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'full',
    })
    const boundedPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'bounded',
      maxTokens: 120,
    })

    expect(fullPack.prompt).toContain('Question:\nhow does login create a session')
    expect(fullPack.prompt).toContain('authenticateUser')
    expect(fullPack.prompt).toContain('SessionManager')
    expect(boundedPack.prompt).toContain('[bounded baseline excerpt]')
    expect(boundedPack.prompt.length).toBeLessThan(fullPack.prompt.length)
    expect(estimateQueryTokens(boundedPack.prompt)).toBeLessThanOrEqual(120)
  })

  it('rejects bounded baseline budgets below the prompt floor', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()

    expect(() =>
      buildBaselinePromptPack({
        question: 'how does login create a session',
        graph,
        corpusText,
        mode: 'bounded',
        maxTokens: 10,
      }),
    ).toThrow(/too small/i)

    expect(() =>
      buildBaselinePromptPack({
        question: 'how does login create a session',
        graph,
        corpusText: '',
        mode: 'bounded',
        maxTokens: 10,
      }),
    ).toThrow(/too small/i)
  })

  it('builds a graphify prompt pack from existing retrieval output', () => {
    const graph = makeGraph()
    const retrieval = retrieveContext(graph, {
      question: 'how does login create a session',
      budget: 3000,
    })

    const pack = buildGraphifyPromptPack({ question: retrieval.question, retrieval })

    expect(pack.prompt).toContain('Retrieved graph context:')
    expect(pack.prompt).toContain('authenticateUser')
    expect(pack.prompt).toContain('SessionManager')
    expect(pack.prompt).toContain('calls')
  })

  it('computes prompt token counts from the exact prompt text', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()
    const retrieval = retrieveContext(graph, {
      question: 'how does login create a session',
      budget: 3000,
    })

    const baselinePack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'full',
    })
    const graphifyPack = buildGraphifyPromptPack({
      question: retrieval.question,
      retrieval,
    })

    expect(baselinePack.token_count).toBe(estimateQueryTokens(baselinePack.prompt))
    expect(graphifyPack.token_count).toBe(estimateQueryTokens(graphifyPack.prompt))
  })

  it('writes prompt artifacts and report from graph-backed files when corpusText is omitted', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const execTemplate = 'OPENAI_API_KEY=super-secret claude -p "$(cat {prompt_file})"'
    const questionsPath = join(GRAPH_FIXTURE_ROOT, 'compare-questions.json')
    writeFileSync(
      questionsPath,
      JSON.stringify([{ question: 'how does login create a session', expected_labels: ['authenticateUser'] }], null, 2),
      'utf8',
    )

    const result = generateCompareArtifacts({
      graphPath,
      questionsPath,
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate,
      baselineMode: 'full',
      limit: 1,
      now: new Date('2026-04-24T19:30:00Z'),
    })

    expect(result.reports).toHaveLength(1)
    const report = result.reports[0]
    expect(report).toBeDefined()
    expect(report?.reduction_ratio).toBe(
      Number(((report!.baseline_prompt_tokens || 0) / (report!.graphify_prompt_tokens || 1)).toFixed(1)),
    )
    expect(report?.paths.output_dir).toBe(resolve('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00'))
    expect(report?.status.baseline).toBe('not_run')
    expect(report?.status.graphify).toBe('not_run')
    expect(existsSync(report!.paths.baseline_prompt)).toBe(true)
    expect(existsSync(report!.paths.graphify_prompt)).toBe(true)
    expect(existsSync(report!.paths.report)).toBe(true)

    const baselinePrompt = readFileSync(report!.paths.baseline_prompt, 'utf8')
    const graphifyPrompt = readFileSync(report!.paths.graphify_prompt, 'utf8')
    const savedReport = JSON.parse(readFileSync(report!.paths.report, 'utf8')) as Record<string, unknown>

    expect(baselinePrompt).toContain('Question:\nhow does login create a session')
    expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
    expect(baselinePrompt).toContain('export class SessionManager')
    expect(graphifyPrompt).toContain('Retrieved graph context:')
    expect(savedReport).toEqual(
      expect.objectContaining({
        question: 'how does login create a session',
        exec_command: {
          command: null,
          placeholders: ['{prompt_file}'],
          redacted: true,
        },
        graph_path: join('graphify-out', 'test-runtime', 'compare-runtime-project', 'graphify-out', 'graph.json'),
        baseline_prompt_tokens: estimateQueryTokens(baselinePrompt),
        graphify_prompt_tokens: estimateQueryTokens(graphifyPrompt),
        reduction_ratio: report!.reduction_ratio,
        paths: {
          output_dir: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00'),
          baseline_prompt: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'baseline-prompt.txt'),
          graphify_prompt: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'graphify-prompt.txt'),
          report: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'report.json'),
        },
      }),
    )
    expect(JSON.stringify(savedReport)).not.toContain('super-secret')
    expect(JSON.stringify(savedReport)).not.toContain(execTemplate)
  })

  it('loads graphify snippets relative to the inferred project root instead of the current cwd', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const originalCwd = process.cwd()
    const alternateCwd = join(PROJECT_FIXTURE_ROOT, 'tools', 'runner')
    mkdirSync(alternateCwd, { recursive: true })

    try {
      process.chdir(alternateCwd)
      const alternateOutputRoot = join(alternateCwd, 'graphify-out', 'compare', 'alternate-cwd')

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: alternateOutputRoot,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      const graphifyPrompt = readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')
      expect(graphifyPrompt).toContain('createSession(userId) {')
      expect(graphifyPrompt).toContain('return new SessionStore().write(userId)')
    } finally {
      process.chdir(originalCwd)
      rmSync(join(alternateCwd, 'graphify-out'), { recursive: true, force: true })
    }
  })

  it('does not load graphify snippets from paths outside the inferred project root', () => {
    const graph = makeGraph()
    graph.addNode('secret_leak', {
      label: 'SecretLeak',
      source_file: '../../../outside-secret.txt',
      source_location: 'L1',
      line_number: 1,
      node_kind: 'file',
      file_type: 'code',
      community: 0,
    })
    writeProjectFiles()
    const outsideSecretPath = resolve(PROJECT_FIXTURE_ROOT, '..', '..', '..', 'outside-secret.txt')
    writeFileSync(outsideSecretPath, 'TOP SECRET compare snippet\n', 'utf8')
    const graphPath = writeGraphFixture(graph)

    try {
      const result = generateCompareArtifacts({
        graphPath,
        question: 'where is the secret leak',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      const graphifyPrompt = readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')
      expect(graphifyPrompt).toContain('SecretLeak')
      expect(graphifyPrompt).not.toContain('TOP SECRET compare snippet')
    } finally {
      rmSync(outsideSecretPath, { force: true })
    }
  })

  it('creates a collision-safe compare output directory for repeated runs at the same timestamp', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const input = {
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full' as const,
      now: new Date('2026-04-24T19:30:00.000Z'),
    }

    const firstResult = generateCompareArtifacts(input)
    const secondResult = generateCompareArtifacts(input)

    expect(firstResult.output_root).not.toBe(secondResult.output_root)
    expect(firstResult.reports[0]?.paths.output_dir).not.toBe(secondResult.reports[0]?.paths.output_dir)
    expect(existsSync(firstResult.reports[0]!.paths.baseline_prompt)).toBe(true)
    expect(existsSync(secondResult.reports[0]!.paths.baseline_prompt)).toBe(true)
  })

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'writes prompt artifacts from graph-backed %s sources when corpusText is omitted',
    (kind) => {
      const fixture = makeGraphBackedNonCodeFixture(kind)
      const graph = makeSingleSourceGraph(fixture.relativePath, fixture.nodeLabel, fixture.fileType)
      const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)

      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, fixture.content)

      const graphPath = writeGraphFixture(graph)

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      })

      const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
      expect(baselinePrompt).toContain(fixture.expectedExcerpt)
      expect(existsSync(result.reports[0]!.paths.graphify_prompt)).toBe(true)
      expect(existsSync(result.reports[0]!.paths.report)).toBe(true)
    },
  )

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'fails explicitly when graph-backed %s baseline extraction cannot produce text',
    (kind) => {
      const fixture = makeGraphBackedNonCodeFixture(kind)
      const graph = makeGraph()
      graph.addNode(`broken_${kind}_source`, {
        label: fixture.nodeLabel,
        source_file: fixture.relativePath,
        source_location: 'L1',
        line_number: 1,
        node_kind: 'document',
        file_type: fixture.fileType,
        community: 0,
      })

      writeProjectFiles()

      const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(
        absolutePath,
        kind === 'pdf'
          ? [
              '%PDF-1.4',
              '1 0 obj',
              '<< /Producer (graphify-ts) >>',
              'endobj',
            ].join('\n')
          : Buffer.from('not-a-zip-archive'),
      )

      const graphPath = writeGraphFixture(graph)

      expect(() =>
        generateCompareArtifacts({
          graphPath,
          question: 'how does login create a session',
          outputDir: COMPARE_OUTPUT_ROOT,
          execTemplate: 'claude -p "$(cat {prompt_file})"',
          baselineMode: 'full',
          now: new Date('2026-04-24T19:30:00.000Z'),
        }),
      ).toThrow(/could not extract text|failed to extract/i)
    },
  )

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'preserves long extracted lines from graph-backed %s sources when corpusText is omitted',
    (kind) => {
      const fixture = makeGraphBackedNonCodeFixture(kind)
      const longExcerpt = makeLongGraphBackedExcerpt(kind)
      const graph = makeSingleSourceGraph(fixture.relativePath, fixture.nodeLabel, fixture.fileType)
      const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)

      mkdirSync(dirname(absolutePath), { recursive: true })
      if (kind === 'pdf') {
        writeFileSync(
          absolutePath,
          [
            '%PDF-1.4',
            '1 0 obj',
            '<< /Title (Login Flow PDF) /Author (graphify-ts) /Subject (Authentication) >>',
            'endobj',
            'BT',
            `(${longExcerpt}) Tj`,
            'ET',
          ].join('\n'),
        )
      } else if (kind === 'docx') {
        writeFileSync(
          absolutePath,
          Buffer.from(
            zipSync({
              'word/document.xml': strToU8(
                [
                  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
                  '  <w:body>',
                  `    <w:p><w:r><w:t>${longExcerpt}</w:t></w:r></w:p>`,
                  '  </w:body>',
                  '</w:document>',
                ].join(''),
              ),
            }),
          ),
        )
      } else {
        writeFileSync(
          absolutePath,
          Buffer.from(
            zipSync({
              'xl/workbook.xml': strToU8(
                [
                  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
                  '  <sheets>',
                  '    <sheet name="LoginFlow" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
                  '  </sheets>',
                  '</workbook>',
                ].join(''),
              ),
              'xl/sharedStrings.xml': strToU8(
                [
                  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
                  `  <si><t>${longExcerpt}</t></si>`,
                  '</sst>',
                ].join(''),
              ),
            }),
          ),
        )
      }

      const graphPath = writeGraphFixture(graph)

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      })

      const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
      expect(longExcerpt.length).toBeGreaterThan(256)
      expect(baselinePrompt).toContain(longExcerpt)
    },
  )

  it('preserves long XLSX core metadata lines when corpusText is omitted', () => {
    const longTitle = `Workbook title ${'preserves long extracted core metadata '.repeat(8)}`.trim()
    const fixture = makeGraphBackedNonCodeFixture('xlsx')
    const graph = makeSingleSourceGraph(fixture.relativePath, fixture.nodeLabel, fixture.fileType)
    const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)

    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(
      absolutePath,
      Buffer.from(
        zipSync({
          'docProps/core.xml': strToU8(
            `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${longTitle}</dc:title></cp:coreProperties>`,
          ),
          'xl/workbook.xml': strToU8(
            [
              '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
              '  <sheets>',
              '    <sheet name="LoginFlow" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
              '  </sheets>',
              '</workbook>',
            ].join(''),
          ),
          'xl/sharedStrings.xml': strToU8(
            [
              '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
              '  <si><t>XLSX login flow creates a session token</t></si>',
              '</sst>',
            ].join(''),
          ),
        }),
      ),
    )

    const graphPath = writeGraphFixture(graph)
    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(longTitle.length).toBeGreaterThan(256)
    expect(baselinePrompt).toContain(longTitle)
  })

  it('ignores manifest-only files when deriving the runtime baseline corpus', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const manifestOnlyDocPath = join(GRAPH_FIXTURE_ROOT, 'manifest.json')
    mkdirSync(dirname(manifestOnlyDocPath), { recursive: true })
    writeFileSync(
      manifestOnlyDocPath,
      JSON.stringify({
        [join(PROJECT_FIXTURE_ROOT, 'docs', 'manifest-only.md')]:
          123,
      }, null, 2),
      'utf8',
    )
    const manifestOnlyDocFilePath = join(PROJECT_FIXTURE_ROOT, 'docs', 'manifest-only.md')
    mkdirSync(dirname(manifestOnlyDocFilePath), { recursive: true })
    writeFileSync(manifestOnlyDocFilePath, 'manifest-only notes that should not appear in the compare baseline prompt\n', 'utf8')

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
    expect(baselinePrompt).not.toContain('manifest-only notes that should not appear in the compare baseline prompt')
  })

  it('fails when a graph-backed text file is missing from the local runtime corpus', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    rmSync(join(PROJECT_FIXTURE_ROOT, 'src', 'session.ts'))

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/graph-backed file/i)
  })

  it('fails when a graph-backed text file drifts from the saved graph snapshot manifest', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    writeManifestFixture()
    writeFileSync(join(PROJECT_FIXTURE_ROOT, 'src', 'auth.ts'), 'export const drifted = true\n', 'utf8')

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/out of sync|graph-backed file/i)
  })

  it('fails when an adjacent manifest exists but is invalid', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    writeFileSync(join(GRAPH_FIXTURE_ROOT, 'manifest.json'), '{not valid json', 'utf8')

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/manifest/i)
  })

  it('skips oversized graph-backed text files instead of aborting compare generation', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    writeFileSync(join(PROJECT_FIXTURE_ROOT, 'src', 'session.ts'), `${'a'.repeat(MAX_TEXT_BYTES + 1)}\n`, 'utf8')

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
    expect(baselinePrompt).not.toContain('export class SessionManager')
  })

  it('rejects ambiguous question sources and invalid limits', () => {
    expect(() =>
      resolveCompareQuestions({
        question: 'how does login create a session',
        questionsPath: 'compare-questions.json',
        limit: 1,
      }),
    ).toThrow(/either a single question or a questions path/i)

    expect(() =>
      resolveCompareQuestions({
        question: 'how does login create a session',
        limit: 0,
      }),
    ).toThrow(/positive integer/i)
  })
})
