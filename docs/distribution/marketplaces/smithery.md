# Smithery submission copy

## Short description

Local-first MCP server and CLI that turns your repo into a knowledge graph so AI agents can answer codebase questions and review PRs in fewer turns.

## Long description

graphify-ts builds a local knowledge graph from your codebase, then exposes that graph through an MCP stdio server for tools like Claude Code, Cursor, GitHub Copilot, Gemini CLI, and Aider. Its wedge is privacy-preserving codebase understanding plus diff-aware PR review: instead of making an agent crawl your repo with repeated file reads, graphify-ts returns ranked graph context in one MCP call and can analyze changed lines with `pr_impact`, `risk_map`, and `review-compare`.

The public proof is already published: on a real 1,268-file production codebase, graphify-ts cut tool-call turns from 9 to 3, reduced latency from 96 seconds to 35 seconds, and reduced total input tokens from 615,190 to 233,508. A separate PR-review benchmark shows compact `pr_impact` packaging shrinking prompts 7.244× on a real production diff.

## Feature bullets

- Local-first MCP stdio server with no cloud requirement and no API key by default
- Builds codebase knowledge graphs from local repos, docs, and mixed project folders
- Core MCP tools for retrieval, impact analysis, call chains, community overviews, PR impact, and graph stats
- Diff-aware PR-review workflow with `pr_impact`, `risk_map`, and `review-compare`
- Install helpers for Claude Code, Cursor, GitHub Copilot, Gemini CLI, and Aider

## Local/privacy note

graphify-ts is designed for local use first. Tree-sitter extraction, graph building, BM25 retrieval, and optional local ONNX ranking all run on your machine, and the MCP integration runs as a local stdio subprocess. Your code does not need to leave the laptop unless you explicitly choose to run an external model command yourself.

## Install command

```bash
npm install -g @mohammednagy/graphify-ts
cd your-project
graphify-ts generate .
graphify-ts claude install
```

## Hosted benchmark links

- Hosted benchmark landing page: https://mohanagy.github.io/graphify-ts/
- Retrieval benchmark page: https://mohanagy.github.io/graphify-ts/2026-04-30-govalidate/
- PR-review benchmark page: https://mohanagy.github.io/graphify-ts/2026-05-01-govalidate-pr-review/
- Raw retrieval benchmark artifact: https://github.com/mohanagy/graphify-ts/tree/main/docs/benchmarks/2026-04-30-govalidate
- Raw PR-review benchmark artifact: https://github.com/mohanagy/graphify-ts/tree/main/docs/benchmarks/2026-05-01-govalidate-pr-review
