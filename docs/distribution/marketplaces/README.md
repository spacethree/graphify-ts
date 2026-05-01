# Marketplace listing pack

This directory is the source of truth for marketplace and directory submission copy for graphify-ts.

## One-line positioning

**graphify-ts is a local-first MCP server and CLI for sharper codebase Q&A and PR review: it builds a knowledge graph so Claude, Cursor, Copilot, Gemini, and Aider can work in fewer turns without shipping your repo to a hosted index.**

## Target audiences

- Engineering teams that want faster codebase answers from Claude Code, Cursor, or Copilot on large repos.
- Security-conscious or regulated teams that cannot send source code to a hosted indexing service.
- Senior engineers and reviewers who want diff-aware PR review context before merge.

## Key proof points

- **Measured retrieval benchmark:** 3× fewer tool-call turns, 2.8× faster latency, and 2.6× fewer input tokens on a real 1,268-file NestJS + Next.js production codebase. Source: `README.md`, `docs/benchmarks/2026-04-30-govalidate/README.md`.
- **Measured PR-review benchmark:** compact `pr_impact` prompts were 7.244× smaller than verbose prompts, with 6.879× smaller payloads, on a real 36-file production diff. Source: `docs/benchmarks/2026-05-01-govalidate-pr-review/README.md`.
- **Local-first deployment:** no telemetry, no cloud, no API key required by default; the MCP integration runs as a local stdio subprocess. Source: `README.md`.
- **Practical MCP surface:** default core profile ships `retrieve`, `impact`, `call_chain`, `community_overview`, `pr_impact`, and `graph_stats`, with 21 tools available via `GRAPHIFY_TOOL_PROFILE=full`. Source: `src/runtime/stdio/definitions.ts`, `README.md`.

## Install commands

### Primary quickstart

```bash
npm install -g @mohammednagy/graphify-ts

cd your-project
graphify-ts generate .
graphify-ts claude install
```

### Other supported agent installs

```bash
graphify-ts cursor install
graphify-ts copilot install
graphify-ts gemini install
graphify-ts aider install
```

## Canonical links

- **Repository:** https://github.com/mohanagy/graphify-ts
- **Homepage:** https://github.com/mohanagy/graphify-ts#readme
- **Package:** https://www.npmjs.com/package/@mohammednagy/graphify-ts
- **Hosted benchmark landing page:** https://mohanagy.github.io/graphify-ts/
- **Hosted retrieval benchmark page:** https://mohanagy.github.io/graphify-ts/2026-04-30-govalidate/
- **Hosted PR-review benchmark page:** https://mohanagy.github.io/graphify-ts/2026-05-01-govalidate-pr-review/

## Submission asset placeholders

Use these placeholders if a marketplace or PR template asks for screenshots, demos, or branded links later.

- **Screenshot placeholder:** `TBD — terminal quickstart after \`graphify-ts generate .\` and \`graphify-ts claude install\``
- **Screenshot placeholder:** `TBD — hosted benchmark landing page at https://mohanagy.github.io/graphify-ts/`
- **Screenshot placeholder:** `TBD — PR-review proof page showing compact vs verbose \`pr_impact\` results`
- **Demo link placeholder:** `TBD — short install / retrieval walkthrough clip`
- **Logo/icon placeholder:** `TBD — square project mark for registries that support icons`
