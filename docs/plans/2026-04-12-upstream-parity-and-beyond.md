# graphify-ts Upstream Parity and Beyond Roadmap

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `graphify-ts` surpass upstream `graphify` in multimodal coverage, semantic graph quality, AST-backed language breadth, and operational maturity without losing the project’s strongest advantages: local-first execution, deterministic base extraction, and a Node/TypeScript-native runtime.

**Architecture:** Evolve the current system into a layered platform. Keep a canonical deterministic base graph built from parsers and rules, then add optional semantic and media overlays through typed plugins with first-class provenance, caching, and evaluation. Expand AST-backed extractors by language family, enrich the graph schema for rationale/similarity/hyperedges, and harden runtime, benchmarks, and release workflows so new power remains trustworthy.

**Tech Stack:** Node.js, TypeScript, TypeScript compiler API, `web-tree-sitter`, `@vscode/tree-sitter-wasm`, optional AI/transcription/OCR provider adapters, Vitest, MCP stdio + HTTP runtime, Neo4j export.

---

## Why this roadmap exists

`graphify-ts` already has several strengths that should not be traded away lightly:

- a no-Python, npm-native installation path
- a local-first deterministic extraction core
- a practical HTTP + stdio/MCP runtime
- graph diffing, anomaly reporting, freshness metadata, and subscriptions
- fixture-backed tests owned by this repository
- honest status documentation about implemented vs lighter-weight features

At the same time, the current repository docs and graph artifacts make the biggest gaps clear:

- semantic and AI-assisted extraction is still light in real outputs
- multimodal ingestion is narrower than the upstream reference project
- several languages still rely on heuristic extraction instead of AST-backed extraction
- graph semantics are stronger on runtime analysis than on concept-level enrichment
- the extraction layer is the most likely place to become a monolith if new capability lands without stronger boundaries

This roadmap exists to close those gaps and then push beyond simple parity.

## Definition of “better than upstream”

For this roadmap, “better” does **not** mean cloning every upstream feature one-for-one. It means that `graphify-ts` should become the strongest option for teams who want:

- a trustworthy **deterministic base graph**
- optional **semantic overlays** instead of hidden magic
- excellent **Node-native integration** for local developer workflows
- a richer **multimodal graph** with clear provenance
- measurable **evaluation and regression gates** instead of hand-wavy quality claims

If `graphify-ts` matches upstream on high-value capabilities while staying easier to install, easier to extend, and more explicit about provenance, it wins on more than just feature count.

## Gap summary

| Gap area | Current state | Target state |
|---|---|---|
| Multimodal AI-assisted extraction | Mostly deterministic extraction with limited semantic overlay in real outputs | Optional provider-backed semantic enrichment with caching, confidence, and provenance |
| Video/audio/YouTube/social ingestion | URL classification exists, but some source types still fall back to generic webpage capture | First-class adapters for media, YouTube, GitHub, and social sources with structured metadata and segment-level evidence |
| Deeper semantic graph features | Strong runtime analysis (`diff`, anomalies, freshness) but lighter concept-level enrichment | Semantic similarity, rationale expansion, entity resolution, canonical aliases, and real hyperedge usage |
| Broader AST-backed language coverage | Strong JS/TS support and a subset of AST-backed languages; several languages remain heuristic | AST-backed extraction for the highest-value heuristic languages, with family-based rollout and fallback honesty |
| Reference implementation maturity | Good docs, tests, and runtime surfaces, but no parity scorecard or hard quality gates | Evaluation harness, benchmark corpora, release gates, schema evolution policy, and plugin/platform hardening |

## Strengths to preserve

Every phase below should preserve these strengths:

1. **Deterministic first:** `graphify-ts` must still work with no network and no model provider configured.
2. **Local-first artifacts:** `graph.json`, `GRAPH_REPORT.md`, HTML, and wiki outputs stay local, diffable, and inspectable.
3. **Explicit provenance:** every inferred or generated edge must say where it came from.
4. **Progressive enhancement:** multimodal/semantic layers enhance the base graph; they do not replace it.
5. **Fixture-backed development:** new extractors and graph features land with realistic corpus fixtures and golden expectations.

