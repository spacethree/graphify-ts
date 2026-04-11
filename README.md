# graphify-ts

A standalone TypeScript implementation of graphify-style knowledge graph tooling, designed to run without a Python runtime.

## Current status

Implemented and verified in this workspace:

- project scaffold with strict TypeScript + Vitest
- extraction schema contracts and validation
- cache utilities with atomic writes
- corpus/file detection with `.graphifyignore`, hidden-file skipping, symlink controls, and incremental manifest helpers
- graph assembly from extraction JSON
- shared extractor helpers now split under `src/pipeline/extract/` to keep the main pipeline entry point smaller and more modular
- extraction MVP for:
  - Python, Go, and Java via portable `web-tree-sitter` + `@vscode/tree-sitter-wasm` parsing for owner-aware type/method extraction, imports, async Python function support, rationale attachment, and common call-graph edges
  - Ruby via a deterministic block-aware source scanner
  - Lua and `.toc` addon manifests via lightweight source/metadata scanners
  - Elixir and Julia via lightweight end-delimited source scanners
  - PowerShell and Objective-C via lightweight platform-aware source scanners
  - JavaScript / TypeScript via the TypeScript compiler API
  - remaining brace-style languages (currently including Kotlin, Scala, C#, Rust, Swift, PHP, Zig, and C/C++-style signatures) via a portable regex-based structural extractor with common inheritance/conformance support, including multiline Scala/Kotlin/Swift signature coverage from the fixture-backed parity cases
  - Markdown / text / RST documents via deterministic section parsing, local-reference detection, DOI/arXiv/LaTeX-citation extraction, and bibliography-reference nodes
  - DOCX documents via synchronous zip/XML heading extraction plus local citation detection
  - text-like paper corpora plus heuristic PDF title/section extraction and citation detection
  - image assets as first-class graph nodes
- cache-backed multi-file extraction for the implemented corpus types
- bridge-aware community clustering and cohesion scoring
- graph analysis helpers for god nodes, surprising connections, suggested questions, file/category heuristics, and graph diffs
- graph query/runtime helpers for traversal, node/community lookup, stats, and shortest-path summaries
- export surfaces for JSON, Cypher, GraphML, a richer interactive HTML explorer with confidence-aware inferred-edge styling, and Obsidian vault output
- markdown graph report generation with suggested-question sections
- wiki/article export for communities and god nodes
- benchmark helpers for token-reduction reporting
- a built TypeScript CLI for top-level graph generation plus `watch`, `serve`, `query`, `path`, `explain`, `add`, `install`, `save-result`, `benchmark`, and `hook`, including optional `generate --update`, `--directed`, `--wiki`, `--obsidian`, `--svg`, `--graphml`, `--neo4j`, direct `--neo4j-push` graph export/push support, and broader `serve` transport selection via `--transport`, `--http`, `--stdio`, and `--mcp`
- direct Neo4j push support via the official `neo4j-driver`, with credentials resolved from `--neo4j-user` / `--neo4j-password` / `--neo4j-database` flags or `NEO4J_*` values in the local environment / `.env` (copy `.env.example` to `.env` as a starting point)
- the `serve` command can now run as either a lightweight HTTP runtime or a stdio runtime via `--transport http|stdio`, `--http`, `--stdio`, or `--mcp`, including an MCP-compatible `initialize`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`, `tools/list`, and `tools/call` surface with snake_case tool arguments and `god_nodes` graph summaries
- local platform/project configuration commands for `claude`, `gemini`, `cursor`, `codex`, `opencode`, `aider`, `copilot`, `claw`, `droid`, `trae`, and `trae-cn`
- self-contained installer skill templates managed in the TypeScript package, without any Python runtime or nested reference checkout dependency
- git hook install / uninstall / status helpers
- portable watch helpers for extension filtering and code-focused automatic rebuilds, with non-code corpus changes surfaced as manual `generate --update` notifications through the CLI; mixed code/non-code batches currently prefer the safer notify-only path
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

## Future work beyond the completed roadmap slice

The strict roadmap items tracked in this workspace are implemented and verified. Remaining follow-ups are broader stretch goals rather than blockers for the current TypeScript port:

- widen portable tree-sitter coverage beyond the current Python/Go/Java AST-backed slice
- deepen bibliography/metadata resolution beyond the current deterministic citation coverage
- broaden MCP/stdIO protocol breadth beyond today’s lightweight prompt/resource/tool runtime

## Known limitations

- Python extraction now runs through the same portable WASM tree-sitter path as Go and Java. The current AST-backed slice covers the fixture-backed structural, async-function, rationale, and common cross-file `from ... import ...` parity cases already under test, while deeper language-specific edge cases still remain lighter than a dedicated full-reference parser stack.
- Ruby extraction now covers common `module` / `class` / `def` / `end` structure, `require` imports, inheritance, and straightforward call edges, but it is still a lightweight source scanner rather than a full parser for metaprogramming-heavy Ruby.
- Lua, `.toc`, Elixir, Julia, PowerShell, and Objective-C extraction now cover common module/class/function or metadata structure plus straightforward imports, references, and call edges, but they remain lightweight scanners aimed at common source patterns rather than full language parsers.
- JavaScript / TypeScript extraction now covers classes, interfaces, heritage clauses (`extends` / `implements`), methods, nested function declarations/closures, top-level and class-field arrow/function-expression bindings, static imports, dynamic `import()` usage, and direct call relationships. More advanced decorator-heavy metadata and some uncommon AST edge cases are still lighter than a fuller parser-backed implementation.
- Go and Java extraction now run through the same portable WASM tree-sitter path used for Python. The current AST-backed slice focuses on common type, interface, record, method, import, and call-graph patterns already covered by tests; deeper language-specific edge cases still need more parity work.
- The remaining portable multi-language extractor is intentionally heuristic. It now emits useful structure for several brace-style languages, including owner-aware method extraction for common `impl` / `extension` blocks, common inheritance/conformance clauses, Kotlin / Scala expression-bodied definitions, Swift `func ... -> ...` signatures, Zig `@import`/`struct`/`fn` patterns, and qualified `Type::method` definitions, but it is still regex-based rather than AST-backed, so deeply nested signatures, macros, or language-specific edge cases can still be missed.
- Document and text-like paper extraction is still deterministic rather than generative, but it now models headings, containment, markdown links, local filename mentions, DOI/arXiv identifiers, LaTeX-style `\cite{...}` keys, and numbered bibliography references. It detects those citations locally; it does not yet resolve external paper metadata.
- DOCX documents now get a lightweight synchronous zip/XML pass for title, heading structure, local filename mention references, and inline citation detection, while richer office formats such as spreadsheets still land more shallowly in the graph.
- PDF papers now get a lightweight heuristic pass for metadata title, common section labels, local filename mention references, and inline citation detection, but binary office-style documents are still not parsed as deeply as the richer text/document formats.
- The HTML visualization export now supports a selected-node details panel, clickable neighbor navigation, searchable node matches, community focus controls, URL-hash deep links, and confidence-aware inferred-edge styling. It is still lighter than the richer Python reference UI overall, but it no longer lacks the basic inspection/navigation surface.
- Directed graph mode is now supported via `generate --directed`: exported JSON persists `directed: true`, runtime query/path traversal follows outgoing edges, and GraphML emits `edgedefault="directed"`. Community detection still intentionally treats the graph as undirected connectivity, matching the Python reference's clustering behavior.
- Direct Neo4j push is now implemented for the CLI via `--neo4j-push`, but it assumes a reachable Neo4j instance, a supported `bolt://` / `neo4j://` style URI, and credentials supplied through flags or `NEO4J_*` values in the shell / local `.env` file.
- A direct Node native `tree-sitter` install failed in this environment under Node 25, so the TS port currently uses portable WASM tree-sitter for Python/Go/Java and keeps non-AST fallbacks elsewhere instead of relying on native parser addons.
- The installer now uses bundled TypeScript-managed skill templates by default. Package-local markdown assets can still override those templates when present, which keeps customization possible without introducing a Python dependency.
- The watch layer now rebuilds supported code changes automatically, wakes promptly on filesystem events, reuses incremental generation when graph artifacts already exist, and notifies for document/paper/image changes so a manual `generate --update` can refresh the broader corpus safely. Mixed code/non-code change batches currently also take that notify-only path instead of partially rebuilding code while broader corpus inputs are dirty.
- `generate --update` now reuses the existing graph as incremental context, re-extracts only changed/new supported files, drops deleted-source graph records, and ignores `graphify-out/` artifacts instead of feeding generated output back into the corpus.
- The new `serve` command is a lightweight HTTP runtime over generated artifacts and query helpers. It is useful today, but it is not yet a full MCP/stdIO replacement.
- The new `serve --transport http|stdio` surface (plus `--http`, `--stdio`, and `--mcp`) now supports an MCP-compatible handshake plus `prompts/list` / `prompts/get`, `resources/list` / `resources/read`, `tools/list` / `tools/call`, snake_case tool arguments, and `god_nodes`, alongside direct JSON-line query methods. It is still a lightweight runtime rather than a full reference MCP implementation.
- Implemented MCP capabilities today: `initialize`, prompt discovery/retrieval, artifact resource discovery/reading, and graph query tools including `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `explain_node`, `graph_stats`, `god_nodes`, and `get_community`. Not implemented yet: richer reference-server features such as subscriptions, completions, sampling, logging control, and broader protocol breadth.

## Repository layout

- `src/` — standalone TypeScript implementation
- `tests/fixtures/` — local fixture corpus owned by this repository
- `tests/unit/` — TypeScript tests, including an end-to-end pipeline suite

## Next likely steps

- widen portable tree-sitter coverage beyond the current Python/Go/Java slice
- deepen bibliography/metadata resolution beyond the current deterministic citation coverage
- add MCP/stdIO runtime parity on top of the new Node serve surface
- keep extending integration-style coverage as broader runtime surfaces land
