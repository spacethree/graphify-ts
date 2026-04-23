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
- **Give AI agents structured codebase context** via MCP tools (`retrieve`, `impact`, `call_chain`, `pr_impact`)
- **Explore the graph** through interactive HTML, reports, and CLI commands
- **Analyze blast radius** before making changes — know what breaks across modules and repos
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

## MCP Tools for AI Agents

When an agent connects via `graphify-ts serve --stdio`, it gets these tools:

| Tool | What it does |
|------|-------------|
| `retrieve` | One-call context retrieval — question + token budget → matched nodes with code snippets, relationships, community context |
| `impact` | Blast radius analysis — "if I change X, what could break?" with direct/transitive dependents |
| `call_chain` | Execution path tracing — all paths from A to B filtered by edge type |
| `pr_impact` | PR risk analysis — git diff → affected nodes → aggregate blast radius |
| `community_details` | Hierarchical community data at micro/mid/macro zoom levels |
| `community_overview` | Quick overview of all communities — names, sizes, top nodes |
| `query_graph` | Graph traversal for a natural language question |
| `get_node` | Node details |
| `explain_node` | Node + neighborhood summary |
| `shortest_path` | Shortest path between two concepts |
| `graph_diff` | Compare two graph snapshots |
| `god_nodes` | Most connected non-file nodes |
| `semantic_anomalies` | Structural anomalies and coupling signals |
| `get_community` | Community members |

The agent uses these tools to answer questions like:
- "How does authentication work?" → `retrieve` returns relevant nodes with code snippets
- "What breaks if I refactor SessionManager?" → `impact` shows 23 dependents across 4 communities
- "How does a request flow from the API to the database?" → `call_chain` traces the execution path
- "Is this PR safe to merge?" → `pr_impact` computes blast radius of all changes

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
3. Configures the MCP server to auto-start in `.claude/settings.json`

Other platforms: `cursor install`, `copilot install`, `gemini install`, `aider install`

## Current scope

| Area | Status | Notes |
|---|---|---|
| Graph generation + HTML explorer | Strong | Core workflow with Louvain community detection |
| JavaScript / TypeScript extraction | Strong | TypeScript compiler API |
| MCP tools for AI agents | Strong | 14 tools including retrieve, impact, call_chain |
| Multi-repo federation | Available | Merges graphs with cross-repo edge inference |
| Other languages | Available | Python, Go, Java, Ruby, Rust (tree-sitter), and more |
| Documents and media | Available | PDF, DOCX, XLSX, images, audio/video metadata |
| URL ingest | Available | GitHub, Reddit, HN, YouTube structured capture |
| Exports | Available | HTML, JSON, wiki, Obsidian, SVG, GraphML, Neo4j |

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

Measured on a production NestJS + Next.js SaaS (1,268 files, ~860K words):

| Metric | Value |
|--------|-------|
| Retrieve compression | **384x** (3K tokens vs 1.1M corpus) |
| Impact analysis (User entity) | 67 direct + 589 transitive dependents across 318 files |
| Community detection | 10,474 nodes → 2,244 communities (Louvain) |
| Generation time | ~30 seconds |
| API keys required | **0** |

See [`examples/why-graphify.md`](examples/why-graphify.md) for detailed benchmarks and [`examples/mcp-tool-examples.md`](examples/mcp-tool-examples.md) for real MCP tool input/output.

Run the quick benchmark on your own project:

```bash
cd your-project
npx @mohammednagy/graphify-ts generate .
npx @mohammednagy/graphify-ts benchmark graphify-out/graph.json
```

## Credit

`graphify-ts` gives full credit to the original [`graphify`](https://github.com/safishamsi/graphify) project by [Safi Shamsi](https://github.com/safishamsi). This is a Node/TypeScript implementation of that vision, adapted for local graph workflows and AI agent integration.

## Contributing

Contributions welcome — parser fixes, regression coverage, docs, install-flow polish, and graph-quality improvements.

- [CONTRIBUTING.md](https://github.com/mohanagy/graphify-ts/blob/main/CONTRIBUTING.md)
- [SECURITY.md](https://github.com/mohanagy/graphify-ts/blob/main/SECURITY.md)