## Guiding principles

### 1. Deterministic core, probabilistic overlays

The canonical graph should remain parser- and rule-derived. Semantic similarity, OCR/transcription guesses, AI summaries, and inferred concept links should land in explicit overlay layers that users can enable, inspect, and disable.

### 2. Provenance first

No node, edge, or hyperedge should exist without an evidence trail. Provenance needs to record extractor/plugin id, source artifact hash, span/page/time offsets, derivation chain, and confidence.

### 3. Plugins over conditionals

Do not grow one giant extraction file with more branching. Add capability through typed plugins for detection, extraction, linking, enrichment, export, and runtime extensions.

### 4. Expand by families, not one-offs

Language and modality growth should follow shared family abstractions (TypeScript compiler API, tree-sitter-backed AST family, heuristic fallback family, media family, semantic family) so new support compounds rather than fragments.

### 5. Evaluation before victory laps

Claims about parity or superiority should be tied to measurable benchmarks: coverage, retrieval quality, semantic precision, runtime compatibility, and artifact stability.

### 6. Documentation must stay honest

Status docs, README claims, and command help must reflect what actually ships. Roadmap items stay aspirational until they are tested and documented as implemented.

## Phase roadmap

### Phase 1 — Platform foundation and schema hardening

**Objective:** Create the architectural seams needed to add major capability without making the extraction layer harder to reason about.

**Progress update (2026-04-13):** The first Phase 1 implementation slices are now shipped: additive schema-v2 validation (`schema_version`, `layer`, `provenance`), a builtin capability-registry foundation with normalized extension resolution plus source-classification-aware disambiguation, immutable legacy-payload normalization inside the graph-build path, registry-driven single-file extraction dispatch, registry-driven ingest dispatch keyed by URL type, explicit top-level `schema_version` preservation through JSON export, graph reload, and incremental `generate --update` rebuilds, helper-created raw extraction output that now emits explicit base-layer/provenance metadata before normalization, and normalization-time projection of flat ingest frontmatter into structured ingest provenance while keeping captured files backward-compatible. The remaining work in this phase is to extend that richer metadata emission to the remaining specialized extraction/ingest paths.

**Primary outcomes:**
- plugin/capability registry
- schema v2 layering plan
- provenance model for base vs semantic vs media artifacts
- extraction pipeline decomposition by bounded responsibility

**Why first:** The graph report already flags the extraction layer as the least cohesive area. This phase prevents “roadmap success” from turning into “maintenance disaster.”

**Exit criteria:**
- extraction and ingestion are routed through a documented capability registry
- provenance is modeled consistently across nodes, edges, and hyperedges
- the base graph and overlay graph concepts are defined in contracts and artifact docs

### Phase 2 — Semantic extraction runtime and web ingestion parity

**Objective:** Turn semantic enrichment from mostly planned/scaffolded behavior into a real, optional runtime with cache, budget, and provider boundaries.

