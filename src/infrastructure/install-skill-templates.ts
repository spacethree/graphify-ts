import type { InstallPlatform } from './install.js'

/**
 * Built-in skill template generation for graphify.
 *
 * This module programmatically generates platform-specific `SKILL.md` content so the
 * npm package stays self-contained even when `assets/skills/` is not shipped. Package
 * assets take precedence when present; these built-in templates are the fallback.
 */
type PlatformKind = 'default' | 'codex' | 'opencode' | 'claw' | 'droid' | 'trae' | 'windows'

const CODE_BLOCK_START = '[[[GRAPHIFY_CODE_BLOCK_START]]]'
const CODE_BLOCK_END = '[[[GRAPHIFY_CODE_BLOCK_END]]]'
const CODE_SPAN_START = '[[[GRAPHIFY_CODE_SPAN_START]]]'
const CODE_SPAN_END = '[[[GRAPHIFY_CODE_SPAN_END]]]'

const PLATFORM_KIND_BY_INSTALL_PLATFORM: Record<InstallPlatform, PlatformKind> = {
  claude: 'default',
  codex: 'codex',
  opencode: 'opencode',
  claw: 'claw',
  droid: 'droid',
  trae: 'trae',
  'trae-cn': 'trae',
  windows: 'windows',
}

const FRONTMATTER: Record<PlatformKind, string> = {
  default: `---
name: graphify
description: any input (code, docs, papers, images) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: /graphify
---`,
  codex: `---
name: graphify
description: any input (code, docs, papers, images) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: /graphify
---`,
  opencode: `---
name: graphify
description: any input (code, docs, papers, images) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: /graphify
---`,
  claw: `---
name: graphify
description: any input (code, docs, papers, images) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: /graphify
---`,
  droid: `---
name: graphify
description: any input (code, docs, papers, images) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: /graphify
---`,
  trae: `---
name: graphify
description: any input (code, docs, papers, images) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: /graphify
---`,
  windows: `---
name: graphify-windows
description: any input (code, docs, papers, images) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: /graphify
---`,
}

function commonOverview(): string {
  return `# /graphify

Turn any folder of files into a navigable knowledge graph with community detection, an honest audit trail, and three outputs: interactive HTML, GraphRAG-ready JSON, and a plain-language GRAPH_REPORT.md.

## Usage

${CODE_BLOCK_START}
/graphify
/graphify <path>
/graphify <path> --mode deep
/graphify <path> --update
/graphify <path> --cluster-only
/graphify <path> --no-viz
/graphify <path> --svg
/graphify <path> --graphml
/graphify <path> --neo4j
/graphify <path> --neo4j-push bolt://localhost:7687
/graphify <path> --mcp
/graphify <path> --watch
/graphify add <url>
/graphify add <url> --author "Name"
/graphify add <url> --contributor "Name"
/graphify query "<question>"
/graphify query "<question>" --dfs
/graphify query "<question>" --budget 1500
/graphify path "AuthModule" "Database"
/graphify explain "SwinTransformer"
${CODE_BLOCK_END}

## What graphify is for

graphify is built around the /raw-folder workflow: drop anything into a folder—papers, tweets, screenshots, code, notes—and get a structured knowledge graph that shows you what you did not know was connected.

Three things it does that an assistant alone cannot:
1. **Persistent graph** — relationships are stored in ${CODE_SPAN_START}graphify-out/graph.json${CODE_SPAN_END} and survive across sessions.
2. **Honest audit trail** — every edge is tagged EXTRACTED, INFERRED, or AMBIGUOUS.
3. **Cross-document surprise** — community detection exposes connections across files that users often would not ask for directly.

Use it for:
- a codebase you are new to
- a reading list (papers + tweets + notes)
- a research corpus
- a personal /raw folder that keeps growing

## What You Must Do When Invoked

If no path was given, use ${CODE_SPAN_START}.${CODE_SPAN_END} (current directory). Do not ask the user for a path.

Follow these steps in order and do not skip steps.
`
}

