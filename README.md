# graphify-ts

[![version 0.2.1](https://img.shields.io/badge/version-0.2.1-2563eb)](https://github.com/mohanagy/graphify-ts)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![TypeScript 5.8](https://img.shields.io/badge/typescript-5.8-3178c6)](https://www.typescriptlang.org/)
[![Vitest 3.2](https://img.shields.io/badge/tests-Vitest%203.2-6e9f18)](https://vitest.dev/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#what-this-package-is-best-at-today)
[![HTTP + stdio runtime](https://img.shields.io/badge/runtime-HTTP%20%2B%20stdio-7c3aed)](#common-commands)
[![HTML + JSON artifacts](https://img.shields.io/badge/artifacts-HTML%20%2B%20JSON-f59e0b)](#what-you-get)
[![No Python runtime](https://img.shields.io/badge/runtime-no%20Python%20required-111827)](#install)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/graphify-ts/blob/main/LICENSE)

`graphify-ts` is a local TypeScript CLI that turns a repository or mixed project folder into reusable graph artifacts. It generates `graph.json`, `GRAPH_REPORT.md`, and HTML views that you can inspect directly, query from the CLI, or serve to local tools.

The package is strongest today as a **local graph generator and explorer for codebases**, especially JavaScript / TypeScript repositories. Broader extraction and ingest support exists, but it varies by extractor family and is documented more precisely in [the current status doc](https://github.com/mohanagy/graphify-ts/blob/main/docs/plans/current-status.md).

The npm package name is `@mohammednagy/graphify-ts`, and the installed command is `graphify-ts`.

## What this package is best at today

- **Generate local graph artifacts** for a repository or mixed project folder.
- **Explore those artifacts** through HTML, reports, and CLI commands such as `query`, `explain`, `path`, and `diff`.
- **Provide persistent repo context** for local automation and AI workflows without requiring a Python runtime or a hosted service.

If you want one sentence: `graphify-ts` is best used as a **local-first codebase graph generator with practical explorer/query tooling around the generated artifacts**.

## Install

Prerequisites:

- Node.js 20+
- npm

Install globally:

```bash
npm install -g @mohammednagy/graphify-ts
graphify-ts --help
```

Or run it one-off with `npx`:

```bash
npx @mohammednagy/graphify-ts --help
```

If your shell still says `command not found: graphify-ts` immediately after the global install, open a new terminal and check where npm places global executables:

```bash
command -v graphify-ts
npm prefix -g
echo "$PATH"
```

On macOS with Homebrew-managed Node.js, the global executable is typically linked into `/opt/homebrew/bin/graphify-ts`. If `command -v graphify-ts` is empty, make sure `/opt/homebrew/bin` is on your `PATH`, then open a fresh terminal and try again.

## Quick start

Generate graph artifacts for the current folder:

```bash
graphify-ts generate .
```

Then inspect the outputs:

- open `graphify-out/graph.html` in a browser
- read `graphify-out/GRAPH_REPORT.md`
- keep `graphify-out/graph.json` for CLI queries and serve flows

Run a few common follow-up commands:

```bash
graphify-ts query "how does the auth flow work?" --graph graphify-out/graph.json
graphify-ts explain "SomeNodeLabel" --graph graphify-out/graph.json
graphify-ts path "SourceConcept" "TargetConcept" --graph graphify-out/graph.json
graphify-ts diff previous-run/graph.json --graph graphify-out/graph.json
graphify-ts serve graphify-out/graph.json
```

Replace `SomeNodeLabel`, `SourceConcept`, and `TargetConcept` with labels that actually exist in your generated graph.

## What you get

After a successful `generate` run, `graphify-ts` writes artifacts into `graphify-out/`:

```text
graphify-out/
├── graph.html       interactive graph explorer (or overview page for large graphs)
├── GRAPH_REPORT.md  summary report with god nodes, semantic anomalies, and suggested questions
├── graph.json       machine-readable graph for query/serve flows, community labels, and semantic anomalies
├── graph-pages/     focused community explorer pages for large graphs
└── cache/           content-addressed extraction cache
```

Optional exports are also available for wiki, Obsidian, SVG, GraphML, and Neo4j workflows.

For smaller graphs, `graph.html` stays self-contained and opens the full interactive explorer directly. For larger graphs, `graphify-ts` switches to an overview-first HTML mode that opens quickly, shows semantic community names, and links into focused per-community pages under `graph-pages/`.

## Common commands

| Command | What it does |
|---|---|
| `generate [path]` | Build graph artifacts for a folder |
| `watch [path]` | Build once, then watch supported files and refresh incrementally |
| `serve [graph.json]` | Serve graph artifacts over HTTP or stdio |
| `query "<question>"` | Traverse `graph.json` for a question |
| `diff <baseline-graph.json>` | Compare two graph snapshots |
| `path <source> <target>` | Find the shortest path between two concepts |
| `explain <label>` | Explain one node and its neighborhood |
| `add <url> [path]` | Ingest a URL into a corpus and rebuild with `--update` |
| `save-result` | Save a Q&A result into `graphify-out/memory/` |
| `benchmark [graph.json]` | Measure token reduction vs a naive full-corpus approach |
| `install` / `claude install` / `cursor install` / `copilot install` | Write local assistant/platform integration rules |

For the full command surface, run:

```bash
graphify-ts --help
```

For graph queries, you can also:

- use `--rank-by degree` to prioritize more connected matches over plain-text relevance
- use `--community <id>` to stay inside one detected community
- use `--file-type <type>` to limit traversal to one node type such as `code` or `document`

When you run `graphify-ts serve graphify-out/graph.json --mcp`, graph-aware prompt consumers also get prompt/resource/tool surfaces backed by the generated graph, including community summaries, diff support, anomaly surfacing, and freshness metadata for served artifacts.

## Smoke test with bundled fixtures

If you want a deterministic smoke test using the bundled fixture corpus in this repo, run:

```bash
graphify-ts generate tests/fixtures --no-html
graphify-ts explain HttpClient --graph tests/fixtures/graphify-out/graph.json
graphify-ts query "HttpClient buildHeaders" --graph tests/fixtures/graphify-out/graph.json
```

If you do not want a global install, replace `graphify-ts` with `npx @mohammednagy/graphify-ts` in the same commands.

Expected result:

- `generate` completes and writes `tests/fixtures/graphify-out/graph.json`
- `explain` returns the `HttpClient` node plus its method neighbors
- `query` returns a small traversal rooted around `HttpClient` and `buildHeaders()`

If you want the interactive UI for the same smoke test, rerun without `--no-html` and open `tests/fixtures/graphify-out/graph.html`.

## AI platforms and local integrations

`graphify-ts` can also feed local tooling such as Claude Code, Cursor, Copilot, and other prompt consumers by pointing them at generated artifacts in `graphify-out/`.

There are two different install surfaces:

- `graphify-ts install --platform claude` installs the home-level Claude skill for your user account
- `graphify-ts claude install` installs project-local Claude integration for the current repository

Recommended Claude Code flow:

```bash
# once per machine
npm install -g @mohammednagy/graphify-ts
graphify-ts install --platform claude

# once per repository
graphify-ts claude install

# rerun whenever you want fresh graph context
graphify-ts generate .
```

Then inside Claude Code:

```text
/graphify-ts .
```

You do **not** need to generate first for the install commands to succeed, but you do need generated artifacts before the integration has useful repo context to read.

## Current scope at a glance

This README stays end-user focused. The matrix below is the short version of what is solid now versus broader support that exists but is more bounded or extractor-specific.

| Area | Current shape | Notes |
|---|---|---|
| Local graph generation and exploration | **Strong today** | Core `generate` / HTML / report / query / explain / path / diff workflow |
| JavaScript / TypeScript extraction | **Strong today** | Uses the TypeScript compiler API |
| Other code-language extraction | **Available, mixed depth** | Deeper AST-backed coverage for Python, Go, Java, Ruby, and a first Rust slice; lighter structural extraction elsewhere |
| Documents, papers, and office files | **Available** | Markdown/text/PDF/DOCX/XLSX extraction with bounded metadata and citation lifting |
| Images and local media metadata | **Available, bounded** | Deterministic image nodes plus bounded audio/video metadata extraction; no transcription yet |
| URL ingest | **Available, route-specific** | Structured capture exists for several source families, with explicit fallback behavior when exact supported routes do not match |
| Exports and integrations | **Available** | HTML/JSON by default, optional wiki/Obsidian/SVG/GraphML/Neo4j outputs, plus local assistant installers |
| HTTP / stdio serving | **Available** | Lightweight local runtime around generated graph artifacts |

For the detailed implementation status, limitations, and roadmap material, see:

- [Current status](https://github.com/mohanagy/graphify-ts/blob/main/docs/plans/current-status.md)
- [Upstream parity and beyond roadmap](https://github.com/mohanagy/graphify-ts/blob/main/docs/plans/2026-04-12-upstream-parity-and-beyond.md)

## Optional outputs and integrations

You can extend a `generate` run with flags such as:

- `--wiki`
- `--obsidian`
- `--svg`
- `--graphml`
- `--neo4j`
- `--neo4j-push <uri>`

You can also use platform-specific installer commands to add local assistant rules or skills, for example:

```bash
graphify-ts install --platform claude
graphify-ts claude install
graphify-ts cursor install
graphify-ts copilot install
```

## Credit to the original graphify

`graphify-ts` gives full credit to the original [`graphify`](https://github.com/safishamsi/graphify) project by [Safi Shamsi](https://github.com/safishamsi). That project established the core idea and workflow of turning code, docs, and mixed project folders into a queryable knowledge graph for humans and AI coding assistants.

This repository is a Node/TypeScript implementation of that vision, adapted for a Node-native CLI and local graph workflows. If you want the original Python-based project and its broader multimodal feature set, start with `graphify`.

## Contributing

Contributions are welcome - especially parser fixes, fixture-backed regression coverage, docs improvements, install-flow polish, and graph-quality improvements.

Before opening a pull request, please read:

- [CONTRIBUTING.md](https://github.com/mohanagy/graphify-ts/blob/main/CONTRIBUTING.md)
- [SECURITY.md](https://github.com/mohanagy/graphify-ts/blob/main/SECURITY.md)

The repository now includes:

- GitHub issue forms for bugs and feature requests
- a pull request template
- `CODEOWNERS`
- a CI workflow for pull requests

If you maintain the repository, apply the recommended GitHub branch protection and open-source safety settings from:

- [docs/maintainers/repository-settings.md](https://github.com/mohanagy/graphify-ts/blob/main/docs/maintainers/repository-settings.md)
