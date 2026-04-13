# Phase 1 Platform Foundation and Schema Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make extraction and ingest capability-driven while introducing additive schema-v2 layer/provenance contracts without breaking current v1 graph consumers.

**Architecture:** Keep the current deterministic extraction flow intact, but insert two new seams: a typed builtin capability registry for extraction/ingest dispatch and an additive schema-v2 normalization layer for graph metadata. Phase 1 should not introduce dynamic plugin loading or AI providers yet; it should create the stable interfaces and backward-compatible contracts those later phases will need.

**Tech Stack:** Node.js, TypeScript, Vitest, TypeScript compiler API, `web-tree-sitter`, `@vscode/tree-sitter-wasm`, current CLI/build/test scripts from `package.json`.

> **Status update (2026-04-13):** The first implementation slices from this plan are now complete and verified: a fixture-backed schema-v2 contract test suite, additive `schema_version` / `layer` / `provenance` validation, a builtin capability-registry foundation with normalized extension lookup plus source-classification-aware disambiguation and duplicate-claim protection, immutable schema normalization helpers that upgrade legacy payloads in the graph-build path, registry-driven single-file extraction dispatch in `src/pipeline/extract/dispatch.ts`, registry-driven multi-file extraction aggregation in `src/pipeline/extract/combine.ts`, registry-driven Python cross-file linking in `src/pipeline/extract/cross-file.ts`, registry-driven ingest dispatch in `src/infrastructure/ingest/dispatch.ts`, explicit top-level `schema_version` preservation through `build()`, `graph.json` export, graph reload, and incremental `generate --update` rebuilds, helper-created raw extraction output that now emits explicit base-layer/provenance metadata before normalization, extractor-cache invalidation for stale pre-metadata raw payloads, and normalization-time projection of flat ingest frontmatter into structured ingest provenance while keeping captured files backward-compatible on disk. Remaining Phase 1 work is now narrower: extend that richer metadata emission across the remaining specialized extraction/ingest flows instead of relying on normalization defaults in those corners.

---

## Scope guardrails

This phase is successful only if all of the following remain true:

- deterministic extraction still works with no network and no provider configured
- existing extraction payloads still validate and build successfully
- current CLI commands keep working
- `graph.json`, `GRAPH_REPORT.md`, and HTML export remain backward-compatible for current users
- new schema metadata is additive rather than destructive

This phase intentionally does **not** include:

- dynamic external plugin loading
- AI provider integration
- video/audio transcription
- broader AST rollout beyond the existing language set
- schema-breaking changes to runtime consumers

## Task 1: Lock current behavior and define Phase 1 expectations in tests

**Files:**
- Create: `tests/fixtures/extraction-v2.json`
- Create: `tests/unit/schema-v2.test.ts`
- Create: `tests/unit/capability-registry.test.ts`
- Modify: `tests/unit/validate.test.ts`
- Modify: `tests/unit/build.test.ts`
- Modify: `tests/unit/export.test.ts`

**Step 1: Write failing schema-v2 validation tests**

Add tests that describe the minimum additive v2 contract:

- top-level `schema_version`
- optional `layer` on nodes, edges, and hyperedges
- optional `provenance` records
- legacy v1 payloads still validate unchanged

Include one fixture-backed test using `tests/fixtures/extraction-v2.json` and one inline-object test for a legacy payload.

**Step 2: Write failing capability-registry tests**

Add tests describing the expected behavior of a builtin capability registry:

- registers builtin extract capabilities
- registers builtin ingest capabilities
- resolves a code file to an extractor capability
- resolves a URL kind to an ingest capability
- rejects duplicate capability ids

**Step 3: Run tests to verify they fail for the right reasons**

Run:

```bash
npx vitest run tests/unit/schema-v2.test.ts tests/unit/capability-registry.test.ts tests/unit/validate.test.ts tests/unit/build.test.ts tests/unit/export.test.ts
```