function posixInstallStep(): string {
  return `### Step 1 - Ensure the TypeScript CLI is available

${CODE_BLOCK_START}bash
command -v node >/dev/null 2>&1 || {
  echo "[graphify] Node.js is required for graphify-ts."
  exit 1
}
node dist/src/cli/bin.js --help >/dev/null 2>&1 || npx --yes graphify-ts --help >/dev/null 2>&1 || {
  echo "[graphify] graphify-ts CLI is not available in this environment."
  echo "[graphify] Install or build the TypeScript package before continuing."
  exit 1
}
mkdir -p graphify-out
${CODE_BLOCK_END}

Use Node.js / TypeScript tooling only. Never install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
`
}

function windowsInstallStep(): string {
  return `### Step 1 - Ensure the TypeScript CLI is available

${CODE_BLOCK_START}powershell
npx --yes graphify-ts --help *> $null
if ($LASTEXITCODE -ne 0) {
  node dist/src/cli/bin.js --help *> $null
}
if ($LASTEXITCODE -ne 0) {
  Write-Error "graphify-ts CLI is not available in this environment. Install or build the TypeScript package before continuing."
  exit 1
}
mkdir -p graphify-out
${CODE_BLOCK_END}

Use Node.js / TypeScript tooling only. Never install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
`
}

function detectStep(codeFence: 'bash' | 'powershell'): string {
  const targetPathDeclaration = codeFence === 'bash' ? 'TARGET_PATH="."' : '$TargetPath = "."'
  const availabilityCheck =
    codeFence === 'bash'
      ? 'node dist/src/cli/bin.js --help >/dev/null 2>&1 || npx --yes graphify-ts --help >/dev/null 2>&1'
      : 'npx --yes graphify-ts --help *> $null; if ($LASTEXITCODE -ne 0) { node dist/src/cli/bin.js --help *> $null }'

  return `### Step 2 - Detect files with the TypeScript implementation

${CODE_BLOCK_START}${codeFence}
${targetPathDeclaration}
# If the user supplied a path, set the shell variable above before running this command.
${availabilityCheck}
${CODE_BLOCK_END}

If this installation does not yet expose a top-level TypeScript detect/build command, stop and explain that limitation clearly.
Never fall back to Python.
Do not print the JSON directly; present a concise summary instead:

- Corpus: X files · ~Y words
- code/docs/papers/images counts

If ${CODE_SPAN_START}total_files${CODE_SPAN_END} is 0, stop.
If the corpus is very large, warn and ask which subfolder to run on.
Otherwise continue directly.
`
}

function semanticDispatchSection(kind: PlatformKind): string {
  if (kind === 'codex') {
    return `**Step B2 - Dispatch with Codex workers**

Use ${CODE_SPAN_START}spawn_agent${CODE_SPAN_END} once per chunk and launch all workers in the same response so they run in parallel. Collect results with ${CODE_SPAN_START}wait(handle)${CODE_SPAN_END} and then ${CODE_SPAN_START}close_agent(handle)${CODE_SPAN_END}.
`
  }

  if (kind === 'opencode') {
    return `**Step B2 - Dispatch with OpenCode mentions**

Use one ${CODE_SPAN_START}@mention${CODE_SPAN_END} per chunk and send all mentions in a single message so they run in parallel.
`
  }

  if (kind === 'claw') {
    return `**Step B2 - Sequential extraction (OpenClaw)**

OpenClaw support is still early, so extraction runs sequentially. Read each uncached file yourself, extract nodes/edges/hyperedges, and accumulate the results. Mention clearly that this platform is sequential.
`
  }

  if (kind === 'droid') {
    return `**Step B2 - Dispatch with Factory Droid tasks**

Use the ${CODE_SPAN_START}Task${CODE_SPAN_END} tool once per chunk. Launch every task in the same response so the workers execute in parallel and return structured JSON.
`
  }

  if (kind === 'trae') {
    return `**Step B2 - Dispatch with the Agent (Task) tool**

Use the Agent/Task tool once per chunk. Launch all agents in parallel, collect structured JSON from each worker, and merge the results. Trae does not support PreToolUse hooks, so AGENTS.md is the always-on integration mechanism.
`
  }

  return `**Step B2 - Dispatch all extraction subagents in parallel**

Use the Agent tool once per chunk and launch every worker in the same response. Each worker must return only valid JSON containing nodes, edges, hyperedges, and token counts.
`
}

