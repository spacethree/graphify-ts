# Changelog

All notable changes to the TypeScript package will be documented in this file.

## [Unreleased]

## [0.5.0] - 2026-04-23

### Added

- **RAG retrieval tool**: new `retrieve` MCP tool that takes a natural language question and token budget, finds relevant nodes via token-based prefix matching, expands through graph neighbors, reads code snippets from disk, and returns a structured context bundle with matched nodes, relationships, community context, and structural signals (god nodes, bridge nodes)
- **`--include-docs` flag**: document files (`.md`, `.txt`, `.rst`) are now excluded from graph generation by default to reduce noise; pass `--include-docs` to opt in

### Fixed

- **Summary-mode edge rendering**: fixed field name mismatch (`e.source`/`e.target`/`e.relation` to `e.from`/`e.to`/`e.label`) in the "Load interactive graph" button handler for oversized community pages, which caused edges to not render at all in summary mode

## [0.4.2] - 2026-04-20

### Fixed

- Moved `typescript` from `devDependencies` to `dependencies` so the TypeScript compiler API (used for JS/TS AST extraction) is available when the package is installed by end users who do not have TypeScript installed globally

## [0.4.1] - 2026-04-20

### Fixed

- Fixed `SyntaxError: Invalid or unexpected token` in community summary pages: the warning message string in the `loadInteractiveGraph` client function contained literal newlines (from the TypeScript template literal) which are invalid inside single-quoted JavaScript strings; escaped as `\n` sequences so the generated HTML is valid

## [0.4.0] - 2026-04-20

### Added

- **Detection hygiene**: corpus traversal now skips common non-semantic directories (`test`, `tests`, `__tests__`, `spec`, `specs`, `e2e`, `cypress`, `playwright`, `coverage`, `storybook-static`, `fixtures`, `__fixtures__`, `__mocks__`, `mocks`) and noise file patterns (test/spec files, stories, mocks, framework config files, setup files) so those do not pollute the knowledge graph
- **Interactive graph toggle for oversized communities**: summary-only community pages now include an opt-in "⚡ Load interactive graph" button that shows a performance warning dialog and lazy-loads vis-network from CDN on confirmation, with an error recovery handler for offline environments
- **React component classification**: uppercase JSX-returning functions in `.tsx`/`.jsx` files are now tagged `node_kind: 'component'` so they are identifiable as React components in the graph
- **JSX `renders` edges**: component functions now emit outgoing `renders` edges for every uppercase JSX tag they use (e.g. `<Button />` → edge to `Button`), enabling component-level usage graphs in React projects
- **Cross-file `renders` stitching**: `renders` proxy edges are resolved across file boundaries onto real imported component nodes so the final graph shows concrete component-to-component relationships rather than unresolved proxies

### Changed

- `EXTRACTOR_CACHE_VERSION` bumped to 61 to invalidate stale pre-React-classification extraction payloads

### Fixed

- Graph data embedded in community summary HTML pages is now serialized with `serializeForInlineScript` (escaping `<`, `>`, `&`, line-separator characters) to prevent premature `</script>` tag termination on adversarially-named file paths

## [0.3.0] - 2026-04-18

### Added

- Workspace-scale parity baseline harness: reproducible mixed-workspace benchmark corpus, parity scorecard, and benchmark question coverage using shared `scoreNodes`, `queryGraph`, and `estimateQueryTokens` runtime paths
- Cross-file relationship extraction covering import/export chains, type references, call graphs, and shared-module cohesion signals across multi-package workspaces
- Fragmentation signals in `GRAPH_REPORT.md`: weakly-connected-component count, singleton-component count, isolated-node rate, largest-component share, and low-cohesion community count for workspace-scale diagnostics
- Modular HTML export helpers for community summaries (`export/community-summary.ts`), overview bridge detection (`export/overview-bridges.ts`), and overview navigation links (`export/overview-navigation.ts`)
- Stdio server MCP tool/resource definitions extracted into a dedicated `src/runtime/stdio/definitions.ts` module to reduce hotspot growth

### Changed

- `GRAPH_REPORT.md` now emits entity-level structure signals using shared analysis helpers instead of file-node heuristics, improving workspace-scale diagnostic accuracy
- Benchmark prints entity-level structure signals when `source_file` provenance is available, with an explicit unavailable note otherwise
- Enhanced `analyze.ts` cohesion and bridge-detection logic to cover cross-workspace import patterns and multi-service shared modules
- Refactored `stdio-server.ts` to delegate definitions to the new dedicated module, reducing its size and isolating protocol-level changes
- `generate --update` now preserves workspace-parity provenance contracts across incremental rebuilds

## [0.2.2] - 2026-04-17

### Fixed

- Prevented overview-first HTML exports from opening browser-freezing interactive pages for oversized single communities by falling back to summary/search views with safe deep links

## [0.2.1] - 2026-04-17

### Added

- Schema-v2 extraction metadata with layered provenance contracts, immutable normalization helpers, and regression coverage for legacy payload upgrades and `generate --update` preservation
- Registry-driven ingestion for structured webpages plus exact GitHub repository/issue/pull-request/discussion/commit, Reddit thread/comment, Hacker News item, and YouTube video/playlist/channel routes
- Broader deterministic non-code and media extraction, including DOCX/XLSX metadata and citation handling, richer PDF bibliography/source URL lifting, sidecar-backed binary provenance, and bounded metadata for AAC, M4A, FLAC, Ogg Vorbis/Opus, MP4-family, AVI, and Matroska/WebM assets
- A first bounded Rust tree-sitter extraction slice covering trait signatures, `impl Trait for Type` conformance, aliased `use ... as ...` imports, nested import scoping, and WASM grammar-load isolation
- Deterministic bibliography `source_url` lifting for numbered Markdown/PDF/DOCX reference entries when plain external URLs are present without DOI/arXiv metadata