**Progress update (2026-04-14):** The first structured-ingest slices are now shipped for GitHub URLs including exact `/commit/<sha>` pages, generic article-style webpages, single-post tweet/X URLs plus exact `/photo/<n>` and `/video/<n>` media aliases, exact Reddit thread-root URLs, exact Reddit short-thread URLs, exact Reddit comment-permalink URLs, exact Hacker News `item?id=` URLs, direct single-video YouTube URLs across exact `watch`, `youtu.be`, `shorts`, `embed`, and `live` routes, exact YouTube playlist URLs across `/playlist?list=<id>` routes, and exact root YouTube channel URLs across `@handle`, `/channel/<id>`, and `/c/<slug>` routes: repository, issue, pull request, discussion, and exact commit pages no longer fall back to generic webpage capture; article-style pages can now land as deterministic markdown/frontmatter with canonical URL normalization plus author/description lift, section headings, inline markdown links, and outbound-link lists; tweet/X posts now carry explicit metadata/fallback context and canonicalize media-suffixed aliases back to the base post URL; Reddit thread roots and short-thread aliases now carry canonical thread URLs, post text, top-comment highlights, and explicit JSON-fallback context; Reddit comment permalinks now carry canonical comment URLs, targeted comment text, parent-thread context, and explicit JSON-fallback context; Hacker News item routes now carry canonical discussion URLs, top discussion highlights, and explicit API-fallback context; direct YouTube video URLs now carry canonical watch URLs, derived video IDs, oEmbed metadata when available, explicit fallback context, optional canonical-watch publish/duration metadata, optional transcript-availability plus caption-language hints when canonical watch HTML exposes caption tracks, optional timestamped transcript cue context from one prioritized confirmed caption track with manual-over-ASR preference in the primary language plus fallback across remaining confirmed tracks, start-end ranges when timedtext exposes cue durations and start-only fallback otherwise, and optional chapter context when the canonical watch page exposes real chapter markers; exact YouTube playlist URLs now carry canonical playlist URLs, derived playlist IDs, HTML metadata when available, and explicit fallback context; and exact root YouTube channel URLs now carry canonical channel URLs, derived handles/channel IDs/custom slugs, HTML metadata when available, and explicit fallback context. Broader social/thread handling and broader local-media evidence beyond the shipped YouTube transcript/time-range/chapter enrichments remain open.

**Primary outcomes:**
- provider-neutral semantic extraction interface
- cached semantic overlays with token/cost accounting
- richer webpage/article ingestion
- structured GitHub/social capture instead of generic webpage fallbacks

**Exit criteria:**
- semantic runs produce non-zero inferred/ambiguous outputs on benchmark corpora
- web and social ingest preserve canonical metadata and structured sections
- reports/runtime surfaces clearly separate extracted vs inferred evidence

### Phase 3 — Multimodal ingestion and media-aware graph modeling

**Objective:** Ship first-class ingestion for audio, video, and YouTube-like sources with segment-level provenance.

**Primary outcomes:**
- audio/video transcript pipeline
- media metadata and segmentation model
- time-range evidence in `query`, `path`, `explain`, and HTML/runtime outputs

**Exit criteria:**
- local audio/video files can become graph-backed transcript segments
- YouTube/video URL ingestion captures metadata plus transcript/chapter context when available
- graph artifacts can cite media-backed evidence precisely instead of as generic file blobs

### Phase 4 — Deeper graph semantics and concept stitching

**Objective:** Make the graph smarter at concept-level reasoning, not just better at file-level structure.

**Primary outcomes:**
- semantic similarity edges
- rationale expansion across code/docs/media
- alias/canonical entity resolution
- real hyperedge-driven grouping and stitching

**Exit criteria:**
- concept-level links are queryable and inspectable with provenance
- hyperedges are first-class in authoring and useful in runtime behavior
- related concepts across code, docs, papers, and media can be unified without losing source evidence

### Phase 5 — AST-backed language expansion

**Objective:** Promote the highest-value heuristic languages to AST-backed extraction in priority order.

**Primary outcomes:**
- a normalized extraction IR
- family-based tree-sitter expansion
- stronger cross-file linking for newly promoted languages

**Exit criteria:**
- at least five currently heuristic languages move to AST-backed extraction
- each has fixture-backed tests for types, methods, ownership, imports, inheritance/conformance, and common call relations
- docs explicitly state which languages are AST-backed vs heuristic fallback

### Phase 6 — Maturity, evaluation, and beat-upstream differentiation

**Objective:** Make “better than upstream” measurable and durable.

**Primary outcomes:**
- parity scorecard and benchmark corpora
- schema compatibility policy
- stronger CI/release gates
- runtime polish around layers, overlays, and subscriptions
- contributor-facing extension docs for plugins/providers

**Exit criteria:**
- the repo can demonstrate parity or superiority on curated corpora instead of anecdote
- new features ship with evaluation artifacts, docs, and compatibility notes
- `graphify-ts` is clearly differentiated on trust, runtime ergonomics, and extensibility

## Detailed workstreams

### Workstream 1: Plugin and capability registry

**Outcome:** A typed extension model for detectors, extractors, linkers, enrichers, exporters, and runtime extensions.

