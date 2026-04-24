import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

function writeProjectFiles(projectRoot: string = PROJECT_FIXTURE_ROOT): void {
  for (const [relativePath, content] of Object.entries(makeProjectFiles())) {
    const absolutePath = join(projectRoot, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, `${content}\n`, 'utf8')
  }
}

function writeManifestFixture(
  projectRoot: string = PROJECT_FIXTURE_ROOT,
  graphFixtureRoot: string = GRAPH_FIXTURE_ROOT,
  extraPaths: string[] = [],
): string {
  const manifestPath = join(graphFixtureRoot, 'manifest.json')
  const allPaths = [
    ...Object.keys(makeProjectFiles()).map((relativePath) => join(projectRoot, relativePath)),
    ...extraPaths,
  ]
  saveManifest(
    {
      code: allPaths.filter((path) => path.endsWith('.ts')),
      document: allPaths.filter((path) => path.endsWith('.md') || path.endsWith('.txt') || path.endsWith('.docx') || path.endsWith('.xlsx')),
      paper: allPaths.filter((path) => path.endsWith('.pdf')),
      image: allPaths.filter((path) => path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.gif') || path.endsWith('.webp') || path.endsWith('.svg')),
      audio: allPaths.filter((path) => path.endsWith('.mp3') || path.endsWith('.wav') || path.endsWith('.ogg') || path.endsWith('.opus') || path.endsWith('.m4a') || path.endsWith('.flac') || path.endsWith('.aac')),
      video: allPaths.filter((path) => path.endsWith('.mp4') || path.endsWith('.mov') || path.endsWith('.mkv') || path.endsWith('.avi') || path.endsWith('.webm') || path.endsWith('.m4v')),
    },
    manifestPath,
  )
  return manifestPath
}

function writeGraphFixture(graph: KnowledgeGraph, graphFixtureRoot: string = GRAPH_FIXTURE_ROOT): string {
  mkdirSync(graphFixtureRoot, { recursive: true })
  const graphPath = join(graphFixtureRoot, 'graph.json')
  toJson(graph, { 0: ['auth_user', 'session_manager'], 1: ['session_store'] }, graphPath)
  return graphPath
}

function writeDocxFixture(filePath: string, title: string, paragraph: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const archive = zipSync({
    'docProps/core.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`,
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1" /></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2" /></w:pPr><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  })
  writeFileSync(filePath, Buffer.from(archive))
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

  it('writes prompt artifacts and report with reduction ratio and saved file paths', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    writeManifestFixture()
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
      execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
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
    expect(baselinePrompt).toContain('The login flow starts in the HTTP route')
    expect(graphifyPrompt).toContain('Retrieved graph context:')
    expect(savedReport).toEqual(
      expect.objectContaining({
        question: 'how does login create a session',
        exec_command: 'external-template',
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
  })

  it.runIf(process.platform !== 'win32')('derives manifest-backed corpus entries from a symlinked checkout path', () => {
    const sandboxRoot = resolve('graphify-out', 'test-runtime', 'compare-runtime-symlinked-checkout')
    const realProjectRoot = join(sandboxRoot, 'real-project')
    const linkedProjectRoot = join(sandboxRoot, 'linked-project')
    const linkedGraphRoot = join(linkedProjectRoot, 'graphify-out')

    rmSync(sandboxRoot, { recursive: true, force: true })
    mkdirSync(realProjectRoot, { recursive: true })
    symlinkSync(realProjectRoot, linkedProjectRoot, 'dir')

    try {
      const graph = makeGraph()
      writeProjectFiles(realProjectRoot)
      const graphPath = writeGraphFixture(graph, linkedGraphRoot)
      writeManifestFixture(linkedProjectRoot, linkedGraphRoot)

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      })

      const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
      expect(baselinePrompt).toContain('The login flow starts in the HTTP route')
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('skips manifest symlinks that escape the project root', () => {
    const sandboxRoot = resolve('graphify-out', 'test-runtime', 'compare-runtime-symlink-escape')
    const projectRoot = join(sandboxRoot, 'project')
    const graphRoot = join(projectRoot, 'graphify-out')
    const outsideRoot = join(sandboxRoot, 'outside')
    const outsideFile = join(outsideRoot, 'outside-secret.md')
    const escapedLink = join(projectRoot, 'docs', 'outside-secret.md')

    rmSync(sandboxRoot, { recursive: true, force: true })
    mkdirSync(outsideRoot, { recursive: true })
    writeFileSync(outsideFile, 'outside secret should never enter the baseline prompt\n', 'utf8')

    try {
      const graph = makeGraph()
      writeProjectFiles(projectRoot)
      const graphPath = writeGraphFixture(graph, graphRoot)
      mkdirSync(dirname(escapedLink), { recursive: true })
      symlinkSync(outsideFile, escapedLink, 'file')
      writeManifestFixture(projectRoot, graphRoot, [escapedLink])

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      })

      const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
      expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
      expect(baselinePrompt).not.toContain('outside secret should never enter the baseline prompt')
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true })
    }
  })

  it('rejects manifest-backed corpus files that drift from the graph snapshot', () => {
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
        execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/out of sync|regenerate/i)
  })

  it('derives manifest-backed office documents through extracted text', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const docxPath = join(PROJECT_FIXTURE_ROOT, 'docs', 'office-guide.docx')
    writeDocxFixture(docxPath, 'Office Guide', 'Quarterly roadmap notes')
    writeManifestFixture(PROJECT_FIXTURE_ROOT, GRAPH_FIXTURE_ROOT, [docxPath])

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(baselinePrompt).toContain('Office Guide')
    expect(baselinePrompt).toContain('Quarterly roadmap notes')
  })

  it('rejects manifest-backed office documents when text extraction yields no corpus text', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const docxPath = join(PROJECT_FIXTURE_ROOT, 'docs', 'broken-office-guide.docx')
    mkdirSync(dirname(docxPath), { recursive: true })
    writeFileSync(docxPath, Buffer.from('not-a-docx-archive'))
    writeManifestFixture(PROJECT_FIXTURE_ROOT, GRAPH_FIXTURE_ROOT, [docxPath])

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/non-text|baseline text|docx/i)
  })

  it('rejects manifest-backed binary corpus files without a baseline text representation', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const imagePath = join(PROJECT_FIXTURE_ROOT, 'images', 'diagram.png')
    mkdirSync(dirname(imagePath), { recursive: true })
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeManifestFixture(PROJECT_FIXTURE_ROOT, GRAPH_FIXTURE_ROOT, [imagePath])

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'OPENAI_API_KEY=sk-test claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/non-text|png|baseline text/i)
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
