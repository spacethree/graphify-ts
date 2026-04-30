import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { describe, expect, it, vi } from 'vitest'

describe('retrieve semantic path', () => {
  it('adds semantic-only matches when lexical retrieval misses', async () => {
    vi.resetModules()
    vi.doMock('../../src/runtime/semantic.js', () => ({
      rankCandidatesBySemanticSimilarity: vi.fn(async () => new Map([['ledger_repo', 0.82], ['logger', 0.12]])),
      rerankCandidatesWithCrossEncoder: vi.fn(async () => new Map()),
      DEFAULT_SEMANTIC_MODEL: 'mock-semantic-model',
      DEFAULT_RERANK_MODEL: 'mock-rerank-model',
    }))

    const { retrieveContextAsync } = await import('../../src/runtime/retrieve.js')
    const graph = new KnowledgeGraph()
    graph.addNode('ledger_repo', {
      label: 'LedgerRepository',
      file_type: 'code',
      source_file: '/src/ledger.ts',
      source_location: 'L4-L6',
      snippet: 'class LedgerRepository {\n  saveInvoice() {}\n}',
    })
    graph.addNode('logger', {
      label: 'Logger',
      file_type: 'code',
      source_file: '/src/logger.ts',
      source_location: 'L1-L3',
      snippet: 'class Logger {\n  info() {}\n}',
    })

    const result = await retrieveContextAsync(graph, {
      question: 'where is invoice persistence handled',
      budget: 3000,
      semantic: true,
    })

    expect(result.matched_nodes[0]?.label).toBe('LedgerRepository')
    expect(result.matched_nodes[0]?.snippet).toContain('saveInvoice')
  })

  it('lets the reranker reorder the semantic candidate pool', async () => {
    vi.resetModules()
    vi.doMock('../../src/runtime/semantic.js', () => ({
      rankCandidatesBySemanticSimilarity: vi.fn(async () => new Map([
        ['invoice_service', 0.9],
        ['archive_store', 0.8],
      ])),
      rerankCandidatesWithCrossEncoder: vi.fn(async () => new Map([
        ['invoice_service', 0.1],
        ['archive_store', 0.99],
      ])),
      DEFAULT_SEMANTIC_MODEL: 'mock-semantic-model',
      DEFAULT_RERANK_MODEL: 'mock-rerank-model',
    }))

    const { retrieveContextAsync } = await import('../../src/runtime/retrieve.js')
    const graph = new KnowledgeGraph()
    graph.addNode('invoice_service', {
      label: 'InvoiceService',
      file_type: 'code',
      source_file: '/src/invoice-service.ts',
      source_location: 'L2-L4',
      snippet: 'class InvoiceService {\n  createInvoice() {}\n}',
    })
    graph.addNode('archive_store', {
      label: 'ArchiveStore',
      file_type: 'code',
      source_file: '/src/archive-store.ts',
      source_location: 'L8-L10',
      snippet: 'class ArchiveStore {\n  loadInvoiceHistory() {}\n}',
    })

    const result = await retrieveContextAsync(graph, {
      question: 'where is invoice history stored',
      budget: 3000,
      semantic: true,
      rerank: true,
    })

    expect(result.matched_nodes[0]?.label).toBe('ArchiveStore')
  })
})