function extractionRules(): string {
  return `### Step 3 - Extract entities and relationships

Before starting, note whether ${CODE_SPAN_START}--mode deep${CODE_SPAN_END} was given. Pass that state through every semantic worker.

This step has two parts: structural extraction (deterministic, free) and semantic extraction (LLM, costs tokens).

Run Part A (AST) and Part B (semantic) in parallel whenever possible.

#### Part A - Structural extraction for code files

Use the deterministic extractor for code files and write the result to ${CODE_SPAN_START}.graphify_ast.json${CODE_SPAN_END}.

#### Part B - Semantic extraction

Fast path: if the corpus is code-only, skip semantic extraction.

Before dispatching subagents:
- check the semantic cache
- split uncached files into chunks of roughly 20-25 files
- keep related files together when possible

Required extraction rules:
- EXTRACTED = explicit in source
- INFERRED = reasonable inference
- AMBIGUOUS = uncertain but still worth flagging
- include rationale nodes and ${CODE_SPAN_START}rationale_for${CODE_SPAN_END} edges when the corpus explains why a decision was made
- add ${CODE_SPAN_START}semantically_similar_to${CODE_SPAN_END} sparingly for genuinely cross-cutting similarities
- confidence_score is required on every edge
- EXTRACTED confidence_score = 1.0

Worker output schema:
${CODE_BLOCK_START}json
{"nodes":[{"id":"filestem_entityname","label":"Human Readable Name","file_type":"code|document|paper|image","source_file":"relative/path","source_location":null,"source_url":null,"captured_at":null,"author":null,"contributor":null}],"edges":[{"source":"node_id","target":"node_id","relation":"calls|implements|references|cites|conceptually_related_to|shares_data_with|semantically_similar_to|rationale_for","confidence":"EXTRACTED|INFERRED|AMBIGUOUS","confidence_score":1.0,"source_file":"relative/path","source_location":null,"weight":1.0}],"hyperedges":[{"id":"snake_case_id","label":"Human Readable Label","nodes":["node_id1","node_id2","node_id3"],"relation":"participate_in|implement|form","confidence":"EXTRACTED|INFERRED","confidence_score":0.75,"source_file":"relative/path"}],"input_tokens":0,"output_tokens":0}
${CODE_BLOCK_END}
`
}

function buildAndExploreSection(kind: PlatformKind): string {
  return `### Step 4 - Build graph, cluster, analyze, and export

After merging AST + semantic extraction:
- build the graph
- cluster communities
- score cohesion
- generate GRAPH_REPORT.md and graph.json
- stop immediately if the graph is empty

### Step 5 - Label communities

Write concise 2-5 word labels for each community and regenerate the report with those labels.

### Step 6 - HTML, optional Obsidian, and optional extra exports

Generate HTML by default unless ${CODE_SPAN_START}--no-viz${CODE_SPAN_END} was given.
Generate Obsidian only when explicitly requested.

Optional exports:
- ${CODE_SPAN_START}--neo4j${CODE_SPAN_END} → Cypher file
- ${CODE_SPAN_START}--neo4j-push${CODE_SPAN_END} → direct push
- ${CODE_SPAN_START}--svg${CODE_SPAN_END} → SVG
- ${CODE_SPAN_START}--graphml${CODE_SPAN_END} → GraphML
- ${CODE_SPAN_START}--mcp${CODE_SPAN_END} → start the TypeScript stdio runtime with a minimal MCP-compatible prompt/resource/tool surface

### Step 7 - Benchmark and cleanup

If the corpus has more than 5,000 words, run the token reduction benchmark. Save the manifest, update the cost tracker, clean up temp files, then present only these report sections:
- God Nodes
- Surprising Connections
- Suggested Questions

Then immediately offer exploration by asking for the most interesting suggested question.
`
}

