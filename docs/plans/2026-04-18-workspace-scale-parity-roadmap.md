# graphify-ts workspace-scale parity roadmap

> **Active roadmap:** This is the roadmap that now drives implementation planning. The older `2026-04-12-upstream-parity-and-beyond.md` document remains in the repo as historical context only.

## Goal

Make `graphify-ts` produce useful, trustworthy graphs when pointed at a large **top-level workspace** that contains multiple apps, services, repos, docs, and shared tooling, without requiring users to rerun the tool on nested folders just to get a usable result.

For this roadmap, parity means:

- top-level mixed workspaces should yield graph structure that is meaningfully useful
- graph connectivity and community quality should move materially toward the original Graphify experience
- `query`, `explain`, reports, and HTML should stay helpful at workspace scale
- parity work must not be bought by growing more god files

## Why this roadmap replaces the old one

The previous roadmap was too broad for the current product reality. It mixed multimodal ambitions, semantic overlays, language expansion, platform hardening, and long-term differentiation into one large plan. That created a real risk: roadmap progress could continue while the main user-visible gap remained unresolved.

The sharpest current gap is now clear: `graphify-ts` still underperforms on **large mixed workspaces** unless the user manually targets nested folders. That is a product gap, not an acceptable workaround.

This roadmap therefore narrows active planning to one outcome: **workspace-scale graph quality parity plus production-code decomposition**.

## Non-goals

This roadmap does **not** aim to:

- clone every upstream feature one-for-one
- broaden multimodal or semantic scope unless it directly improves workspace-scale graph quality
- treat “run it on a subfolder” as a successful fix
- postpone god-file cleanup to an indefinite later phase

## Hard rules

### 1. No workaround-based success

Nested runs can remain a user option, but they do not count as roadmap success. The primary success condition is top-level mixed-workspace usefulness.

### 2. No parity progress by growing monoliths

Known production hotspots must not grow as a side effect of parity work. In particular:

- `src/pipeline/extract.ts`
- `src/pipeline/extract/non-code.ts`
- `src/pipeline/export.ts`
- `src/runtime/stdio-server.ts`
- other orchestrator-style files that become roadmap hotspots

The expectation is simple: roadmap slices should either keep hotspot size flat or move logic into smaller bounded modules. Production code comes first; tests can follow when the refactor pressure reaches them or they become blockers.

### 3. Evaluate on real mixed-workspace corpora

Every meaningful roadmap claim should be checked against umbrella workspaces that include multiple app/service folders, docs, and shared infrastructure, not just neat single-package repositories.

### 4. Optimize for usefulness, not synthetic density

The target is not “more edges at any cost.” The target is:

- fewer meaningless singleton islands
- fewer tiny disconnected components when the workspace is actually related
- more coherent communities
- better bridge detection
- better top-level `query` / `explain` usefulness
- more readable HTML and report outputs

## Phase roadmap

### Phase 1 - Baseline mixed-workspace parity harness

**Objective:** define the problem rigorously on real workspace corpora before changing behavior.

**Primary outcomes:**

- benchmark corpora that reflect real umbrella workspaces
- baseline measurements for isolated-node rate, small-component count, low-cohesion communities, and top-level query usefulness
- a parity scorecard for workspace-scale graph quality

**Progress so far:**