**Why now:** Every missing feature area depends on this. It is the difference between a platform and a file full of heroic conditionals.

**Likely work areas:**
- Create: `src/plugins/contracts/`, `src/plugins/registry/`, `src/plugins/execution/`, `src/plugins/builtin/`
- Modify: `src/pipeline/extract.ts`, `src/pipeline/detect.ts`, `src/infrastructure/ingest.ts`
- Document: `docs/plans/current-status.md`, `README.md`

**Acceptance criteria:**
- plugin categories are explicit and versioned
- plugins declare deterministic/networked behavior and supported artifact kinds
- the extraction pipeline can register and execute capabilities without hard-coded branching for every new source type

### Workstream 2: Graph schema v2 with layers and provenance

**Outcome:** A graph model that can safely represent base structure, semantic overlays, media segments, aliases, and hyperedges.

**Why now:** Richer inputs are only useful if the schema can express them without turning `graph.json` into an ambiguous blob.

**Likely work areas:**
- Modify: `src/contracts/types.ts`, `src/contracts/extraction.ts`, `src/contracts/graph.ts`
- Create: `src/core/provenance/`, `src/core/layers/`, `src/core/schema/`
- Modify: exporters under `src/pipeline/export.ts`, report generation under `src/pipeline/report.ts`

**Acceptance criteria:**
- nodes/edges/hyperedges support provenance, confidence, and layer metadata consistently
- compatibility strategy is defined for existing graph consumers
- reports and runtime surfaces can present base vs inferred evidence clearly

### Workstream 3: Semantic extraction provider layer

**Outcome:** Optional, provider-neutral AI-assisted enrichment with budget and cache controls.

**Why now:** The current system already hints at semantic workflows, but outputs remain overwhelmingly deterministic.

**Likely work areas:**
- Create: `src/providers/contracts/`, `src/providers/cache/`, `src/providers/semantic/`
- Modify: `src/pipeline/extract.ts`, `src/infrastructure/install-skill-templates.ts`, `src/infrastructure/benchmark.ts`
- Create tests: `tests/unit/semantic-extraction.test.ts`, fixtures under `tests/fixtures/semantic/`

**Acceptance criteria:**
- semantic extraction is opt-in and can be disabled cleanly
- inferred/ambiguous edges are emitted with provenance and confidence
- token/cost accounting appears in artifacts and benchmark outputs when semantic providers are active

### Workstream 4: Structured web, GitHub, and social ingestion

**Outcome:** Source-specific ingestion for webpages, GitHub objects, and social/tweet-like content.

**Why now:** URL detection already exists, but some important source types still degrade to generic webpage capture.

**Progress update (2026-04-14):** `src/infrastructure/ingest-github.ts`, `src/infrastructure/ingest-web.ts`, `src/infrastructure/ingest-social.ts`, `src/infrastructure/ingest-reddit.ts`, `src/infrastructure/ingest-hackernews.ts`, and `src/infrastructure/ingest-youtube.ts` now cover the first GitHub-specific slice, richer generic article-style webpage capture, a first structured single-post tweet/X slice with canonicalized source URLs, derived handle/post metadata, exact `/photo/<n>` and `/video/<n>` media-alias coverage, explicit capture-status context, and deterministic oEmbed fallback behavior, a first structured Reddit thread/comment slice with canonical thread/comment URLs, targeted post/comment context, stable route-specific filenames, exact short-thread alias coverage, and explicit JSON fallback behavior, a first structured Hacker News item slice with canonical discussion URLs, top discussion highlights, and explicit API fallback behavior, a first structured GitHub commit slice with canonical commit URLs, commit SHA/message extraction, and explicit fallback when the fetched HTML does not confirm a real commit page, and a broader structured YouTube slice with canonical watch/playlist/channel URLs, derived video IDs, playlist IDs, or channel handles/channel IDs/custom slugs, exact `watch`/`youtu.be`/`shorts`/`embed`/`live` single-video route coverage, optional canonical-watch publish/duration metadata, optional transcript-availability plus caption-language hints on successful video captures when canonical watch HTML exposes caption tracks, optional timestamped transcript cue context from one prioritized confirmed caption track with manual-over-ASR preference in the primary language plus fallback across remaining confirmed tracks, start-end ranges when timedtext exposes cue durations and start-only fallback otherwise, optional canonical-watch chapter context on successful video captures when real chapter markers are present, exact `/playlist?list=<id>` playlist coverage, exact root `@handle`, exact `/channel/<id>`, and exact `/c/<slug>` channel coverage, and explicit oEmbed/HTML fallback context. The remaining gap in this workstream is deeper social/thread handling beyond the now-supported first tweet/X, Reddit, and Hacker News routes, plus deeper YouTube/media evidence beyond URL-level video, playlist, and channel metadata.

