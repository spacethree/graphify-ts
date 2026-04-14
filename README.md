# graphify-ts

[![version 0.1.5](https://img.shields.io/badge/version-0.1.5-2563eb)](https://github.com/mohanagy/graphify-ts)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![TypeScript 5.8](https://img.shields.io/badge/typescript-5.8-3178c6)](https://www.typescriptlang.org/)
[![Vitest 3.2](https://img.shields.io/badge/tests-Vitest%203.2-6e9f18)](https://vitest.dev/)
[![MCP stdio + HTTP](https://img.shields.io/badge/runtime-MCP%20stdio%20%2B%20HTTP-7c3aed)](#how-graphify-helps-claude-code-and-other-ai-platforms)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#how-graphify-helps)
[![Code docs papers images](https://img.shields.io/badge/corpus-code%20%2B%20docs%20%2B%20papers%20%2B%20images-9a3412)](#what-you-get)
[![HTML JSON Neo4j](https://img.shields.io/badge/outputs-HTML%20%2B%20JSON%20%2B%20Neo4j-f59e0b)](#what-you-get)
[![No Python runtime](https://img.shields.io/badge/runtime-no%20Python%20required-111827)](#best-fit-today)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](./LICENSE)

`graphify` is a workflow for turning a codebase, documentation set, or mixed project folder into a local knowledge graph. Instead of treating a repository as a pile of disconnected files, graphify extracts files, symbols, concepts, and relationships so you can explore the project as a connected system.

`graphify-ts` is the Node/TypeScript implementation of that workflow. It lets you generate graph artifacts locally, inspect them in HTML, query them from the CLI, serve them to tools, and use them to give AI platforms like Claude Code a much better map of your repository — all without requiring a Python runtime.

The npm package name is `@mohammednagy/graphify-ts`, and the installed command is `graphify-ts`.

## Credit to the original graphify

`graphify-ts` gives full credit to the original [`graphify`](https://github.com/safishamsi/graphify) project by [Safi Shamsi](https://github.com/safishamsi). That project established the core idea and workflow of turning code, docs, and mixed project folders into a queryable knowledge graph for humans and AI coding assistants.

This repository is a Node/TypeScript implementation of that vision, adapted for a Node-native CLI and local graph workflows. If you want the original Python-based project and its broader multimodal feature set, start with `graphify`.

## What is graphify?

Graphify helps you move from raw files to connected understanding.

Instead of manually opening dozens of files just to answer questions like:

- Where does this feature start and end?
- What are the most important modules in this repo?
- Which files, functions, or concepts are tightly connected?
- How is this project organized at a high level?

Graphify builds a reusable graph of the project and saves it as artifacts you can browse, query, and reuse.

That makes it useful for:

- onboarding into an unfamiliar codebase
- understanding architecture and dependencies
- exploring mixed repos with code, docs, and notes
- creating persistent context for AI coding assistants
- keeping a local, regeneratable knowledge layer for a project

## How graphify helps

Graphify is especially helpful when you want to:

- **Understand a repository faster** by surfacing important nodes, communities, and relationships.
- **See structure instead of noise** through reports, graph views, and focused exports.
- **Explore large projects safely** with overview-first HTML for large graphs instead of trying to render everything at once.
- **Query the codebase semantically** with commands like `query`, `explain`, and `path` on top of generated graph artifacts.
- **Compare snapshots over time** with `diff` so refactors and graph changes are easier to review.
- **Spot suspicious structure faster** through semantic anomaly detection for bridge nodes, low-cohesion communities, and unexpected cross-boundary edges.
- **Reuse the same context across tools** because the graph is saved locally as files that humans and automation can both consume.
- **Refresh understanding after changes** by regenerating the graph whenever the repo evolves.

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

For smaller graphs, `graph.html` stays self-contained and opens the full interactive explorer directly. For larger graphs, `graphify-ts` now switches to an overview-first HTML mode that opens quickly, shows semantic community names, and links into focused per-community pages under `graph-pages/`.

## Best fit today

`graphify-ts` is a strong fit if you want to:

- explore a JavaScript / TypeScript repository with a Node-native toolchain
- build persistent graph artifacts for AI or agent workflows
- inspect repo structure through HTML, graph queries, and shortest-path/explain commands
- evaluate the TypeScript port without depending on the original Python runtime

## Install from npm

Prerequisites:

- Node.js
- npm

Install the published package globally:

```bash
npm install -g @mohammednagy/graphify-ts
graphify-ts --help
```

If your shell still says `command not found: graphify-ts` immediately after the global install, open a new terminal and check where npm places global executables:

```bash
command -v graphify-ts
npm prefix -g
echo "$PATH"
```

On macOS with Homebrew-managed Node.js, the global executable is typically linked into `/opt/homebrew/bin/graphify-ts`. If `command -v graphify-ts` is empty, make sure `/opt/homebrew/bin` is on your `PATH`, then open a fresh terminal and try again.

## Use without installing globally

If you prefer one-off execution:

```bash
npx @mohammednagy/graphify-ts --help
```

## How graphify helps Claude Code and other AI platforms

AI coding assistants are powerful, but they usually begin with incomplete repository context. Graphify helps by generating a local knowledge layer that the assistant can read instead of forcing it to infer everything from raw file browsing alone.

In practice, graphify gives AI platforms a better starting point:

- `graphify-out/GRAPH_REPORT.md` explains the repo at a higher level, including god nodes, communities, and suggested questions.
- `graphify-out/graph.json` provides machine-readable structure for query, explain, path, anomaly, and serve workflows.
- `graphify-out/wiki/index.md` (when you generate wiki output) gives assistants a linked markdown view that is often easier to navigate than raw source trees.
- `graphify-out/graph.html` and `graphify-out/graph-pages/` let you inspect the same structure visually.

That helps AI platforms like Claude Code:

- orient themselves in an unfamiliar repository faster
- answer architecture and dependency questions with better grounding
- spend less context budget on blind file hunting
- reuse fresh graph artifacts after code changes instead of starting from scratch each time

`graphify-ts` also includes installer commands for local platform integrations such as Claude, Cursor, and Copilot.

There are two different kinds of install commands:

- `graphify-ts install --platform claude` installs the home-level Claude skill for your user account
- `graphify-ts claude install` installs project-local Claude integration for the current repository

You do **not** have to run `graphify-ts generate .` before either install command for them to succeed.

You run `graphify-ts generate .` because the installed Claude rules point Claude at graph artifacts inside `graphify-out/`, especially:

- `graphify-out/graph.json`
- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/wiki/index.md` (when wiki export exists)

Without those files, the skill/rules are installed, but Claude has no generated graph context to read yet.

For Claude Code specifically, the workflow is simple:

1. install the Claude integration
2. generate graph artifacts for the repository
3. run the slash command so Claude can use the fresh graph context

Recommended order for Claude Code:

```bash
# once per machine
npm install -g @mohammednagy/graphify-ts
graphify-ts install --platform claude

# once per repository
graphify-ts claude install

# run whenever you want Claude to use fresh graph context
graphify-ts generate .
```

Then inside Claude Code, use the installed slash command:

```text
/graphify-ts .
```

That is the current `graphify-ts` command name for the Claude skill.

When you run that command, Claude Code invokes the local `graphify-ts` workflow for the current repository and reads the generated artifacts under `graphify-out/`. That is what makes the integration useful: Claude gets a repo-specific map instead of relying only on ad-hoc file reads.

Because the slash command runs a local command and updates files under `graphify-out/`, Claude Code may ask for permission the first time or when its sandbox settings require confirmation. That prompt is expected.

If you want Claude to benefit immediately in an existing repo, run `graphify-ts generate .` before you start asking codebase questions. If you are just setting up the integration, installing first and generating afterward is perfectly fine.

## Quick start on your own project

Generate graph artifacts for the current folder:

```bash
graphify-ts generate .
```

Then inspect the outputs:

- open `graphify-out/graph.html` in a browser
- read `graphify-out/GRAPH_REPORT.md`
- keep `graphify-out/graph.json` for CLI queries and server flows

If the graph is large, `graph.html` becomes a lightweight overview page with named communities and search results that link into `graphify-out/graph-pages/community-*.html` instead of trying to render the whole graph at once.

### Useful next commands

```bash
graphify-ts query "how does the auth flow work?" --graph graphify-out/graph.json
graphify-ts query "auth" --rank-by degree --community 0 --file-type code --graph graphify-out/graph.json
graphify-ts diff previous-run/graph.json --graph graphify-out/graph.json
graphify-ts explain "SomeNodeLabel" --graph graphify-out/graph.json
graphify-ts path "SourceConcept" "TargetConcept" --graph graphify-out/graph.json
graphify-ts serve graphify-out/graph.json
graphify-ts serve graphify-out/graph.json --mcp
```

Replace `SomeNodeLabel`, `SourceConcept`, and `TargetConcept` with labels that actually exist in your generated graph.

For graph queries, you can now:

- use `--rank-by degree` to prioritize more connected matches over plain text relevance
- use `--community <id>` to stay inside one detected community
- use `--file-type <type>` to limit traversal to one node type such as `code` or `document`

When you run `graphify-ts serve graphify-out/graph.json --mcp`, graph-aware prompt consumers now also get:

- prompt descriptions seeded from the actual generated graph instead of fixed boilerplate
- query/explain/path prompts that include live graph stats, top communities, god nodes, and suggested follow-up questions
- a `graph_community_summary_prompt` for summarizing one detected community by id, with prompt completion for available `community_id` values
- a `graph_diff` tool plus direct `diff` method support for comparing the current graph to a baseline `graph.json`
- a `semantic_anomalies` MCP tool plus an HTTP `/anomalies` endpoint for surfacing bridge nodes, weak communities, and suspicious cross-boundary links
- freshness metadata on MCP `resources/list` / `resources/read` responses via resource annotations, plus matching graph-version headers on the HTTP runtime so clients can detect stale graph artifacts
- `resources/subscribe` / `resources/unsubscribe` support with `notifications/resources/updated` and `notifications/resources/list_changed` so MCP clients can react to refreshed graph artifacts

## Try it out

If you want a deterministic smoke test using the bundled fixture corpus in this repo, run:

```bash
graphify-ts generate tests/fixtures --no-html
graphify-ts explain HttpClient --graph tests/fixtures/graphify-out/graph.json
graphify-ts query "HttpClient buildHeaders" --graph tests/fixtures/graphify-out/graph.json
```

If you do not want a global install, replace `graphify-ts` with `npx @mohammednagy/graphify-ts` in the same commands.

What you should see:

- `generate` completes and writes `tests/fixtures/graphify-out/graph.json`
- `explain` returns the `HttpClient` node plus its method neighbors
- `query` returns a small traversal rooted around `HttpClient` and `buildHeaders()`

If you want the interactive UI for the same smoke test, rerun without `--no-html` and open `tests/fixtures/graphify-out/graph.html`.

## Common commands

| Command | What it does |
|---|---|
| `generate [path]` | Build graph artifacts for a folder |
| `watch [path]` | Build once, then watch supported code, docs, papers, images, and office-document changes |
| `serve [graph.json]` | Serve graph artifacts over HTTP or stdio |
| `query "<question>"` | Traverse `graph.json` for a question, with optional ranking and query filters |
| `diff <baseline-graph.json>` | Compare two graph snapshots and summarize new/removed nodes and edges |
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

## Current scope at a glance

Today, the strongest path is:

- JavaScript / TypeScript extraction via the TypeScript compiler API

Additional coverage exists for:

- Python, Go, Java, and Ruby via portable WASM tree-sitter
- several additional languages via lighter structural extraction
- deterministic document, paper, image, and office-document handling, including DOCX/XLSX metadata lifting plus richer PDF citation metadata
- additive schema-v2 validation for `schema_version`, layered graph metadata (`base`, `semantic`, `media`), provenance records, immutable legacy-payload normalization during graph build, explicit `graph.json` / reload / `generate --update` schema-version preservation, helper-created raw extraction output that now emits explicit base-layer/provenance metadata, normalization-time projection of flat ingest frontmatter into structured ingest provenance, and registry-driven extraction/ingest dispatch via a builtin capability registry that can disambiguate shared extensions such as markdown document vs paper inputs, emit structured GitHub repo/issue/PR/discussion captures plus exact `/commit/<sha>` commit captures, turn article-style webpages into richer canonicalized markdown with author/description lift, section headings, and outbound-link lists, emit structured single-post tweet/X captures across exact base-post plus `/photo/<n>` and `/video/<n>` media-alias routes with derived handle/post metadata plus explicit capture-status context, emit structured Reddit thread captures across exact thread-root and short-thread aliases plus exact comment-permalink captures with post/comment context and explicit JSON-fallback behavior, emit structured Hacker News item captures across exact `news.ycombinator.com/item?id=` routes with discussion highlights and explicit API-fallback behavior, and emit structured YouTube captures across exact single-video `watch`, `youtu.be`, `shorts`, and `embed` routes, exact `live` routes, exact `/playlist?list=<id>` routes, and exact root channel routes across `@handle` plus `/channel/<id>` with canonical watch/playlist/channel URLs, derived IDs or handles, and explicit oEmbed/HTML fallback context
- lightweight HTTP and stdio/MCP-style serving

For the detailed implementation status, limitations, and roadmap material that used to live in this README, see:

- [`docs/plans/current-status.md`](docs/plans/current-status.md)
- [`docs/plans/2026-04-12-upstream-parity-and-beyond.md`](docs/plans/2026-04-12-upstream-parity-and-beyond.md)

## Contributing

Contributions are welcome — especially parser fixes, fixture-backed regression coverage, docs improvements, install-flow polish, and graph-quality improvements.

Before opening a pull request, please read:

- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`SECURITY.md`](SECURITY.md)

The repository now includes:

- GitHub issue forms for bugs and feature requests
- a pull request template
- `CODEOWNERS`
- a CI workflow for pull requests

If you maintain the repository, apply the recommended GitHub branch protection and open-source safety settings from:

- [`docs/maintainers/repository-settings.md`](docs/maintainers/repository-settings.md)