### Changed

- Refactored extraction and ingest plumbing into more modular registry-driven paths, including dedicated `extract/` helper modules and a larger `non-code` extraction module for the active document/media path
- Expanded README and maintainer-facing release documentation to better reflect the package's strongest current workflows, bounded capability matrix, and npm-safe repository links
- Improved large-corpus detection messaging to recommend smaller high-value slices without advertising nonexistent flags or provider-specific token costs

### Fixed

- Hardened bounded Matroska/WebM metadata discovery and stale-metadata clearing across direct scans, `SeekHead` rereads, and later top-level fallback paths
- Preserved correct ingest provenance and sidecar-aware incremental rebuild behavior for binary assets, including direct audio/video URLs and saved sidecar metadata

### Notes

- `v0.2.0` was tagged accidentally and was not published to npm or turned into a GitHub release. `0.2.1` is the first published package for the post-`0.1.5` change set and includes the release-documentation corrections made after that accidental tag.

## [0.1.5] - 2026-04-12

### Added

- MCP resource subscriptions for the stdio runtime via `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated`, and `notifications/resources/list_changed`
- Deeper deterministic non-code extraction for PDF metadata and `Tj`/`TJ` text recovery, DOCX core metadata, and XLSX workbook/sheet structure
- Citation and bibliography enrichment that derives deterministic external `source_url` values for DOI and arXiv references
- A dedicated `src/pipeline/extract/non-code.ts` module to own the active non-code extraction path
- Regression coverage for stdio subscriptions, mixed-corpus watch rebuilds, and richer PDF/DOCX/XLSX extraction behavior

### Changed

- Watch mode now rebuilds supported code, document, paper, image, and office-document changes automatically, including mixed supported batches
- README, roadmap notes, and bundled installer guidance now reflect the expanded MCP/runtime and office-document capabilities
- Refactored `extract.ts` to route active non-code extraction through the new dedicated module and bumped the extractor cache version

### Fixed

- Hardened non-code parsing with bounded markdown-link matching and structured-text line caps
- Added a defensive stdio resource-subscription cap to avoid unbounded session growth

## [0.1.4] - 2026-04-12

### Fixed

- Prevented semantic community naming from crashing when labels include Object prototype property names such as `constructor` or `toString`
- Added regression coverage for prototype-chain label handling in `buildCommunityLabels`

## [0.1.3] - 2026-04-12

### Added

- Automatic overview-first HTML export for large graphs, with lightweight `graph.html` landing pages and focused per-community pages under `graph-pages/`
- Deterministic semantic community naming based on dominant paths, file themes, and representative graph nodes
- `community_labels` metadata in `graph.json` for downstream tooling and report consumers

### Changed

- Improved generated reports and HTML output to show meaningful community names instead of generic `Community N` placeholders when heuristics can infer a better label
- Expanded regression coverage for semantic labels, overview-mode export behavior, and generator propagation of HTML mode choices

## [0.1.2] - 2026-04-11

### Changed

- Renamed the installed Claude skill and slash command to `graphify-ts` consistently across built-in templates, installer output, and README usage examples
- Simplified assistant installer behavior to use only the current `graphify-ts` naming for skill paths, section markers, hooks, and generated helper files
- Renamed generated OpenCode and Cursor integration helper files to `graphify-ts`-specific filenames for clearer project ownership

## [0.1.1] - 2026-04-11

### Added

- Open-source contribution scaffolding via `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue forms, a pull request template, `CODEOWNERS`, and a CI workflow
- Maintainer documentation for repository protections, branch/tag handling, and release process management
- A tag-driven GitHub release workflow for `v*` tags that validates tag format, package-version alignment, changelog coverage, and local-equivalent verification steps before creating a GitHub release

### Changed

- Clarified npm installation, package-scope, and end-user setup guidance in the README
- Added Claude integration documentation explaining the difference between global skill installation, project-local integration, and graph generation
- Expanded README contribution guidance and linked maintainer-facing repository settings documentation

### Notes

- This patch release focuses on packaging, documentation, contribution workflow, and release-management improvements rather than runtime graph-extraction changes

## [0.1.0] - 2026-04-11

### Added

- Initial npm-ready TypeScript release of `graphify-ts`
- Global CLI command support via `graphify-ts`
- `generate`, `watch`, `serve`, `query`, `path`, `explain`, `add`, `save-result`, `benchmark`, `install`, and `hook` commands
- JavaScript / TypeScript extraction via the TypeScript compiler API
- Portable tree-sitter extraction for Python, Go, and Java
- Lightweight structural extraction for additional languages including Ruby, Lua, Elixir, Julia, PowerShell, Objective-C, and several brace-style languages
- Deterministic extraction for Markdown, RST, DOCX, PDF-like paper corpora, and image assets
- Interactive HTML graph explorer, JSON export, GraphML/Cypher export, Obsidian/wiki output, and Neo4j push support
- Lightweight HTTP and stdio/MCP-style serving
- Publish-ready packaging with scoped npm metadata, a prepack build, and a constrained tarball allowlist