**Likely work areas:**
- Modify: `src/infrastructure/ingest.ts`
- Create: `src/infrastructure/ingest-web.ts`, `src/infrastructure/ingest-github.ts`, `src/infrastructure/ingest-social.ts`, `src/infrastructure/ingest-reddit.ts`, `src/infrastructure/ingest-youtube.ts`
- Update tests: `tests/unit/ingest.test.ts`, new fixtures under `tests/fixtures/ingest/`

**Acceptance criteria:**
- GitHub URLs ingest structured repo/issue/PR/discussion metadata plus exact `/commit/<sha>` commit metadata
- social/tweet-like ingestion captures author, timestamp, text/thread context, and fallback behavior explicitly
- Reddit thread, short-thread, and exact comment-permalink URLs ingest structured post/comment metadata plus fallback behavior explicitly
- Hacker News `item?id=` URLs ingest structured item/discussion metadata plus fallback behavior explicitly
- YouTube ingestion captures canonical video, playlist, or root channel URLs, title metadata, derived IDs, handles, or custom-channel slugs, explicit fallback behavior across exact single-video `watch`, `youtu.be`, `shorts`, `embed`, and `live` routes plus exact `/playlist?list=<id>` and root channel routes across `@handle`, `/channel/<id>`, and `/c/<slug>`, plus optional publish/duration metadata, optional transcript-availability plus caption-language hints, optional timestamped transcript cue context from one prioritized confirmed caption track with manual-over-ASR preference in the primary language plus fallback across remaining confirmed tracks, start-end ranges when timedtext exposes cue durations and start-only fallback otherwise, and optional chapter context for successful single-video captures when canonical watch HTML exposes them
- webpages preserve canonical URL, title, author, section structure, and outbound references where available

### Workstream 5: Audio, video, and YouTube ingestion

**Outcome:** First-class media acquisition, normalization, transcription, and segmentation.

**Why now:** This is one of the clearest upstream gaps and one of the most valuable multimodal differentiators.

**Progress update (2026-04-15):** `src/pipeline/detect.ts`, `src/pipeline/extract/non-code.ts`, `src/infrastructure/generate.ts`, `src/infrastructure/watch.ts`, `src/pipeline/analyze.ts`, `src/infrastructure/ingest.ts`, `src/infrastructure/ingest/url-type.ts`, `src/infrastructure/capabilities.ts`, `src/shared/security.ts`, `src/shared/binary-ingest-sidecar.ts`, and `src/core/provenance/ingest.ts` now treat common local audio/video extensions as first-class extractable file types, let direct binary audio/video URLs download into that same sidecar-backed path, and let webpage-shaped or redirected asset URLs fall back into the binary ingest path when the final URL or response content type confirms PDF/image/audio/video content. Local or directly ingested media files plus saved PDF captures now land as base-layer `audio` / `video` / `paper` file nodes with hidden sidecar `source_url` / `captured_at` / `contributor` metadata plus explicit binary ingest-kind hints for extensionless assets, lift deterministic extension-derived `content_type` plus saved-asset `file_bytes` metadata, add lightweight `media_duration_seconds` metadata for WAV plus common MP4-family assets with recognizable top-level container headers, add WAV `audio_sample_rate_hz` / `audio_channel_count` metadata when the declared WAV data chunk is actually present, add common MP3 ID3 `audio_title` / `audio_artist` / `audio_album` metadata, add deterministic FLAC STREAMINFO/Vorbis-comment and Ogg Vorbis/Opus identification/comment/granule metadata for `media_duration_seconds`, `audio_sample_rate_hz`, `audio_channel_count`, `audio_title`, `audio_artist`, and `audio_album`, carry final-asset `source_url` metadata when binary redirects resolve to a more canonical asset URL, keep fallback HTML canonical URLs resolved against the final response URL, participate in `generate --update`, watch-mode rebuilds, and report categorization, and stay intentionally scoped to deterministic file-node support without transcription or segment nodes yet.

