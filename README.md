# graphify-ts

[![npm](https://img.shields.io/npm/v/@mohammednagy/graphify-ts)](https://www.npmjs.com/package/@mohammednagy/graphify-ts)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![TypeScript 5.8](https://img.shields.io/badge/typescript-5.8-3178c6)](https://www.typescriptlang.org/)
[![Vitest 3.2](https://img.shields.io/badge/tests-Vitest%203.2-6e9f18)](https://vitest.dev/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#what-this-package-is-best-at-today)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#what-this-package-is-best-at-today)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/graphify-ts/blob/main/LICENSE)

`graphify-ts` is a local TypeScript CLI that turns codebases and mixed project folders into queryable knowledge graphs. It generates graph artifacts that AI agents (Claude, Copilot, Cursor, Gemini) use to answer codebase questions with structural awareness — impact analysis, call chains, cross-repo connections — without sending your code anywhere.

**Zero cloud. Zero API keys. The agent you already have does the intelligence work.**

## What this package is best at today

- **Generate local graph artifacts** for a repository or mixed project folder
- **Give AI agents structured codebase context** via MCP tools (`retrieve`, `relevant_files`, `feature_map`, `risk_map`, `implementation_checklist`, `impact`, `call_chain`, `pr_impact`)
- **Understand mainstream JS/TS app structure** with framework-aware extraction for Express, Redux Toolkit, React Router, NestJS, and Next.js
- **Explore the graph** through interactive HTML, reports, and CLI commands
- **Analyze blast radius** before making changes — know what breaks across modules and repos
- **Benchmark review-mode prompts on real diffs** with `review-compare` before trusting a compact PR-review surface
- **Federate multiple repos** into a single queryable super-graph

## Install

```bash
npm install -g @mohammednagy/graphify-ts
```

## Quick start

```bash
# Generate the graph
graphify-ts generate .

# Set up your AI agent integration
graphify-ts claude install    # or cursor, copilot, gemini

# Now your agent can use retrieve, impact, call_chain, and other MCP tools
```

Need the exact support matrix? See [docs/language-capability-matrix.md](docs/language-capability-matrix.md). Need the reproducible proof ladder? See [docs/proof-workflows.md](docs/proof-workflows.md) and [examples/why-graphify.md](examples/why-graphify.md).

## Framework-aware JS/TS support today

For TypeScript and JavaScript repositories, `graphify-ts` now adds a framework-semantic pass on top of the base AST extraction:

- **Express**: apps, routers, mounted routers, route nodes, middleware ownership, and handler relationships
- **Redux Toolkit**: slices, actions, selectors, thunks, and store registration
- **React Router**: object routes, JSX routes, loaders, actions, nested routes, and route/component binding
- **NestJS**: modules, controllers, route decorators, providers, constructor injection, guards, pipes, and interceptors
- **Next.js**: App Router and Pages Router ownership, layouts/templates/loading/error states, route handlers, middleware reachability, client/server boundaries, and server actions
- **Compact MCP mode by default**: `retrieve` and `impact` now return compact framework-aware MCP payloads by default; use `verbose: true` when you explicitly need the legacy fuller shape

That means agents can answer questions like “which middleware protects this route?”, “which slice owns auth state?”, “which Nest controller calls this service?”, or “which Next route/layout owns this page?” with higher-signal nodes instead of only low-level helpers.

The deep coverage target is **mainstream framework conventions**, not every possible abstraction layer. Runtime-generated routes, heavily meta-programmed decorators, and custom wrapper stacks still fall back to the base AST graph rather than pretending to be first-class framework semantics.

What you get in `graphify-out/`:

```text
graphify-out/
├── graph.html       interactive explorer (overview + community pages)
├── GRAPH_REPORT.md  structure signals, god nodes, anomalies, suggested questions
├── graph.json       machine-readable graph for MCP tools and queries
├── graph-pages/     per-community explorer pages
├── docs/            auto-generated module documentation (with --docs)
└── cache/           content-addressed extraction cache
```

## 3-command proof (demo workspace)

This repo includes a tiny checked-in workspace at `examples/demo-repo/` plus a labeled question set. From the repo root, run `npm install && npm run build` once, then:

```bash
node dist/src/cli/bin.js generate examples/demo-repo --no-html
node dist/src/cli/bin.js benchmark examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
node dist/src/cli/bin.js eval examples/demo-repo/graphify-out/graph.json --questions examples/demo-repo/benchmark-questions.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

Outputs land in `examples/demo-repo/graphify-out/`, which is ignored so you can rerun the demo without polluting git status.

- `benchmark` proves the graph is cheaper to query than reading the corpus naively, while still covering the labeled demo questions and their expected evidence. On the checked-in demo repo you should see `Question coverage: 5/5 matched`, `Expected evidence: 17/17 labels found`, and about `1.7x` fewer tokens per query.
- `eval` proves retrieval quality on the same labeled questions: recall, ranking quality (MRR), and snippet coverage. On the checked-in demo repo you should see `Recall: 100.0%`, `MRR: 1.000`, `Snippet coverage: 100.0%`, and about `2.7x` fewer tokens at query time.
- `benchmark` and `eval` now execute those prompts through your terminal runner, just like `compare`. When the runner returns structured Gemini/Claude usage, the reports include provider-reported tokens; otherwise they label the local `cl100k_base` fallback estimate explicitly.
- The demo repo is intentionally tiny, so these ratios are lower than the production benchmark below. The point is that the proof is fully reproducible from this repo.

## Real A/B compare (same question, same model)

`benchmark` and `eval` use the same runner-backed prompt surface as `compare`, but they score a labeled question set instead of saving paired baseline-vs-graphify answers. `compare` is still the paid, real-world showcase path: it builds a naive baseline prompt plus a graphify-guided prompt for the same question, runs both through your own terminal LLM command, and saves both answers.

```bash
node dist/src/cli/bin.js compare "How does login create a session?" \
  --graph examples/demo-repo/graphify-out/graph.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

Gemini-safe installed-CLI invocation:

```bash
graphify-ts compare "How does auth work?" \
  --exec 'cat {prompt_file} | gemini -p "" --output-format json' \
  --yes
```

What `compare` does:

- Prints a warning before execution because it may consume paid model tokens. Use `--yes` for non-interactive runs and CI.
- Expands runner placeholders: `{prompt_file}`, `{question}`, `{mode}`, and `{output_file}`.
- For large prompts, pass `{prompt_file}` through stdin or file redirection. Avoid shell command substitution around `{prompt_file}` (for example `$(cat {prompt_file})`), which can hit OS argument-length limits.
- Writes a proof bundle under `graphify-out/compare/<timestamp>/` with `baseline-prompt.txt`, `graphify-prompt.txt`, `baseline-answer.txt`, `graphify-answer.txt`, and `report.json`.
- Promotes provider-reported usage into `report.json` and the terminal summary when the runner emits structured JSON with usage (for Gemini, `usageMetadata` from `--output-format json`; for Claude, structured JSON with `usage`).
- Falls back to labeled local `cl100k_base` prompt estimates when the runner only returns answer text or malformed JSON, so the token source stays explicit.
- Preserves partial artifacts when one side fails, and classifies prompt-size failures such as `Prompt is too long` as `context_overflow` evidence in `report.json`.

Use `compare` when you want a showcase or a customer-proof answer bundle. Use `benchmark` and `eval` when you want repeatable runner-backed question-set metrics; they report provider usage when available and clearly label local token-estimate fallback when it is not.

## Real PR review compare (same diff, same model)

`review-compare` is the proof path for review mode. Instead of comparing two answers to a question, it compares the **verbose** and **compact** `pr_impact` prompts for the current git diff, saves both prompts, and can optionally run both through your own terminal model command.

```bash
graphify-ts review-compare graphify-out/graph.json \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

What `review-compare` does:

- Builds both verbose and compact `pr_impact` payloads for the current diff.
- Expands runner placeholders: `{prompt_file}`, `{mode}`, and `{output_file}`.
- Writes artifacts under `graphify-out/review-compare/<timestamp>/` with `verbose-prompt.txt`, `compact-prompt.txt`, `verbose-answer.txt`, `compact-answer.txt`, and `report.json`.
- Reports prompt-token and payload-token deltas between verbose and compact review mode.
- Supports external graph paths and output directories inside the target graph workspace's own `graphify-out/`, which matters for real multi-project repositories.

Use `review-compare` when the question is "did compact review mode actually shrink the real PR-review prompt enough?" rather than "did graphify beat a naive baseline on one question?"

## Graph time travel (ref-to-ref graph compare)

Use `graphify-ts time-travel <from> <to>` to compare two git refs through local graph snapshots:

```bash
graphify-ts time-travel main HEAD
graphify-ts time-travel v0.8.2 HEAD --view risk
graphify-ts time-travel main HEAD --view timeline --json
```

How it works today:

- On first use, graphify-ts materializes each ref on demand, builds a local snapshot, and stores it under `graphify-out/time-travel/snapshots/<commit-sha>/`
- Later runs reuse compatible cached snapshots automatically; pass `--refresh` to rebuild both refs
- There is no background history daemon or persistent snapshot service — snapshots are built only when you request a compare

Views:

- `summary` (default): headline, why-it-matters bullets, node/edge deltas, and changed communities
- `risk`: changed labels ranked by transitive dependents
- `drift`: nodes that moved between communities
- `timeline`: added/removed nodes and edges plus community-move events

The CLI defaults to the `summary` view. Pass `--json` when you want the raw result object instead of terminal formatting.

## MCP Tools for AI Agents

When an agent connects via `graphify-ts serve --stdio`, it gets these tools:

| Tool | What it does |
|------|-------------|
| `retrieve` | One-call context retrieval — question + token budget → compact matched nodes with code snippets, relationships, community context, and relevance bands by default; supports `verbose: true` for the legacy fuller payload |
| `relevant_files` | Feature-starting file triage — question → ranked files with matched symbols and a short explanation of why each file matters |
| `feature_map` | Feature-level orientation — question → primary communities, likely entry points, and starter files to open first |
| `risk_map` | Pre-change risk briefing — question → likely blast radius, structural hotspots, and starter files before you edit |
| `implementation_checklist` | Change-planning checklist — question → ordered edit steps plus validation checkpoints for entry points and shared risks |
| `impact` | Blast radius analysis — "if I change X, what could break?" with compact directed dependents, affected communities, and path evidence by default; supports `verbose: true` for the legacy fuller payload |
| `call_chain` | Execution path tracing — all paths from A to B filtered by edge type |
| `pr_impact` | PR risk analysis — git diff → line-aware seed nodes → compact review bundle, typed `review_context`, ranked risks, and aggregate blast radius by default; supports verbose output when explicitly requested |
| `community_details` | Hierarchical community data at micro/mid/macro zoom levels |
| `community_overview` | Quick overview of all communities — names, sizes, top nodes |
| `query_graph` | Graph traversal for a natural language question |
| `time_travel_compare` | Compare two refs using on-demand cached graph snapshots and return `summary`, `risk`, `drift`, or `timeline` JSON |
| `get_node` | Node details |
| `explain_node` | Node + neighborhood summary |
| `shortest_path` | Shortest path between two concepts |
| `graph_diff` | Compare two graph snapshots |
| `god_nodes` | Most connected non-file nodes |
| `semantic_anomalies` | Structural anomalies and coupling signals |
| `get_community` | Community members |

The agent uses these tools to answer questions like:
- "How does authentication work?" → `retrieve` returns relevant nodes with code snippets
- "Where should I start editing the user profile route?" → `relevant_files` ranks the first files to open and explains why
- "What parts of the codebase are involved in the user profile route?" → `feature_map` summarizes the primary communities, entry points, and starter files
- "What looks risky before I edit the user profile route?" → `risk_map` highlights likely blast-radius chokepoints and structural hotspots
- "What order should I edit this feature, and what should I validate after?" → `implementation_checklist` returns an edit sequence plus validation checkpoints
- "What breaks if I refactor SessionManager?" → `impact` shows directed dependents, affected communities, and the highest-signal propagation paths
- "How does a request flow from the API to the database?" → `call_chain` traces the execution path
- "Is this PR safe to merge?" → `pr_impact` returns compact changed seeds, a review bundle, supporting paths, likely tests, hotspots, and ranked risks for the current diff
- "What changed between main and HEAD?" → `time_travel_compare` builds or reuses local snapshots and returns a summary, risk, drift, or timeline view

## Multi-Repo Federation

For teams with multiple repos (microservices, frontend/backend splits):

```bash
graphify-ts federate \
  frontend/graphify-out/graph.json \
  backend/graphify-out/graph.json \
  shared/graphify-out/graph.json \
  --output federated-out
```

This merges graphs and infers cross-repo connections from shared types and function names. All MCP tools work on the federated graph.

## Common commands

| Command | What it does |
|---|---|
| `generate [path]` | Build graph artifacts for a folder |
| `generate [path] --docs` | Also generate per-community module documentation |
| `generate [path] --include-docs` | Include .md/.txt/.rst files (excluded by default) |
| `federate <g1> <g2> ...` | Merge graphs from multiple repos |
| `watch [path]` | Build once, then watch for changes |
| `serve [graph.json]` | Serve graph via HTTP or stdio (MCP) |
| `query "<question>"` | Traverse the graph for a question |
| `diff <baseline.json>` | Compare two graph snapshots |
| `path <source> <target>` | Find shortest path between concepts |
| `explain <label>` | Explain one node and its neighborhood |
| `add <url> [path]` | Ingest a URL and rebuild |
| `benchmark [graph.json]` | Measure token reduction and structure signals |
| `eval [graph.json]` | Measure retrieval quality: recall, MRR, and snippet coverage |
| `compare [question]` | Run a real baseline-vs-graphify prompt comparison through your own terminal LLM command |
| `review-compare [graph.json]` | Compare verbose-vs-compact `pr_impact` prompts for the current git diff |
| `time-travel <from> <to>` | Compare two refs via on-demand local graph snapshots (`summary` default; `risk`, `drift`, `timeline` optional) |
| `install --platform claude` | Install home-level Claude skill |
| `claude install` | Install project-local Claude integration with MCP auto-start |

For the full command surface: `graphify-ts --help`

## AI Platform Integration

```bash
# Once per machine
npm install -g @mohammednagy/graphify-ts
graphify-ts install --platform claude    # home-level skill

# Once per repository
graphify-ts claude install               # project-local rules + MCP server auto-start

# Regenerate whenever the code changes
graphify-ts generate .
```

`claude install` does three things:
1. Writes rules to `CLAUDE.md` telling the agent to use `retrieve` for codebase questions
2. Registers a PreToolUse hook that reminds the agent about the graph
3. Configures the MCP server to auto-start in `.mcp.json`

The generated `.mcp.json` is project-local setup for your machine. Keep it out of version control, rerun `graphify-ts claude install` after upgrading `graphify-ts` so the pinned MCP package version stays current, and regenerate it locally instead of committing a user-specific graph path.

Other platforms: `cursor install`, `copilot install`, `gemini install`, `aider install`

## Capability coverage

The public support matrix is in [docs/language-capability-matrix.md](docs/language-capability-matrix.md). The short version:

| Area | Current implementation |
|---|---|
| TypeScript / JavaScript | TypeScript compiler API plus framework-aware semantics for Express, Redux Toolkit, React Router, NestJS, and Next.js mainstream conventions |
| Python / Ruby / Go / Java / Rust | Tree-sitter WASM primary path with local fallback |
| C-family / Kotlin / C# / Scala / PHP / Swift / Zig | Generic structural extractor |
| Lua / Elixir / Julia / PowerShell / Objective-C / TOC | Lightweight language-specific scanners |
| Markdown / text / PDF / DOCX / XLSX | Structured document extractors |
| Images / audio / video | Metadata-only asset nodes |
| URL ingest | GitHub, Reddit, Hacker News, X/Twitter, arXiv, YouTube, PDF, image, audio, video, webpage |
| Everything else | No registered capability yet |

That distinction matters: some paths are AST-backed, some are tree-sitter-backed with fallback, some are heuristic, and some asset types are metadata only. The matrix document is the precise source of truth.

## Optional generate flags

```bash
graphify-ts generate . --wiki          # crawlable wiki
graphify-ts generate . --obsidian      # Obsidian vault
graphify-ts generate . --svg           # SVG export
graphify-ts generate . --graphml       # GraphML for graph tools
graphify-ts generate . --neo4j         # Cypher file for Neo4j
graphify-ts generate . --neo4j-push bolt://localhost:7687  # direct push
graphify-ts generate . --docs          # per-community documentation
graphify-ts generate . --include-docs  # include markdown/text files
```

## Benchmarks — Real Numbers from a Production Codebase

Measured 2026-04-30 against a production NestJS + Next.js SaaS (1,268 files, ~860K words). Both runs used `claude --output-format json`; numbers come from Anthropic-reported `usage` fields, not local estimates. Full evidence is committed under [`docs/benchmarks/2026-04-30-govalidate/`](docs/benchmarks/2026-04-30-govalidate/).

| Metric | Baseline (no graphify) | Graphify (core profile) |
|--------|------------------------|-------------------------|
| Tool-call turns | 9 | **3** (3× fewer) |
| Avg session latency | 96s | **35s** (~2.8× faster) |
| Total input tokens (Anthropic-reported) | 615,190 | **233,508** (2.63× less) |
| Cost per session | $0.62 | $0.70 (cold start) → cheaper on multi-question sessions |
| Impact analysis (User entity) | n/a | 67 direct + 589 transitive dependents across 318 files |
| Community detection | n/a | 10,474 nodes → 2,244 communities (Louvain) |
| API keys required | — | **0** |

Cold-start sessions pay an MCP-overhead premium of roughly 13%; multi-question sessions amortize the premium below baseline. Graphify is unambiguously **faster and uses fewer turns** at any session length; cost parity depends on session length.

See [`examples/why-graphify.md`](examples/why-graphify.md) for detailed benchmarks and [`examples/mcp-tool-examples.md`](examples/mcp-tool-examples.md) for real MCP tool input/output.

Run the quick benchmark on your own project:

```bash
cd your-project
npx @mohammednagy/graphify-ts generate .
npx @mohammednagy/graphify-ts benchmark graphify-out/graph.json --exec 'cat {prompt_file} | claude -p' --yes
```

## Credit

`graphify-ts` gives full credit to the original [`graphify`](https://github.com/safishamsi/graphify) project by [Safi Shamsi](https://github.com/safishamsi). This is a Node/TypeScript implementation of that vision, adapted for local graph workflows and AI agent integration.

## Contributing

Contributions welcome — parser fixes, regression coverage, docs, install-flow polish, and graph-quality improvements.

- [CONTRIBUTING.md](https://github.com/mohanagy/graphify-ts/blob/main/CONTRIBUTING.md)
- [SECURITY.md](https://github.com/mohanagy/graphify-ts/blob/main/SECURITY.md)

## License

`graphify-ts` is licensed under **MIT**. See [`LICENSE`](LICENSE) for the full terms.