Expected:
- schema-v2 tests fail because contracts/validation do not yet support `schema_version`, `layer`, or `provenance`
- capability-registry tests fail because the registry module does not exist yet
- existing tests remain useful guardrails for backward compatibility

**Step 4: Commit checkpoint**

```bash
git add tests/fixtures/extraction-v2.json tests/unit/schema-v2.test.ts tests/unit/capability-registry.test.ts tests/unit/validate.test.ts tests/unit/build.test.ts tests/unit/export.test.ts
git commit -m "test: define phase 1 schema and registry expectations"
```

## Task 2: Add additive schema-v2 contracts and normalization

**Files:**
- Create: `src/core/layers/types.ts`
- Create: `src/core/provenance/types.ts`
- Create: `src/core/schema/normalize.ts`
- Modify: `src/contracts/types.ts`
- Modify: `src/contracts/extraction.ts`
- Test: `tests/unit/schema-v2.test.ts`
- Test: `tests/unit/validate.test.ts`

**Step 1: Extend the extraction contracts**

Add additive metadata only. Preserve current fields such as `file_type`, `source_file`, `source_location`, and `confidence`.

Target additions:

- `schema_version?: 1 | 2`
- `layer?: 'base' | 'semantic' | 'media'`
- `provenance?: ProvenanceRecord[]`
- structured provenance types for extractor id, source artifact, evidence kind, and confidence source

**Step 2: Add schema normalization helpers**

Implement a normalizer that upgrades legacy payloads into the new shape without forcing all producers to emit v2 metadata immediately.

Minimum behavior:
- default `schema_version` to `1` when absent
- infer `layer: 'base'` for legacy nodes/edges/hyperedges
- derive a baseline provenance record from `source_file` and `source_location` when explicit provenance is absent

**Step 3: Expand validation**

Update validation rules to:
- accept both legacy and v2 payloads
- validate allowed layer names
- validate provenance record shape
- reject malformed provenance arrays and unsupported layer values

**Step 4: Run the focused tests**

```bash
npx vitest run tests/unit/schema-v2.test.ts tests/unit/validate.test.ts
npm run typecheck
```

Expected:
- schema-v2 tests pass
- legacy validation tests still pass
- typecheck is clean

**Step 5: Commit checkpoint**

```bash
git add src/core/layers/types.ts src/core/provenance/types.ts src/core/schema/normalize.ts src/contracts/types.ts src/contracts/extraction.ts tests/unit/schema-v2.test.ts tests/unit/validate.test.ts
git commit -m "feat: add additive schema v2 and provenance contracts"
```

## Task 3: Preserve schema-v2 metadata through build, export, report, and incremental generation

> **Task 3 status update (2026-04-13):** The current verified slice now preserves top-level `schema_version` across `build()`, `graph.json` export, `loadGraph()`, and incremental `generate --update`, with regression coverage in `tests/unit/build.test.ts`, `tests/unit/schema-v2.test.ts`, `tests/unit/serve.test.ts`, and `tests/unit/generate.test.ts`. Remaining work in this task is narrower and mostly about when richer `layer` / `provenance` metadata gets emitted, not whether the top-level schema silently downgrades.

**Files:**
- Modify: `src/contracts/graph.ts`
- Modify: `src/pipeline/build.ts`
- Modify: `src/pipeline/export.ts`
- Modify: `src/pipeline/report.ts`
- Modify: `src/infrastructure/generate.ts`
- Modify: `tests/unit/build.test.ts`
- Modify: `tests/unit/export.test.ts`
- Modify: `tests/unit/pipeline.test.ts`
- Create: `tests/unit/generate.test.ts`

**Step 1: Preserve metadata during graph build**

Ensure the build path does not silently drop:
- `schema_version`
- `layer`
- `provenance`
- hyperedge-level metadata

The key rule is: Phase 1 may add metadata, but it must not erase or flatten it away.

**Step 2: Preserve metadata in JSON export and report generation**

Update export/report code so base vs overlay metadata remains round-trippable and visible where appropriate.