**Likely work areas:**
- Create: `src/media/acquire/`, `src/media/normalize/`, `src/media/transcribe/`, `src/media/segment/`, `src/media/emit/`
- Modify: `src/infrastructure/ingest.ts`, `src/pipeline/detect.ts`, `src/pipeline/extract/non-code.ts`
- Add tests/fixtures: `tests/unit/media-ingest.test.ts`, `tests/fixtures/media/`

**Acceptance criteria:**
- local audio/video files can be ingested into transcript segment nodes with time ranges
- YouTube/video URLs capture structured metadata and transcript/chapter evidence when available
- runtime and HTML outputs can cite time-based media evidence

### Workstream 6: Rationale, semantic similarity, entity resolution, and hyperedges

**Outcome:** A graph that can connect meaning across modalities instead of only mirroring structure.

**Why now:** `graphify-ts` is already strong on diff/anomaly/runtime analysis; this work closes the semantic depth gap.

**Likely work areas:**
- Create: `src/pipeline/semantic-linking.ts`, `src/pipeline/entity-resolution.ts`, `src/pipeline/hyperedges.ts`
- Modify: `src/pipeline/analyze.ts`, `src/pipeline/report.ts`, `src/runtime/serve.ts`, `src/runtime/stdio-server.ts`
- Add fixtures/tests: `tests/unit/semantic-linking.test.ts`, `tests/unit/entity-resolution.test.ts`

**Acceptance criteria:**
- graph relations such as semantic similarity, rationale, aliases, and grouped relationships are modeled and queryable
- hyperedges are first-class in graph authoring and meaningfully surfaced in runtime outputs
- entity resolution can unify the same concept across code, docs, papers, and media while preserving provenance

### Workstream 7: AST-backed language expansion by family

**Outcome:** A larger, clearly prioritized set of AST-backed languages with shared IR and fallback honesty.

**Why now:** The strongest structural extraction story still belongs to the AST-backed slice. Expanding that slice is essential for parity and quality.

**Priority promotion order:**
1. Rust
2. C#
3. Kotlin
4. PHP
5. Swift

**Likely work areas:**
- Create: `src/extractors/ir/`, `src/extractors/languages/tree-sitter/`, `src/extractors/linkers/`
- Modify: `src/pipeline/tree-sitter-wasm.ts`, `src/pipeline/extract/core.ts`, `src/pipeline/extract.ts`
- Add fixtures/tests: language-specific fixture corpora in `tests/fixtures/` and unit coverage in `tests/unit/`

**Acceptance criteria:**
- each promoted language has AST-backed ownership, imports, types, methods, inheritance/conformance, and common call-graph coverage
- heuristic fallbacks remain available and honestly labeled where AST parity is not yet shipped
- docs clearly show language support tiers

### Workstream 8: Runtime and UI excellence for layered graphs

**Outcome:** The existing runtime advantage becomes even stronger as graph complexity grows.

**Why now:** `graphify-ts` already wins in runtime ergonomics. That lead should widen, not get diluted.

**Likely work areas:**
- Modify: `src/runtime/serve.ts`, `src/runtime/http-server.ts`, `src/runtime/stdio-server.ts`, `src/runtime/freshness.ts`
- Modify: `src/pipeline/export.ts`, `src/pipeline/report.ts`
- Add tests: `tests/unit/http-server.test.ts`, `tests/unit/stdio-server.test.ts`, `tests/unit/serve-queries.test.ts`

