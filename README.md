# graphify-ts

Build a local knowledge graph from a codebase or mixed project folder, then explore it through an interactive HTML view, CLI queries, or a lightweight server. `graphify-ts` is the Node/TypeScript implementation of the graphify workflow and does **not** require a Python runtime.

The npm package name is `@mohammednagy/graphify-ts`, and the installed command is `graphify-ts`.

> Note: the npm scope follows the npm account name (`mohammednagy`), while the GitHub repository is `mohanagy/graphify-ts`.

## What you get

After a successful `generate` run, `graphify-ts` writes artifacts into `graphify-out/`:

```text
graphify-out/
├── graph.html       interactive graph explorer
├── GRAPH_REPORT.md  summary report with god nodes and suggested questions
├── graph.json       machine-readable graph for query/serve flows
└── cache/           content-addressed extraction cache
```

Optional exports are also available for wiki, Obsidian, SVG, GraphML, and Neo4j workflows.

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

## Use it globally from this checkout

From this repository root, install the CLI globally on your machine:

```bash
npm install
npm install -g .
graphify-ts --help
```

## Run from a repo checkout

If you are developing locally from this repository:

```bash
npm install
npm run build
node dist/src/cli/bin.js --help
```

## AI assistant integration

There are two different kinds of install commands:

- `graphify-ts install --platform claude` installs the home-level Claude skill for your user account
- `graphify-ts claude install` installs project-local Claude integration for the current repository

You do **not** have to run `graphify-ts generate .` before either install command for them to succeed.

You run `graphify-ts generate .` because the installed Claude rules point Claude at graph artifacts inside `graphify-out/`, especially:

- `graphify-out/graph.json`
- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/wiki/index.md` (when wiki export exists)

Without those files, the skill/rules are installed, but Claude has no generated graph context to read yet.

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

### Useful next commands

```bash
graphify-ts query "how does the auth flow work?" --graph graphify-out/graph.json
graphify-ts explain "SomeNodeLabel" --graph graphify-out/graph.json
graphify-ts path "SourceConcept" "TargetConcept" --graph graphify-out/graph.json
graphify-ts serve graphify-out/graph.json
graphify-ts serve graphify-out/graph.json --mcp
```

Replace `SomeNodeLabel`, `SourceConcept`, and `TargetConcept` with labels that actually exist in your generated graph.

## How to test it as an end user

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
| `watch [path]` | Build once, then watch for code/doc changes |
| `serve [graph.json]` | Serve graph artifacts over HTTP or stdio |
| `query "<question>"` | Traverse `graph.json` for a question |
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

- Python, Go, and Java via portable WASM tree-sitter
- several additional languages via lighter structural extraction
- deterministic document, paper, and image handling
- lightweight HTTP and stdio/MCP-style serving

For the detailed implementation status, limitations, and roadmap material that used to live in this README, see:

- [`docs/plans/current-status.md`](docs/plans/current-status.md)

## Contributing

Contributions are welcome — especially parser fixes, fixture-backed regression coverage, docs improvements, install-flow polish, and graph-quality improvements.

Before opening a pull request, please read:

- [`CONTRIBUTING.md`](https://github.com/mohanagy/graphify-ts/blob/main/CONTRIBUTING.md)
- [`SECURITY.md`](https://github.com/mohanagy/graphify-ts/blob/main/SECURITY.md)

The repository now includes:

- GitHub issue forms for bugs and feature requests
- a pull request template
- `CODEOWNERS`
- a CI workflow that runs typecheck, tests, build, and `npm pack --dry-run`

If you maintain the repository, apply the recommended GitHub branch protection and open-source safety settings from:

- [`docs/maintainers/repository-settings.md`](docs/maintainers/repository-settings.md)

## Verifying the repo checkout itself

If you want to validate the checkout in addition to the end-user smoke test, run:

```bash
npm run test:run
npm run typecheck
npm run build
npm pack --dry-run
```

## Verify the published package

If you want to verify the live npm release directly:

```bash
npm view @mohammednagy/graphify-ts version name
```