Minimum reporting expectation:
- report generation should remain stable even when v2 metadata is present
- report logic must not assume every edge is base-only

**Step 3: Protect `generate --update` from downgrading the schema**

`src/infrastructure/generate.ts` must preserve or rebuild v2 metadata when it reconstructs graph-backed extraction output. This is the most likely silent regression point in Phase 1.

**Step 4: Run targeted verification**

```bash
npx vitest run tests/unit/build.test.ts tests/unit/export.test.ts tests/unit/generate.test.ts tests/unit/pipeline.test.ts
npm run typecheck
npm run build
```

Expected:
- build/export/generate tests pass with legacy and v2 payloads
- build succeeds without schema regressions

**Step 5: Commit checkpoint**

```bash
git add src/contracts/graph.ts src/pipeline/build.ts src/pipeline/export.ts src/pipeline/report.ts src/infrastructure/generate.ts tests/unit/build.test.ts tests/unit/export.test.ts tests/unit/pipeline.test.ts tests/unit/generate.test.ts
git commit -m "feat: preserve schema v2 metadata through build and export"
```

## Task 4: Introduce the builtin capability registry

**Files:**
- Create: `src/plugins/contracts/capability.ts`
- Create: `src/plugins/registry/capability-registry.ts`
- Create: `src/plugins/builtin/extract-capabilities.ts`
- Create: `src/plugins/builtin/ingest-capabilities.ts`
- Modify: `src/pipeline/detect.ts`
- Test: `tests/unit/capability-registry.test.ts`
- Test: `tests/unit/detect.test.ts`

**Step 1: Define capability contracts**

Model a minimal builtin-only registry with capability descriptors that include:
- `id`
- `version`
- `kind`
- `deterministic`
- `networkAccess`
- supported source artifact kinds / URL kinds
- default output layer

**Step 2: Separate source classification from graph node file types**

Do **not** reuse graph node `file_type` as the registry matching key. Introduce or expose a distinct source-artifact classification surface from `detect.ts`.

**Step 3: Register builtin extraction and ingest capabilities**

Seed the registry with current builtin behavior only. Phase 1 is about seam creation, not external extensibility.

**Step 4: Run focused tests**

```bash
npx vitest run tests/unit/capability-registry.test.ts tests/unit/detect.test.ts
npm run typecheck
```

Expected:
- registry tests pass
- detect tests still pass with any new classification helpers

**Step 5: Commit checkpoint**

```bash
git add src/plugins/contracts/capability.ts src/plugins/registry/capability-registry.ts src/plugins/builtin/extract-capabilities.ts src/plugins/builtin/ingest-capabilities.ts src/pipeline/detect.ts tests/unit/capability-registry.test.ts tests/unit/detect.test.ts
git commit -m "feat: add builtin capability registry"
```

## Task 5: Refactor extraction dispatch into bounded modules and route it through the registry

**Files:**
- Create: `src/pipeline/extract/dispatch.ts`
- Create: `src/pipeline/extract/combine.ts`
- Create: `src/pipeline/extract/cross-file.ts`
- Modify: `src/pipeline/extract.ts`
- Modify: `src/pipeline/extract/core.ts`
- Modify: `src/pipeline/extract/non-code.ts`
- Create: `tests/unit/extract-dispatch.test.ts`
- Test: `tests/unit/extract.test.ts`
- Test: `tests/unit/pipeline.test.ts`
- Test: `tests/unit/capability-registry.test.ts`

