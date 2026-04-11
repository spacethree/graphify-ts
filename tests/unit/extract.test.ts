import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'

import { cacheDir, fileHash } from '../../src/infrastructure/cache.js'
import { detect } from '../../src/pipeline/detect.js'
import { _makeId, collectFiles, extract, extractJs, extractPython } from '../../src/pipeline/extract.js'
import { MAX_TEXT_BYTES } from '../../src/shared/security.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

describe('extract', () => {
  function createTempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'graphify-ts-extract-'))
  }

  it('builds stable ids without leading punctuation', () => {
    expect(_makeId('_auth')).toBe('auth')
    expect(_makeId('.httpx._client')).toBe('httpx_client')
    expect(_makeId('foo', 'Bar')).toBe(_makeId('foo', 'Bar'))
    expect(_makeId('__init__').startsWith('_')).toBe(false)
    expect(_makeId('__init__').endsWith('_')).toBe(false)
  })

  it('extracts python classes and methods', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample.py'))
    const labels = result.nodes.map((node) => node.label)

    expect(labels).toContain('Transformer')
    expect(labels.some((label) => label.includes('__init__') || label.includes('forward'))).toBe(true)
  })

  it('keeps python structural edges deterministic', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample.py'))
    const structural = new Set(['contains', 'method', 'inherits', 'imports', 'imports_from'])
    for (const edge of result.edges) {
      if (structural.has(edge.relation)) {
        expect(edge.confidence).toBe('EXTRACTED')
      }
    }
  })

  it('extracts python calls without self loops or duplicates', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample_calls.py'))
    const callEdges = result.edges.filter((edge) => edge.relation === 'calls')
    const callPairs = callEdges.map((edge) => `${edge.source}->${edge.target}`)

    expect(callEdges.length).toBeGreaterThan(0)
    expect(callPairs.length).toBe(new Set(callPairs).size)

    for (const edge of callEdges) {
      expect(edge.confidence).toBe('EXTRACTED')
      expect(edge.weight).toBe(1)
      expect(edge.source).not.toBe(edge.target)
    }
  })

  it('extracts the expected python call relationships', () => {
    const result = extractPython(join(FIXTURES_DIR, 'sample_calls.py'))
    const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${edge.source}->${edge.target}`))
    const nodeByLabel = new Map(result.nodes.map((node) => [node.label, node.id]))

    expect(calls.has(`${nodeByLabel.get('run_analysis()')}->${nodeByLabel.get('compute_score()')}`)).toBe(true)
    expect(calls.has(`${nodeByLabel.get('run_analysis()')}->${nodeByLabel.get('normalize()')}`)).toBe(true)
    expect(calls.has(`${nodeByLabel.get('.process()')}->${nodeByLabel.get('run_analysis()')}`)).toBe(true)
  })

  it('resolves cross-file python imports into inferred class relationships', () => {
    const root = createTempRoot()
    try {
      const modelsPath = join(root, 'models.py')
      const authPath = join(root, 'auth.py')

      writeFileSync(
        modelsPath,
        [
          'class Response:',
          '    pass',
          '',
          'class BaseAuth:',
          '    pass',
        ].join('\n'),
        'utf8',
      )

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

      const result = extract([authPath, modelsPath])
      const digestAuthId = result.nodes.find((node) => node.label === 'DigestAuth')?.id
      const responseId = result.nodes.find((node) => node.label === 'Response')?.id
      const baseAuthId = result.nodes.find((node) => node.label === 'BaseAuth')?.id

      expect(digestAuthId).toBeTruthy()
      expect(responseId).toBeTruthy()
      expect(baseAuthId).toBeTruthy()
      expect(
        result.edges.some(
          (edge) => edge.source === digestAuthId && edge.target === responseId && edge.relation === 'uses' && edge.confidence === 'INFERRED',
        ),
      ).toBe(true)
      expect(
        result.edges.some(
          (edge) => edge.source === digestAuthId && edge.target === baseAuthId && edge.relation === 'inherits' && edge.confidence === 'INFERRED',
        ),
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts typescript classes, methods, functions, and calls', () => {
    const result = extractJs(join(FIXTURES_DIR, 'sample.ts'))
    const labels = result.nodes.map((node) => node.label)
    const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
    const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

    expect(labels).toContain('HttpClient')
    expect(labels.some((label) => label.includes('get'))).toBe(true)
    expect(labels.some((label) => label.includes('post'))).toBe(true)
    expect(labels.some((label) => label.includes('buildHeaders'))).toBe(true)
    expect(calls.has('.post()->.get()')).toBe(true)
  })

  it('extracts go structs, methods, functions, and calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.go')
      writeFileSync(
        filePath,
        [
          'package main',
          'import "net/http"',
          'type Client struct {}',
          'func (c *Client) Get() error {',
          '  return c.do()',
          '}',
          'func (c *Client) do() error {',
          '  return nil',
          '}',
          'func Build() {',
          '  helper()',
          '}',
          'func helper() {}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.Get()')
      expect(labels).toContain('.do()')
      expect(labels).toContain('Build()')
      expect(labels).toContain('helper()')
      expect(calls.has('.Get()->.do()')).toBe(true)
      expect(calls.has('Build()->helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts ruby classes, methods, functions, and calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.rb')
      writeFileSync(
        filePath,
        [
          "require 'net/http'",
          '',
          'class BaseClient',
          'end',
          '',
          'class ApiClient < BaseClient',
          '  def get',
          '    url = "https://example.com#anchor"; request()',
          '    msg = "Score: #{decorate()}"',
          '    label = "database#connection"; normalize()',
          '  end',
          '',
          '  def request',
          '  end',
          '',
          '  def normalize',
          '  end',

          '  def decorate',
          '  end',
          'end',
          '',
          'def helper',
          '  normalize_helper()',
          'end',
          '',
          'def normalize_helper',
          'end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('BaseClient')
      expect(labels).toContain('ApiClient')
      expect(labels).toContain('.get()')
      expect(labels).toContain('.request()')
      expect(labels).toContain('.normalize()')
      expect(labels).toContain('.decorate()')
      expect(labels).toContain('helper()')
      expect(labels).toContain('normalize_helper()')
      expect(result.edges.some((edge) => edge.relation === 'inherits')).toBe(true)
      expect(result.edges.some((edge) => edge.relation === 'imports')).toBe(true)
      expect(calls.has('.get()->.request()')).toBe(true)
      expect(calls.has('.get()->.normalize()')).toBe(true)
      expect(calls.has('.get()->.decorate()')).toBe(true)
      expect(calls.has('helper()->normalize_helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts ruby modules as containing owners', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'nested.rb')
      writeFileSync(
        filePath,
        [
          'module Httpx',
          '  class Client',
          '  end',
          'end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const moduleId = result.nodes.find((node) => node.label === 'Httpx')?.id
      const classId = result.nodes.find((node) => node.label === 'Client')?.id

      expect(moduleId).toBeTruthy()
      expect(classId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === moduleId && edge.target === classId && edge.relation === 'contains')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts zig structs, functions, methods, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.zig')
      writeFileSync(
        filePath,
        [
          'const std = @import("std");',
          '',
          'const Client = struct {',
          '    pub fn get(self: *Client) void {',
          '        helper();',
          '    }',
          '};',
          '',
          'fn helper() void {',
          '}',

          'fn parse() !u8 {',
          '    return 1;',
          '}',
          '',
          'pub fn main() void {',
          '    helper();',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.get()')
      expect(labels).toContain('helper()')
      expect(labels).toContain('parse()')
      expect(labels).toContain('main()')
      expect(result.edges.some((edge) => edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.get()->helper()')).toBe(true)
      expect(calls.has('main()->helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts elixir modules, functions, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.ex')
      writeFileSync(
        filePath,
        [
          'defmodule ApiClient do',
          '  alias Models.Response',
          '',
          '  def get do',
          '    request()',
          '  end',
          '',
          '  def request do',
          '  end',
          'end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('ApiClient')
      expect(labels).toContain('.get()')
      expect(labels).toContain('.request()')
      expect(result.edges.some((edge) => edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.get()->.request()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts julia structs, functions, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.jl')
      writeFileSync(
        filePath,
        [
          'using LinearAlgebra',
          '',
          'struct Client',
          'end',
          '',
          'function fetch(client)',
          '  normalize()',
          'end',
          '',
          'function normalize()',
          'end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('fetch()')
      expect(labels).toContain('normalize()')
      expect(result.edges.some((edge) => edge.relation === 'imports' || edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('fetch()->normalize()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts powershell classes, functions, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.ps1')
      writeFileSync(
        filePath,
        [
          'Import-Module Microsoft.PowerShell.Utility',
          '',
          'class ApiClient {',
          '  [void] Get() {',
          '    Invoke-Request',
          '  }',
          '}',
          '',
          'function Invoke-Request {',
          '  Normalize-Response',
          '}',
          '',
          'function Normalize-Response {',
          '}',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('ApiClient')
      expect(labels).toContain('.Get()')
      expect(labels).toContain('Invoke-Request()')
      expect(labels).toContain('Normalize-Response()')
      expect(result.edges.some((edge) => edge.relation === 'imports' || edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.Get()->Invoke-Request()')).toBe(true)
      expect(calls.has('Invoke-Request()->Normalize-Response()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts objective-c classes, methods, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.m')
      writeFileSync(
        filePath,
        [
          '#import <Foundation/Foundation.h>',
          '',
          '@interface Client : NSObject',
          '@end',
          '',
          '@implementation Client',
          '- (void)get {',
          '  [self request];',
          '}',
          '',
          '- (void)request {',
          '}',
          '@end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.get()')
      expect(labels).toContain('.request()')
      expect(result.edges.some((edge) => edge.relation === 'imports_from')).toBe(true)
      expect(calls.has('.get()->.request()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts lua tables, functions, methods, and imports', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.lua')
      writeFileSync(
        filePath,
        [
          'local http = require("http")',
          'local Client = {}',
          '',
          'function Client:get()',
          '  request()',
          'end',
          '',
          'function request()',
          'end',
        ].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Client')
      expect(labels).toContain('.get()')
      expect(labels).toContain('request()')
      expect(result.edges.some((edge) => edge.relation === 'imports')).toBe(true)
      expect(calls.has('.get()->request()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts toc metadata and file references', () => {
    const root = createTempRoot()
    try {
      const tocPath = join(root, 'Addon.toc')
      const luaPath = join(root, 'Main.lua')
      writeFileSync(luaPath, 'function main()\nend\n', 'utf8')
      writeFileSync(
        tocPath,
        [
          '## Interface: 100000',
          '## Title: Sample Addon',
          'Main.lua',
        ].join('\n'),
        'utf8',
      )

      const result = extract([tocPath, luaPath])
      const labels = result.nodes.map((node) => node.label)
      const tocId = result.nodes.find((node) => node.label === 'Addon.toc')?.id
      const titleId = result.nodes.find((node) => node.label === 'Title: Sample Addon')?.id
      const luaId = result.nodes.find((node) => node.label === 'Main.lua')?.id

      expect(labels).toContain('Addon.toc')
      expect(labels).toContain('Title: Sample Addon')
      expect(tocId).toBeTruthy()
      expect(titleId).toBeTruthy()
      expect(luaId).toBeTruthy()
      expect(result.edges.some((edge) => edge.source === tocId && edge.target === titleId && edge.relation === 'contains')).toBe(true)
      expect(result.edges.some((edge) => edge.source === tocId && edge.target === luaId && edge.relation === 'references')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts java classes, methods, and calls', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'Service.java')
      writeFileSync(
        filePath,
        ['import java.util.List;', 'class Service {', '  void run() {', '    helper();', '  }', '  void helper() {}', '}'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Service')
      expect(labels).toContain('.run()')
      expect(labels).toContain('.helper()')
      expect(calls.has('.run()->.helper()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts rust impl methods and self calls as methods on the owner type', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'worker.rs')
      writeFileSync(
        filePath,
        ['struct Worker {}', 'impl Worker {', '  fn run(&self) {', '    self.helper();', '  }', '  fn helper(&self) {}', '}', 'fn boot() {', '  Worker::run();', '}'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Worker')
      expect(labels).toContain('.run()')
      expect(labels).toContain('.helper()')
      expect(labels).toContain('boot()')
      expect(calls.has('.run()->.helper()')).toBe(true)
      expect(calls.has('boot()->.run()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts qualified c++ methods under their owner type', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'engine.cpp')
      writeFileSync(
        filePath,
        ['class Engine {', 'public:', '  void start();', '  void stop();', '};', 'void Engine::start() {', '  stop();', '}', 'void Engine::stop() {}'].join('\n'),
        'utf8',
      )

      const result = extract([filePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('Engine')
      expect(labels).toContain('.start()')
      expect(labels).toContain('.stop()')
      expect(calls.has('.start()->.stop()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts top-level arrow functions in js or ts files', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'arrow.ts')
      writeFileSync(
        filePath,
        ['const buildHeaders = (token: string) => ({ Authorization: token })', 'const makeHeaders = (token: string) => buildHeaders(token)'].join('\n'),
        'utf8',
      )

      const result = extractJs(filePath)
      const labels = result.nodes.map((node) => node.label)
      const nodeById = new Map(result.nodes.map((node) => [node.id, node.label]))
      const calls = new Set(result.edges.filter((edge) => edge.relation === 'calls').map((edge) => `${nodeById.get(edge.source)}->${nodeById.get(edge.target)}`))

      expect(labels).toContain('buildHeaders()')
      expect(labels).toContain('makeHeaders()')
      expect(calls.has('makeHeaders()->buildHeaders()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts markdown sections and local references for non-code corpora', () => {
    const root = createTempRoot()
    try {
      const readmePath = join(root, 'README.md')
      const guidePath = join(root, 'guide.md')
      const imagePath = join(root, 'diagram.svg')

      writeFileSync(readmePath, '# Overview\nSee [Guide](guide.md)\n![Diagram](diagram.svg)\n## Details\n', 'utf8')
      writeFileSync(guidePath, '# Guide\n', 'utf8')
      writeFileSync(imagePath, '<svg xmlns="http://www.w3.org/2000/svg"><title>Diagram</title></svg>', 'utf8')

      const result = extract([readmePath, guidePath, imagePath])
      const labels = result.nodes.map((node) => node.label)
      const nodeByKey = new Map(result.nodes.map((node) => [`${node.file_type}:${node.label}`, node.id]))
      const relations = new Set(result.edges.map((edge) => `${edge.source}:${edge.relation}:${edge.target}`))

      expect(labels).toContain('README.md')
      expect(labels).toContain('Overview')
      expect(labels).toContain('Details')
      expect(result.nodes.some((node) => node.file_type === 'image' && node.label === 'diagram.svg')).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:README.md')}:contains:${nodeByKey.get('document:Overview')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:Overview')}:references:${nodeByKey.get('document:guide.md')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:Overview')}:embeds:${nodeByKey.get('image:diagram.svg')}`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts detected paper files into paper nodes', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.md')
      writeFileSync(paperPath, '# Abstract\nWe propose a new system.\ndoi:10.1000/example\nSee arXiv 2401.12345\n[1] prior work\n', 'utf8')

      const detection = detect(root)
      const result = extract(detection.files.paper)
      const labels = result.nodes.map((node) => node.label)

      expect(detection.files.paper).toContain(paperPath)
      expect(result.nodes.some((node) => node.file_type === 'paper' && node.label === 'paper.md')).toBe(true)
      expect(labels).toContain('Abstract')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts heuristic title and section nodes from simple pdf papers', () => {
    const root = createTempRoot()
    try {
      const paperPath = join(root, 'paper.pdf')
      writeFileSync(
        paperPath,
        '%PDF-1.4\n1 0 obj\n<< /Title (Graphify Paper) >>\nstream\n(Abstract) Tj\n(Introduction) Tj\nendstream\nendobj\n',
        'latin1',
      )

      const result = extract([paperPath])
      const labels = result.nodes.filter((node) => node.file_type === 'paper').map((node) => node.label)

      expect(labels).toContain('paper.pdf')
      expect(labels).toContain('Graphify Paper')
      expect(labels).toContain('Abstract')
      expect(labels).toContain('Introduction')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a document node for plain text without headings', () => {
    const root = createTempRoot()
    try {
      const notesPath = join(root, 'notes.txt')
      writeFileSync(notesPath, 'Plain text with no headings at all.', 'utf8')

      const result = extract([notesPath])

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]).toMatchObject({ label: 'notes.txt', file_type: 'document' })
      expect(result.edges).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts heading structure from docx documents', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'guide.docx')
      const archive = zipSync({
        'word/document.xml': strToU8(
          [
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
            '  <w:body>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>',
            '    <w:p><w:r><w:t>Body paragraph</w:t></w:r></w:p>',
            '    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>',
            '  </w:body>',
            '</w:document>',
          ].join(''),
        ),
        'docProps/core.xml': strToU8(
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Guide Title</dc:title></cp:coreProperties>',
        ),
      })

      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath])
      const labels = result.nodes.map((node) => node.label)
      const nodeByKey = new Map(result.nodes.map((node) => [`${node.file_type}:${node.label}`, node.id]))
      const relations = new Set(result.edges.map((edge) => `${edge.source}:${edge.relation}:${edge.target}`))

      expect(labels).toContain('guide.docx')
      expect(labels).toContain('Guide Title')
      expect(labels).toContain('Overview')
      expect(labels).toContain('Details')
      expect(relations.has(`${nodeByKey.get('document:guide.docx')}:contains:${nodeByKey.get('document:Overview')}`)).toBe(true)
      expect(relations.has(`${nodeByKey.get('document:Overview')}:contains:${nodeByKey.get('document:Details')}`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a file-only node for corrupted docx archives', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'broken.docx')
      writeFileSync(docxPath, Buffer.from('not-a-zip-archive'), 'utf8')

      const result = extract([docxPath])

      expect(result.nodes.map((node) => node.label)).toEqual(['broken.docx'])
      expect(result.edges).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a file-only node for oversized docx entries', () => {
    const root = createTempRoot()
    try {
      const docxPath = join(root, 'large.docx')
      const oversizedXml = `<w:document><w:body><w:p><w:r><w:t>${'A'.repeat(4_194_305)}</w:t></w:r></w:p></w:body></w:document>`
      const archive = zipSync({
        'word/document.xml': strToU8(oversizedXml),
      })
      writeFileSync(docxPath, Buffer.from(archive))

      const result = extract([docxPath])

      expect(result.nodes.map((node) => node.label)).toEqual(['large.docx'])
      expect(result.edges).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores markdown references outside the extracted corpus', () => {
    const root = createTempRoot()
    try {
      const projectDir = join(root, 'project')
      mkdirSync(projectDir, { recursive: true })

      const readmePath = join(projectDir, 'README.md')
      const externalPath = join(root, 'secret.md')
      writeFileSync(readmePath, '# Overview\nSee [Secret](../secret.md)\n', 'utf8')
      writeFileSync(externalPath, '# Secret\n', 'utf8')

      const result = extract([readmePath])

      expect(result.nodes.some((node) => node.label === 'secret.md')).toBe(false)
      expect(result.edges.some((edge) => edge.relation === 'references')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not emit dangling internal js or ts edges', () => {
    const result = extractJs(join(FIXTURES_DIR, 'sample.ts'))
    const nodeIds = new Set(result.nodes.map((node) => node.id))

    for (const edge of result.edges) {
      if (edge.relation === 'contains' || edge.relation === 'method' || edge.relation === 'calls') {
        expect(nodeIds.has(edge.source)).toBe(true)
      }
    }
  })

  it('collects supported code files and skips hidden paths', () => {
    const files = collectFiles(FIXTURES_DIR)

    expect(files.length).toBeGreaterThan(0)
    for (const filePath of files) {
      expect(
        [
          '.py',
          '.js',
          '.ts',
          '.tsx',
          '.go',
          '.rs',
          '.java',
          '.c',
          '.cpp',
          '.cc',
          '.cxx',
          '.rb',
          '.cs',
          '.kt',
          '.kts',
          '.scala',
          '.php',
          '.h',
          '.hpp',
          '.swift',
          '.lua',
          '.toc',
          '.zig',
          '.ps1',
          '.ex',
          '.exs',
          '.m',
          '.mm',
          '.jl',
        ].includes(filePath.slice(filePath.lastIndexOf('.'))),
      ).toBe(true)
      expect(filePath.includes('/.')).toBe(false)
    }
  })

  it('collects symlinked files when requested', () => {
    const root = createTempRoot()
    try {
      const realDir = join(root, 'real_src')
      mkdirSync(realDir, { recursive: true })
      writeFileSync(join(realDir, 'lib.py'), 'x = 1', 'utf8')
      symlinkSync(realDir, join(root, 'linked_src'))

      const filesWithoutSymlinks = collectFiles(root)
      const filesWithSymlinks = collectFiles(root, { followSymlinks: true })

      expect(filesWithoutSymlinks.filter((filePath) => filePath.endsWith('lib.py'))).toHaveLength(1)
      expect(filesWithSymlinks.filter((filePath) => filePath.endsWith('lib.py'))).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('extracts multiple files with zero token counts', () => {
    const result = extract([join(FIXTURES_DIR, 'sample.py'), join(FIXTURES_DIR, 'sample.ts')])
    const sourceFiles = new Set(result.nodes.map((node) => node.source_file))

    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.input_tokens).toBe(0)
    expect(result.output_tokens).toBe(0)
    expect([...sourceFiles].some((filePath) => filePath.endsWith('sample.py'))).toBe(true)
    expect([...sourceFiles].some((filePath) => filePath.endsWith('sample.ts'))).toBe(true)
  })

  it('returns consistent cached extraction results and invalidates on file changes', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.py')
      writeFileSync(filePath, 'def foo():\n    pass\n', 'utf8')
      const first = extract([filePath])
      const second = extract([filePath])

      expect(first.nodes).toEqual(second.nodes)
      expect(first.edges).toEqual(second.edges)

      writeFileSync(filePath, 'def foo():\n    pass\n\ndef bar():\n    pass\n', 'utf8')
      const third = extract([filePath])
      const labels = third.nodes.map((node) => node.label)

      expect(labels.some((label) => label.includes('bar'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns consistent cached document extraction results and invalidates on file changes', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'notes.md')
      writeFileSync(filePath, '# Overview\n', 'utf8')
      const first = extract([filePath])
      const second = extract([filePath])

      expect(first.nodes).toEqual(second.nodes)
      expect(first.edges).toEqual(second.edges)

      writeFileSync(filePath, '# Overview\n## Details\n', 'utf8')
      const third = extract([filePath])

      expect(third.nodes.some((node) => node.label === 'Details')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to a file-only node for oversized text documents', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'large.md')
      writeFileSync(filePath, `# Oversized\n${'a'.repeat(MAX_TEXT_BYTES + 1)}`, 'utf8')

      const result = extract([filePath])

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]).toMatchObject({ label: 'large.md', file_type: 'document' })
      expect(result.edges).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers gracefully from corrupted cache entries', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.py')
      writeFileSync(filePath, 'def foo():\n    pass\n', 'utf8')
      extract([filePath])

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(cachePath, '{not valid json', 'utf8')

      const recovered = extract([filePath])

      expect(recovered.nodes.some((node) => node.label === 'foo()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores stale extractor cache versions', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.py')
      writeFileSync(filePath, 'def foo():\n    pass\n', 'utf8')
      extract([filePath])

      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
      writeFileSync(cachePath, JSON.stringify({ __graphifyTsExtractorVersion: 0, nodes: [], edges: [] }), 'utf8')

      const recovered = extract([filePath])

      expect(recovered.nodes.some((node) => node.label === 'foo()')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not cache unsupported language placeholders', () => {
    const root = createTempRoot()
    try {
      const filePath = join(root, 'sample.elm')
      writeFileSync(filePath, 'module Main exposing (main)\n', 'utf8')

      const result = extract([filePath])
      const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)

      expect(result.nodes).toHaveLength(0)
      expect(result.edges).toHaveLength(0)
      expect(existsSync(cachePath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
