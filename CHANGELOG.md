# Changelog

All notable changes to the TypeScript package will be documented in this file.

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