> **Task 5 status update (2026-04-13):** Steps 1–3 are now shipped: `src/pipeline/extract/dispatch.ts` owns registry-driven single-file dispatch, `src/pipeline/extract/combine.ts` owns stable fragment aggregation plus `source_nodes` → `references` resolution, `src/pipeline/extract/cross-file.ts` owns the Python-specific cross-file linker, `src/pipeline/extract.ts` remains the stable façade, focused regression coverage includes cache behavior, missing-handler protection, source-classification-aware extension disambiguation, combine-module invariants, cross-file-linker invariants, extractor-cache invalidation for stale pre-metadata raw payloads, plus specialized image/PDF/file-only extraction metadata coverage, Python rationale node/edge metadata coverage, Markdown-paper citation/reference node plus `cites` / `contains` edge metadata coverage, DOCX citation node plus `cites` edge metadata coverage, DOCX reference-section node plus `contains` / reference-`cites` edge metadata coverage, PDF reference-section node plus `contains` / reference-`cites` edge metadata coverage, XLSX sheet node plus workbook-`contains` edge metadata coverage, and XLSX citation node plus `cites` edge metadata coverage in `tests/unit/extract-dispatch.test.ts`, `tests/unit/extract-combine.test.ts`, `tests/unit/extract-cross-file.test.ts`, and `tests/unit/extract.test.ts`, and Step 4 is now partially shipped via `src/pipeline/extract/core.ts`, where helper-created nodes and edges emit explicit base-layer/provenance metadata before normalization. Step 4 still needs broader coverage for any specialized extraction paths not yet pinned by those regressions.

**Step 1: Move file-to-extractor dispatch into `dispatch.ts`**

Extract the current single-file dispatch logic from `src/pipeline/extract.ts` and make it registry-driven.

**Step 2: Move multi-file merge logic into `combine.ts`**

This module should own safe aggregation behavior such as:
- extraction fragment merge rules
- `source_nodes` → reference edge resolution
- metadata-safe fragment combination

**Step 3: Move cross-file linking into `cross-file.ts`**

Move the Python-specific cross-file linking path first, preserving behavior exactly.

**Step 4: Make helper defaults schema-aware**

Update `src/pipeline/extract/core.ts` so node/edge creation helpers can attach default base-layer metadata and provenance consistently.

**Step 5: Keep `src/pipeline/extract.ts` as the stable façade**

The public exports should keep their current external contract even though the internals are split.

**Step 6: Run targeted verification**

```bash
npx vitest run tests/unit/extract.test.ts tests/unit/pipeline.test.ts tests/unit/capability-registry.test.ts
npm run typecheck
npm run build
```

Expected:
- extraction behavior remains stable
- dispatch is now routed through the registry
- pipeline tests remain green

**Step 7: Commit checkpoint**

```bash
git add src/pipeline/extract/dispatch.ts src/pipeline/extract/combine.ts src/pipeline/extract/cross-file.ts src/pipeline/extract.ts src/pipeline/extract/core.ts src/pipeline/extract/non-code.ts tests/unit/extract.test.ts tests/unit/pipeline.test.ts tests/unit/capability-registry.test.ts
git commit -m "refactor: split extraction dispatch and combine flows"
```

## Task 6: Route ingest through the same registry and seed provenance correctly

**Files:**
- Create: `src/infrastructure/ingest/dispatch.ts`
- Modify: `src/infrastructure/ingest.ts`
- Modify: `src/infrastructure/capabilities.ts`
- Create: `tests/unit/ingest-dispatch.test.ts`
- Modify: `tests/unit/ingest.test.ts`
- Test: `tests/unit/ingest.test.ts`
- Test: `tests/unit/capability-registry.test.ts`

> **Task 6 status update (2026-04-13):** Step 1 is now shipped: `src/infrastructure/ingest/dispatch.ts` resolves URL kinds through the builtin capability registry, `src/infrastructure/ingest.ts` retains the existing fetch/download helpers behind registry-selected handlers, and focused regression coverage now includes builtin ingest-capability resolution, dispatch fallback behavior, flat tweet/X plus arXiv frontmatter compatibility, and URL-type-specific tweet/X plus arXiv provenance selection during normalization in `tests/unit/capability-registry.test.ts`, `tests/unit/ingest-dispatch.test.ts`, `tests/unit/ingest.test.ts`, and `tests/unit/normalize.test.ts`. Step 3 is now shipped as well: flat ingest frontmatter remains backward-compatible on disk, while `src/core/schema/normalize.ts` projects it into structured ingest provenance for records that share the captured source file. The remaining work here is to extend explicit metadata emission into any specialized extraction/ingest paths that still depend on normalization-only defaults and are not yet covered by those regressions.

