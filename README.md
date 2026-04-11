# graphify-ts

A standalone TypeScript implementation of graphify-style knowledge graph tooling, designed to run without a Python runtime.

## Current status

Implemented and verified in this workspace:

- project scaffold with strict TypeScript + Vitest
- extraction schema contracts and validation
- cache utilities with atomic writes
- corpus/file detection with `.graphifyignore`, hidden-file skipping, symlink controls, and incremental manifest helpers
- graph assembly from extraction JSON
- extraction MVP for:
  - Python via deterministic source scanning
  - Ruby via a deterministic block-aware source scanner
  - Lua and `.toc` addon manifests via lightweight source/metadata scanners
  - Elixir and Julia via lightweight end-delimited source scanners
  - PowerShell and Objective-C via lightweight platform-aware source scanners
  - JavaScript / TypeScript via the TypeScript compiler API
  - common brace-style languages (currently including Go, Java, Kotlin, C#, Rust, Swift, PHP, Zig, and C/C++-style signatures) via a portable regex-based structural extractor
  - Markdown / text / RST documents via deterministic section + local-reference parsing
  - DOCX documents via synchronous zip/XML heading extraction
  - text-like paper corpora plus heuristic PDF title/section extraction
  - image assets as first-class graph nodes
- cache-backed multi-file extraction for the implemented corpus types
- bridge-aware community clustering and cohesion scoring
- graph analysis helpers for god nodes, surprising connections, suggested questions, file/category heuristics, and graph diffs
- graph query/runtime helpers for traversal, node/community lookup, stats, and shortest-path summaries
- export surfaces for JSON, Cypher, GraphML, a richer interactive HTML explorer, and Obsidian vault output
- markdown graph report generation with suggested-question sections
- wiki/article export for communities and god nodes
- benchmark helpers for token-reduction reporting
- a built TypeScript CLI for top-level graph generation plus `watch`, `serve`, `query`, `path`, `explain`, `add`, `install`, `save-result`, `benchmark`, and `hook`
- the `serve` command can now run as either a lightweight HTTP runtime or a stdio runtime via `--stdio` / `--mcp`, including a minimal MCP-compatible `initialize`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, `tools/list`, and `tools/call` surface
- local platform/project configuration commands for `claude`, `codex`, `opencode`, `claw`, `droid`, `trae`, and `trae-cn`
- self-contained installer skill templates managed in the TypeScript package, without any Python runtime or nested reference checkout dependency
- git hook install / uninstall / status helpers
- portable watch helpers for extension filtering and automatic rebuilds across supported code, document, paper, and image corpora, now exposed through the CLI
- a lightweight Node HTTP runtime that serves `graph.html`, `graph.json`, `GRAPH_REPORT.md`, and graph query endpoints from the CLI
- security utilities for graph path validation, URL validation, safe fetch, and label sanitization
- ingest helpers for URL classification, safe webpage/binary capture, and query-result memory files
- end-to-end pipeline coverage across detect → extract → build → cluster → analyze → report → export
- local test fixtures owned by this repository under `tests/fixtures/`, so the test suite does not depend on a separate Python checkout

Verified locally:

- `npm run test:run`
- `npm run typecheck`
- `npm run build`
- `node dist/src/cli/bin.js --help`

## What is not implemented yet

Still pending for broader feature parity:

- tree-sitter-based multi-language extraction beyond the current MVP
- richer MCP/stdIO runtime parity beyond the current lightweight stdio + HTTP serve commands (the TS port now exposes a minimal MCP prompt/resource/tool surface, but not the full reference runtime breadth)

## Known limitations

- Python-source extraction currently uses a deterministic source scanner instead of tree-sitter. It handles the fixture-backed structural and call-graph cases already covered by tests, including common cross-file `from ... import ...` resolution into inferred class-level `uses` / `inherits` edges when both files are in the extracted corpus, but it is not yet a full parity replacement for a richer parser strategy.
- Ruby extraction now covers common `module` / `class` / `def` / `end` structure, `require` imports, inheritance, and straightforward call edges, but it is still a lightweight source scanner rather than a full parser for metaprogramming-heavy Ruby.
- Lua, `.toc`, Elixir, Julia, PowerShell, and Objective-C extraction now cover common module/class/function or metadata structure plus straightforward imports, references, and call edges, but they remain lightweight scanners aimed at common source patterns rather than full language parsers.
- JavaScript / TypeScript extraction currently covers classes, methods, top-level function declarations, top-level arrow/function-expression bindings, imports, and direct call relationships. More advanced patterns such as nested closures and class-field arrow methods are not fully covered yet.
- The new portable multi-language extractor is intentionally heuristic. It now emits useful structure for several brace-style languages, including owner-aware method extraction for common `impl` / `extension` blocks, Zig `@import`/`struct`/`fn` patterns, and qualified `Type::method` definitions, but it is still regex-based rather than AST-backed, so deeply nested signatures, macros, or language-specific edge cases can still be missed.
- Document and text-like paper extraction is currently deterministic and structural: headings, containment, and local cross-file references are modeled, but it is not yet a full LLM-style semantic pass.
- DOCX documents now get a lightweight synchronous zip/XML pass for title and heading structure, while richer office formats such as spreadsheets still land more shallowly in the graph.
- PDF papers now get a lightweight heuristic pass for metadata title and common section labels, but binary office-style documents are still not parsed as deeply as the richer text/document formats.
- The HTML visualization export now supports a selected-node details panel, clickable neighbor navigation, searchable node matches, community focus controls, and URL-hash deep links. It is still lighter than the richer Python reference UI overall, but it no longer lacks the basic inspection/navigation surface.
- A direct Node native `tree-sitter` install failed in this environment under Node 25, so the MVP intentionally avoids native parser dependencies for now.
- The installer now uses bundled TypeScript-managed skill templates by default. Package-local markdown assets can still override those templates when present, which keeps customization possible without introducing a Python dependency.
- The watch layer now rebuilds supported code, document, paper, and image corpora automatically, but unsupported future formats can still fall back to `graphify-out/needs_update` if a manual refresh path is needed.
- The new `serve` command is a lightweight HTTP runtime over generated artifacts and query helpers. It is useful today, but it is not yet a full MCP/stdIO replacement.
- The new `serve --stdio` / `--mcp` mode now supports a minimal MCP-compatible handshake plus `prompts/list` / `prompts/get`, `resources/list` / `resources/read`, and `tools/list` / `tools/call`, alongside direct JSON-line query methods. It is still a lightweight runtime rather than a full reference MCP implementation.
- Implemented MCP capabilities today: `initialize`, prompt discovery/retrieval, artifact resource discovery/reading, and graph query tools. Not implemented yet: richer reference-server features such as subscriptions, completions, sampling, logging control, and broader protocol breadth.

## Repository layout

- `src/` — standalone TypeScript implementation
- `tests/fixtures/` — local fixture corpus owned by this repository
- `tests/unit/` — TypeScript tests, including an end-to-end pipeline suite

## Next likely steps

- widen extraction coverage or switch to a portable parser strategy with stronger Python parity
- deepen paper/binary document extraction beyond the current structural/file-level coverage
- add MCP/stdIO runtime parity on top of the new Node serve surface
- keep extending integration-style coverage as broader runtime surfaces land