function subcommandSection(kind: PlatformKind): string {
  const localConfigTarget =
    kind === 'trae'
      ? 'AGENTS.md (Trae)'
      : kind === 'claw'
        ? 'AGENTS.md (OpenClaw)'
        : kind === 'codex'
          ? 'AGENTS.md (Codex)'
          : kind === 'opencode'
            ? 'AGENTS.md (OpenCode)'
            : kind === 'droid'
              ? 'AGENTS.md (Factory Droid)'
              : 'CLAUDE.md / AGENTS.md'
  return `## Subcommands

- ${CODE_SPAN_START}/graphify query${CODE_SPAN_END} — choose BFS by default, DFS with ${CODE_SPAN_START}--dfs${CODE_SPAN_END}, answer only from the graph, and save the answer back with ${CODE_SPAN_START}save-result${CODE_SPAN_END}.
- ${CODE_SPAN_START}/graphify path${CODE_SPAN_END} — find the shortest path between two concepts, explain each hop, then save the explanation back.
- ${CODE_SPAN_START}/graphify explain${CODE_SPAN_END} — explain one node and its neighborhood using graph evidence only.
- ${CODE_SPAN_START}/graphify add${CODE_SPAN_END} — fetch a URL into ${CODE_SPAN_START}./raw${CODE_SPAN_END} and then run ${CODE_SPAN_START}--update${CODE_SPAN_END}.
- ${CODE_SPAN_START}/graphify --update${CODE_SPAN_END} — incremental re-extraction; skip semantic work when all changed files are code.
- ${CODE_SPAN_START}/graphify --cluster-only${CODE_SPAN_END} — re-cluster an existing graph.
- ${CODE_SPAN_START}/graphify --watch${CODE_SPAN_END} — supported code, docs, papers, and images trigger automatic rebuilds; manual refresh is only needed for unsupported future formats.
- ${CODE_SPAN_START}graphify hook install|uninstall|status${CODE_SPAN_END} — manage git hooks for rebuild reminders.
- ${CODE_SPAN_START}graphify claude install${CODE_SPAN_END} or the platform-specific installer — write always-on instructions to ${localConfigTarget}.
`
}

function honestyRules(): string {
  return `## Honesty Rules

- Never invent an edge. If unsure, mark it AMBIGUOUS.
- Never skip the corpus size warning.
- Always surface token cost.
- Show raw cohesion scores.
- Warn before attempting HTML visualization on graphs larger than 5,000 nodes.
- Never install or invoke Python, pip, a legacy Python package, or a deleted reference checkout as a fallback.
`
}

function windowsTroubleshooting(): string {
  return `## Troubleshooting

### PowerShell scrolling or ANSI issues

If the terminal behaves oddly after a run:
1. upgrade graphify-ts
2. prefer Windows Terminal over the legacy console
3. reopen the shell if ANSI output from graph libraries corrupted rendering
`
}

function renderMarkdownWithCodeFences(markdown: string): string {
  const rendered = markdown.replaceAll(CODE_BLOCK_START, '```').replaceAll(CODE_BLOCK_END, '```').replaceAll(CODE_SPAN_START, '`').replaceAll(CODE_SPAN_END, '`')

  if (rendered.includes(CODE_BLOCK_START) || rendered.includes(CODE_BLOCK_END) || rendered.includes(CODE_SPAN_START) || rendered.includes(CODE_SPAN_END)) {
    throw new Error('error: built-in skill template rendering left unresolved code markers')
  }

  return rendered
}

function buildSkillDocument(kind: PlatformKind): string {
  const parts = [
    FRONTMATTER[kind],
    commonOverview(),
    kind === 'windows' ? windowsInstallStep() : posixInstallStep(),
    detectStep(kind === 'windows' ? 'powershell' : 'bash'),
    extractionRules(),
    semanticDispatchSection(kind),
    buildAndExploreSection(kind),
    subcommandSection(kind),
    kind === 'windows' ? windowsTroubleshooting() : '',
    honestyRules(),
  ].filter((part) => part.length > 0)

  return renderMarkdownWithCodeFences(parts.join('\n\n').trimEnd() + '\n')
}

/**
 * Generate a complete built-in `SKILL.md` document for the requested install platform.
 */
export function getBuiltInSkillContent(platform: InstallPlatform): string {
  const content = buildSkillDocument(PLATFORM_KIND_BY_INSTALL_PLATFORM[platform])

  if (content.trim().length === 0) {
    throw new Error(`error: built-in template for ${platform} generated empty content`)
  }

  return content
}
