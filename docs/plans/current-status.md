# graphify-ts current status and roadmap

This document keeps the implementation status, scope notes, limitations, and next-step planning details that were moved out of the top-level `README.md` so the README can stay end-user focused.

## Current status

Implemented in this repository:

- project scaffold with strict TypeScript + Vitest
- extraction schema contracts and validation
- cache utilities with atomic writes
- corpus/file detection with `.graphifyignore`, hidden-file skipping, symlink controls, incremental manifest helpers, and explicit `graphify-out/memory/` note inclusion without re-ingesting generated graph artifacts
- graph assembly from extraction JSON
- shared extractor helpers now split under `src/pipeline/extract/` to keep the main pipeline entry point smaller and more modular
- extraction MVP for:
  - Python, Go, and Java via portable `web-tree-sitter` + `@vscode/tree-sitter-wasm` parsing for owner-aware type/method extraction, imports, async Python function support, rationale attachment, and common call-graph edges
  - Ruby via a deterministic block-aware source scanner
  - Lua and `.toc` addon manifests via lightweight source/metadata scanners
  - Elixir and Julia via lightweight end-delimited source scanners
  - PowerShell and Objective-C via lightweight platform-aware source scanners
  - JavaScript / TypeScript via the TypeScript compiler API, including static imports, re-exports, `import = require(...)`, CommonJS `require(...)`, dynamic `import()`, and direct call-graph coverage
  - remaining brace-style languages (currently including Kotlin, Scala, C#, Rust, Swift, PHP, Zig, and C/C++-style signatures) via a portable regex-based structural extractor with common inheritance/conformance support, including multiline Scala/Kotlin/Swift signature coverage from the fixture-backed parity cases
  - Markdown / text / RST documents via deterministic section parsing, frontmatter metadata lifting (`title`, `source_url`, `captured_at`, `author`, `contributor`, `source_nodes`, etc.), source-node reference edges, local-reference detection, DOI/arXiv/LaTeX-citation extraction, numbered-citation resolution, and bibliography-reference nodes enriched with local reference metadata
  - DOCX documents via synchronous zip/XML heading extraction plus local citation detection
  - text-like paper corpora plus heuristic PDF title/section extraction and citation detection
  - image assets as first-class graph nodes
- cache-backed multi-file extraction for the implemented corpus types
- bridge-aware community clustering and cohesion scoring
- graph analysis helpers for god nodes, surprising connections, suggested questions, file/category heuristics, and graph diffs
- graph query/runtime helpers for traversal, node/community lookup, stats, and shortest-path summaries
- export surfaces for JSON (including additive `community_labels` metadata), Cypher, GraphML, a richer interactive HTML explorer with confidence-aware inferred-edge styling plus selected-node metadata/source URL surfacing, automatic overview-first large-graph fallback pages, deterministic semantic community names across human-facing outputs, and Obsidian vault output
- markdown graph report generation with suggested-question sections
- wiki/article export for communities and god nodes
- benchmark helpers for token-reduction reporting
- a built TypeScript CLI for top-level graph generation plus `watch`, `serve`, `query`, `path`, `explain`, `add`, `install`, `save-result`, `benchmark`, and `hook`, including optional `generate --update`, `--directed`, `--wiki`, `--obsidian`, `--svg`, `--graphml`, `--neo4j`, direct `--neo4j-push` graph export/push support, and broader `serve` transport selection via `--transport`, `--http`, `--stdio`, and `--mcp`
- direct Neo4j push support via the official `neo4j-driver`, with credentials resolved from `--neo4j-user` / `--neo4j-password` / `--neo4j-database` flags or `NEO4J_*` values in the local environment / `.env` (copy `.env.example` to `.env` as a starting point)
- the `serve` command can now run as either a lightweight HTTP runtime or a stdio runtime via `--transport http|stdio`, `--http`, `--stdio`, or `--mcp`, including an MCP-compatible `initialize`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, `tools/list`, `tools/call`, `completion/complete`, and `logging/setLevel` surface with snake_case tool arguments, prompt completions, log notifications, and `god_nodes` graph summaries
- local platform/project configuration commands for `claude`, `gemini`, `cursor`, `codex`, `opencode`, `aider`, `copilot`, `claw`, `droid`, `trae`, and `trae-cn`
- self-contained installer skill templates managed in the TypeScript package, without any Python runtime or nested reference checkout dependency
- git hook install / uninstall / status helpers
- npm distribution with the global `graphify-ts` executable, a prepack build, and a publish-time file allowlist
- open-source contributor / maintainer scaffolding via `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue forms, a pull request template, `CODEOWNERS`, a CI workflow, and a maintainer-facing GitHub settings checklist
- release-tag handling via a `v*`-triggered GitHub release workflow plus maintainer docs for protected tags and version/changelog alignment
- portable watch helpers for extension filtering and code-focused automatic rebuilds, with non-code corpus changes surfaced as manual `generate --update` notifications through the CLI; mixed code/non-code batches currently prefer the safer notify-only path
- a lightweight Node HTTP runtime that serves `graph.html`, `graph.json`, `GRAPH_REPORT.md`, and graph query endpoints from the CLI
- security utilities for graph path validation, URL validation, safe fetch, and label sanitization
- ingest helpers for URL classification, safe webpage/binary capture, and query-result memory files
- end-to-end pipeline coverage across detect → extract → build → cluster → analyze → report → export
- local test fixtures owned by this repository under `tests/fixtures/`, so the test suite does not depend on a separate Python checkout

## Future work beyond the completed roadmap slice

The roadmap slice tracked for this repository is implemented. Remaining follow-ups are broader stretch goals rather than blockers for the current TypeScript port:

- widen portable tree-sitter coverage beyond the current Python/Go/Java AST-backed slice
- deepen bibliography/metadata resolution beyond the current frontmatter/query-memory lift, local reference metadata parsing, and deterministic citation/link resolution
- broaden MCP/stdIO protocol breadth beyond today’s lightweight prompt/resource/tool runtime, prompt completions, and logging controls

## Known limitations

- Python extraction now runs through the same portable WASM tree-sitter path as Go and Java. The current AST-backed slice covers the fixture-backed structural, async-function, rationale, and common cross-file `from ... import ...` parity cases already under test, while deeper language-specific edge cases still remain lighter than a dedicated full-reference parser stack.
- Ruby extraction now covers common `module` / `class` / `def` / `end` structure, `require` imports, inheritance, and straightforward call edges, but it is still a lightweight source scanner rather than a full parser for metaprogramming-heavy Ruby.
- Lua, `.toc`, Elixir, Julia, PowerShell, and Objective-C extraction now cover common module/class/function or metadata structure plus straightforward imports, references, and call edges, but they remain lightweight scanners aimed at common source patterns rather than full language parsers.
- JavaScript / TypeScript extraction now covers classes, interfaces, heritage clauses (`extends` / `implements`), methods, nested function declarations/closures, top-level and class-field arrow/function-expression bindings, static imports, re-exports, `import = require(...)`, CommonJS `require(...)`, dynamic `import()` usage, and direct call relationships. More advanced decorator-heavy metadata and some uncommon AST edge cases are still lighter than a fuller parser-backed implementation.
- Go and Java extraction now run through the same portable WASM tree-sitter path used for Python. The current AST-backed slice focuses on common type, interface, record, method, import, and call-graph patterns already covered by tests; deeper language-specific edge cases still need more parity work.
- The remaining portable multi-language extractor is intentionally heuristic. It now emits useful structure for several brace-style languages, including owner-aware method extraction for common `impl` / `extension` blocks, common inheritance/conformance clauses, Kotlin / Scala expression-bodied definitions, Swift `func ... -> ...` signatures, Zig `@import`/`struct`/`fn` patterns, and qualified `Type::method` definitions, but it is still regex-based rather than AST-backed, so deeply nested signatures, macros, or language-specific edge cases can still be missed.
- Document and text-like paper extraction is still deterministic rather than generative, but it now models headings, containment, markdown links, lifted frontmatter/query-memory metadata, source-node references, local filename mentions, DOI/arXiv identifiers, LaTeX-style `\cite{...}` keys, numbered bibliography references, and inline numeric-citation links back to local bibliography nodes. It also lifts basic local reference metadata such as year/title/DOI/arXiv when those are present, but it does not yet resolve external paper metadata.
- DOCX documents now get a lightweight synchronous zip/XML pass for title, heading structure, local filename mention references, and inline citation detection, while richer office formats such as spreadsheets still land more shallowly in the graph.
- PDF papers now get a lightweight heuristic pass for metadata title, common section labels, local filename mention references, and inline citation detection, but binary office-style documents are still not parsed as deeply as the richer text/document formats.
- The HTML visualization export now supports a selected-node details panel, clickable neighbor navigation, searchable node matches, community focus controls, URL-hash deep links, confidence-aware inferred-edge styling, lifted metadata/source URL display (validated before links are made clickable), and deterministic semantic community names instead of plain `Community N` placeholders. Large corpora now auto-switch to an overview-first HTML mode that links into focused per-community pages so the browser does not have to render the entire graph at once. It is still lighter than the richer Python reference UI overall, but it no longer lacks the basic inspection/navigation surface.
- Directed graph mode is now supported via `generate --directed`: exported JSON persists `directed: true`, runtime query/path traversal follows outgoing edges, and GraphML emits `edgedefault="directed"`. Community detection still intentionally treats the graph as undirected connectivity, matching the Python reference's clustering behavior.
- Direct Neo4j push is now implemented for the CLI via `--neo4j-push`, but it assumes a reachable Neo4j instance, a supported `bolt://` / `neo4j://` style URI, and credentials supplied through flags or `NEO4J_*` values in the shell / local `.env` file.
- A direct Node native `tree-sitter` install failed in this environment under Node 25, so the TS port currently uses portable WASM tree-sitter for Python/Go/Java and keeps non-AST fallbacks elsewhere instead of relying on native parser addons.
- The installer now uses bundled TypeScript-managed skill templates by default. Package-local markdown assets can still override those templates when present, which keeps customization possible without introducing a Python dependency.
- The watch layer now rebuilds supported code changes automatically, wakes promptly on filesystem events, reuses incremental generation when graph artifacts already exist, and notifies for document/paper/image changes so a manual `generate --update` can refresh the broader corpus safely. Mixed code/non-code change batches currently also take that notify-only path instead of partially rebuilding code while broader corpus inputs are dirty.
- `generate --update` now reuses the existing graph as incremental context, re-extracts only changed/new supported files, drops deleted-source graph records, and ignores generated `graphify-out/` artifacts while still allowing saved memory notes under `graphify-out/memory/` to flow back into the corpus.
- The new `serve` command is a lightweight HTTP runtime over generated artifacts and query helpers. It is useful today, but it is not yet a full MCP/stdIO replacement.
- The new `serve --transport http|stdio` surface (plus `--http`, `--stdio`, and `--mcp`) now supports an MCP-compatible handshake plus `prompts/list` / `prompts/get`, `resources/list` / `resources/read`, `tools/list` / `tools/call`, `completion/complete`, `logging/setLevel`, snake_case tool arguments, and `god_nodes`, alongside direct JSON-line query methods and JSON-RPC log notifications. It is still a lightweight runtime rather than a full reference MCP implementation.
- Implemented MCP capabilities today: `initialize`, prompt discovery/retrieval, prompt-argument completions, artifact resource discovery/reading, logging level control, JSON-RPC log notifications, and graph query tools including `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `explain_node`, `graph_stats`, `god_nodes`, and `get_community`. Not implemented yet: richer reference-server features such as subscriptions, sampling, and broader protocol breadth.

## Repository layout

- `src/` — standalone TypeScript implementation
- `tests/fixtures/` — local fixture corpus owned by this repository
- `tests/unit/` — TypeScript tests, including an end-to-end pipeline suite
- `.github/` — issue forms, pull request template, code ownership, and CI workflow
- `.github/workflows/release.yml` — tag-driven GitHub release validation and release creation
- `docs/maintainers/` — maintainer-only repository settings and protection guidance

## Next likely steps

- widen portable tree-sitter coverage beyond the current Python/Go/Java slice
- deepen bibliography/metadata resolution beyond the current frontmatter/query-memory lift, local reference metadata parsing, and deterministic citation/link resolution
- add MCP/stdIO runtime parity on top of the new Node serve surface, especially subscriptions and broader protocol breadth
- keep extending integration-style coverage as broader runtime surfaces land