- `GRAPH_REPORT.md` now emits baseline entity-level fragmentation signals for weakly connected components, singleton components, isolated nodes, largest-component share, and low-cohesion community baselines so mixed-workspace runs can be compared numerically before deeper stitching work lands.
- `graphify-ts benchmark` now reuses that same entity-level structure basis to print a compact workspace-parity scorecard alongside token-reduction output when the graph artifact carries enough `source_file` provenance to compute it safely, including low-cohesion community signals on the same shared entity basis, giving Phase 1 a reproducible CLI-facing measurement surface before stitching changes land.
- A compact checked-in `tests/fixtures/workspace-parity/` corpus now gives Phase 1 a reproducible mixed-workspace baseline across `generate` + report + benchmark flows in CI instead of relying only on ad hoc local workspaces.
- A companion `tests/fixtures/workspace-parity-questions.json` pack now locks fixture-backed benchmark question coverage as part of the same Phase 1 baseline, and the benchmark path now shares the runtime query scorer plus query-output token sizing so usefulness regressions are visible even when fragmentation metrics stay flat.
- The first Phase 2 stitching slice is now shipped: direct JS/TS relative imports in the checked-in mixed-workspace fixture now resolve onto real top-level exported nodes for named, default, and namespace forms, including incremental `contextNodes` rebuilds plus lexical-shadowing and nested-helper ownership cases, so `backend/api.ts` and `web-app/session.ts` both land on `shared/auth.ts` without pulling `worker/jobs.ts` into the same component.
- The second Phase 2 stitching slice is now also shipped: explicit local relative re-export barrels with direct declarations such as `export { createSession } from './auth.js'` now preserve those same source-backed links through `shared/index.ts`, so the checked-in mixed-workspace fixture can route both app roots through a barrel without regressing back to the earlier fragmented baseline.
- The third Phase 2 stitching slice is now also shipped: local relative `export *` barrels now preserve those same source-backed links, common imported-binding barrels such as `import { createSession } from './auth.js'; export { createSession }` still resolve back to the real shared target, explicit exports stay authoritative when wildcard sources conflict, local wildcard-barrel cycles keep the real shared target reachable, and explicit-extension imports no longer fall through onto unrelated source file types.
- The fourth Phase 2 stitching slice is now also shipped: anonymous default-export targets in JS/TS files now get a stable source-backed `default` node identity, so direct default imports, local default barrels like `export { default } from './auth.js'`, and imported-binding default barrels like `import createSession from './auth.js'; export default createSession` still land on the real shared target instead of fragmenting the workspace graph, calls inside those anonymous default bodies still stitch onto imported helpers, and `generate --update` now falls back to a full rebuild when the retained graph predates the current extractor version so stale pre-slice graph artifacts do not hide the new links.
- That fixture's benchmark/report baseline remains improved from 5 weakly connected components, 4 singleton components, 4 isolated nodes, and a 2-node largest component to 3 weakly connected components, 2 singleton components, 2 isolated nodes, and a 4-node largest component, giving Phase 2 four measurable before/after wins without resorting to heuristic folder merging.
- The first Phase 3 output-usefulness slice is now shipped: reports and overview-first HTML exports share a ranked workspace-bridge analysis so large mixed-workspace outputs surface cross-community starting points before users manually narrow into one folder or community.
- The second Phase 3 output-usefulness slice is now shipped: runtime `query` output and `explain` node summaries preserve generated community labels and surface workspace-bridge context when bridge nodes appear in the answer, so broad mixed-workspace questions point users at real cross-community chokepoints without adding noisy structural edges.
- The third Phase 3 output-usefulness slice is now shipped: benchmark question packs can use object-backed specs with `expected_labels`, and `graphify-ts benchmark` now reports expected-evidence label coverage plus per-question missing evidence so broad mixed-workspace answer regressions are visible even when a query still returns some subgraph.
- The first Phase 4 cleanup slice is now shipped: benchmark question-pack normalization, query sizing reuse, and expected-label evidence matching moved into `src/infrastructure/benchmark/questions.ts`, keeping `src/infrastructure/benchmark.ts` focused on graph loading, result aggregation, and printing.
- The second Phase 4 cleanup slice is now shipped: overview bridge-summary mapping and reusable node-anchor generation moved into `src/pipeline/export/overview-bridges.ts`, keeping `src/pipeline/export.ts` flatter while preserving overview-first bridge links.
- The third Phase 4 cleanup slice is now shipped: overview top-node and search-index link construction moved into `src/pipeline/export/overview-navigation.ts`, keeping overview navigation behavior stable while trimming more mapping logic out of `src/pipeline/export.ts`.
- The fourth Phase 4 cleanup slice is now shipped: oversized-community summary page node/file/search data moved into `src/pipeline/export/community-summary.ts`, preserving summary-only fallback pages while keeping `src/pipeline/export.ts` focused on HTML assembly.
- The fifth Phase 4 cleanup slice is now shipped: stdio MCP tool and prompt definitions moved into `src/runtime/stdio/definitions.ts`, keeping protocol schema registration separate from request handling and prompt-context rendering.
- The sixth Phase 4 cleanup slice is now shipped: shared TypeScript AST expression unwrapping moved into `src/pipeline/extract/typescript-utils.ts`, so raw JS/TS extraction and cross-file linking no longer duplicate parenthesized default-export handling.
- Phase 4 is complete for this roadmap slice: benchmark, export, runtime, and extractor hotspot responsibilities now have dedicated seams while the workspace-parity behavior remains covered by regression tests.

**Exit criteria:**

- at least one representative mixed-workspace corpus is checked into the evaluation workflow or otherwise reproducibly measured
- the current failure modes are recorded in terms stronger than “the graph looks fragmented”
- roadmap work can be judged against stable before/after evidence

### Phase 2 - Workspace stitching and boundary-aware linking

**Objective:** improve graph structure for large top-level workspaces without collapsing unrelated folders together.

**Primary outcomes:**

- stronger cross-file and cross-folder stitching
- better treatment of workspace boundaries, shared infrastructure, and top-level docs/configs
- fewer false singleton or tiny-island nodes in related workspaces

**Exit criteria:**

- top-level mixed-workspace graphs show materially lower fragmentation on the parity harness
- the resulting connectivity is more useful without becoming noisy or indiscriminate

### Phase 3 - Workspace output usefulness

**Objective:** make reports, HTML, and runtime queries useful even before perfect structural parity is reached.

**Primary outcomes:**

- better top-level report summaries for large mixed workspaces
- HTML/report emphasis on real bridges, dominant subsystems, and navigable clusters
- query/explain behavior that remains helpful when the workspace is broad

**Exit criteria:**

- top-level `query` and `explain` improve on benchmark questions
- HTML/report outputs help users understand the workspace without requiring manual narrowing first

### Phase 4 - God-file retirement on the parity path

**Objective:** ensure parity work leaves the production codebase more modular than it is today.

**Primary outcomes:**

- production hotspot decomposition along real responsibility boundaries
- clearer extraction, linking, export, and runtime seams
- parity features landing in dedicated modules rather than swelling orchestrators

**Exit criteria:**

- the main production hotspots are smaller or flatter than at roadmap start
- new parity slices stop relying on giant “do everything” files
- roadmap progress and architectural health move together instead of competing

## Success criteria for the roadmap as a whole

This roadmap is successful when all of the following are true:

- a user can point `graphify-ts` at a large top-level mixed workspace and get a graph that is meaningfully useful
- workspace-scale outputs feel materially closer to the original Graphify experience
- the repo no longer depends on a handful of growing production god files to deliver parity work
- the active roadmap is narrow, current, and honest about what it is trying to solve
