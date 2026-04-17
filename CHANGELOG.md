# Changelog

All notable changes to the TypeScript package will be documented in this file.

## [Unreleased]

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