**Step 1: Move ingest resolution into `src/infrastructure/ingest/dispatch.ts`**

Use the builtin capability registry to resolve URL kinds to their existing handlers.

**Step 2: Keep current file output stable**

Do not change the observable behavior of:
- webpage capture
- arXiv capture
- tweet/X capture
- direct binary download for pdf/image

Phase 1 is about architecture, not richer ingestion yet.

**Step 3: Seed provenance from flat frontmatter safely**

Do **not** add nested YAML frontmatter yet. The current parser only supports flat scalars/lists. Instead:
- keep frontmatter backward-compatible
- map frontmatter values into nested provenance during extraction/normalization

**Step 4: Run targeted verification**

```bash
npx vitest run tests/unit/ingest.test.ts tests/unit/capability-registry.test.ts
npm run typecheck
```

Expected:
- ingest tests remain green
- capability registry successfully resolves ingest handlers

**Step 5: Commit checkpoint**

```bash
git add src/infrastructure/ingest/dispatch.ts src/infrastructure/ingest.ts src/plugins/builtin/ingest-capabilities.ts tests/unit/ingest.test.ts tests/unit/capability-registry.test.ts
git commit -m "refactor: route ingest through builtin capability registry"
```

## Task 7: Update docs honestly and run the full verification loop

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/current-status.md`
- Modify: `docs/plans/2026-04-12-upstream-parity-and-beyond.md`

**Step 1: Document only what actually shipped in Phase 1**

Update docs to reflect:
- builtin capability registry exists
- schema-v2 metadata is additive and backward-compatible
- layers are defined (`base`, `semantic`, `media`)
- provenance is first-class in contracts
- dynamic plugin loading and provider-backed semantic extraction are still future phases

**Step 2: Run full repository verification**

```bash
npm run typecheck
CI=1 npm run test:run
npm run build
node dist/src/cli/bin.js generate . --update
```

Expected:
- typecheck passes
- full test suite passes
- build passes
- graph artifacts refresh successfully through the TypeScript workflow only

**Step 3: Commit checkpoint**

```bash
git add README.md docs/plans/current-status.md docs/plans/2026-04-12-upstream-parity-and-beyond.md
git commit -m "docs: record phase 1 platform foundation changes"
```

## Risks and sequencing notes

### Risk 1: Source classification and graph node `file_type` get conflated

`detect.ts` classifies input artifacts, while `contracts/types.ts` describes graph node semantics. Reusing one type for both will create subtle bugs immediately.

**Mitigation:** introduce a distinct source-artifact classification surface for registry matching.

### Risk 2: `generate --update` silently strips schema-v2 metadata

Incremental generation rebuilds graph-backed extraction state. If Phase 1 only updates contracts and build/export paths, `--update` can quietly downgrade artifacts.

**Mitigation:** finish Task 3 before any registry-driven refactor lands.

### Risk 3: `src/pipeline/extract.ts` remains the god file forever

Trying to move every extractor body in Phase 1 would increase regression risk.

**Mitigation:** split only dispatch, combine, and cross-file responsibilities now; keep language-specific extractor bodies mostly where they are for this phase.

### Risk 4: nested provenance gets pushed into frontmatter too early

The current frontmatter support is intentionally lightweight.

**Mitigation:** keep capture frontmatter flat and project it into structured provenance during normalization.

### Risk 5: docs get ahead of implementation

This repository already values honest status docs.

**Mitigation:** update docs only in Task 7, after all verification is green.

## Final execution note

This plan is intentionally scoped so Phase 1 creates the **platform seam** rather than trying to ship every future feature at once. If executed cleanly, Phase 2 can begin immediately with a semantic provider layer and structured ingest adapters on top of stable contracts instead of on top of extraction spaghetti.