**Acceptance criteria:**
- runtime requests can target `base`, `semantic`, or combined views explicitly
- diff/anomaly/freshness/subscription behavior works for layered artifacts
- HTML export can show overlay provenance and media-backed evidence without losing large-graph performance

### Workstream 9: Evaluation, parity scorecards, and regression corpora

**Outcome:** A measurable way to prove improvement instead of asserting it.

**Why now:** Surpassing upstream should be testable, not rhetorical.

**Likely work areas:**
- Create: `src/eval/`, `benchmarks/corpora/`, `benchmarks/goldens/`
- Modify: `src/infrastructure/benchmark.ts`, `src/cli/parser.ts`, `src/cli/main.ts`
- Create tests/workflows: CI jobs under `.github/workflows/`

**Acceptance criteria:**
- curated corpora exist for code-only, mixed-doc, media-heavy, and multimodal scenarios
- benchmark outputs cover extraction quality, retrieval quality, and graph richness in addition to token reduction
- parity scorecard is maintained in docs and updated as milestones ship

### Workstream 10: Release hardening and contributor ecosystem

**Outcome:** New capability lands safely and remains maintainable.

**Why now:** A platform without compatibility and release discipline tends to become folklore with a package name.

**Likely work areas:**
- Modify: `.github/workflows/*`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/maintainers/releases.md`
- Create: plugin authoring docs under `docs/`
- Add compatibility tests and upgrade notes for schema/runtime evolution

**Acceptance criteria:**
- schema compatibility and deprecation policy are documented
- contributor docs explain how to add plugins, fixtures, and evaluation cases
- release workflows gate on benchmark and compatibility checks for roadmap-critical surfaces

## Differentiators to build beyond parity

These are the areas where `graphify-ts` can do more than catch up:

1. **Layered graphs with deterministic base + semantic overlays**
   - better trust model than “everything is equally magical”
2. **First-class provenance and replayability**
   - every inferred result can be traced to inputs, provider, and derivation path
3. **Type-safe plugin ecosystem in Node/TypeScript**
   - long-term extensibility with contributor-friendly contracts
4. **Runtime excellence for agent workflows**
   - layered MCP/HTTP runtime, diff, anomalies, freshness, subscriptions, and graph-aware prompts
5. **Evaluation-backed quality claims**
   - parity/superiority is shown through corpora and scorecards, not just README adjectives

## Suggested sequencing notes

- **Must happen first:** Workstream 1 and Workstream 2
- **Can begin in parallel after foundation:** Workstream 4, Workstream 5, and Workstream 7
- **Should follow semantic/media foundations:** Workstream 6 and Workstream 8
- **Should run throughout but become a gate near release:** Workstream 9 and Workstream 10

If resources are limited, the best “highest leverage first” path is:
1. plugin/capability registry
2. schema v2 with provenance/layers
3. semantic provider layer
4. structured web/GitHub/social ingest
5. audio/video/YouTube ingest
6. AST expansion for Rust/C#/Kotlin

## Success criteria for the roadmap as a whole

This roadmap is complete when `graphify-ts` can credibly say all of the following:

- it supports a trustworthy deterministic graph with optional semantic overlays
- it ingests code, docs, papers, office files, images, and media with source-appropriate structure
- it provides first-class media-backed and concept-backed evidence in queries/runtime outputs
- it has promoted the most valuable heuristic languages to AST-backed extraction
- it ships parity scorecards and regression corpora for the features it claims
- it remains easier to install, easier to extend, and easier to trust than the upstream reference project

## Immediate next execution plan

The detailed implementation plan for the first execution slice now lives in [`2026-04-12-phase-1-platform-foundation-and-schema-hardening-implementation.md`](./2026-04-12-phase-1-platform-foundation-and-schema-hardening-implementation.md).

When implementation begins, the first execution plan should cover these concrete slices in order:

1. **Plugin/capability registry**
2. **Schema v2 + provenance**
3. **Semantic provider abstraction**
4. **Structured ingestion adapters**
5. **Media pipeline spike**
6. **First AST promotion wave**
7. **Evaluation harness bootstrap**

That turns the roadmap from ambition into a shippable sequence.
