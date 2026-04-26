# Language and capability matrix

This is the public support matrix for `graphify-ts` as of `v0.8.2`. It distinguishes between:

- **Primary extractor path** - the implementation used when the runtime has everything it needs
- **Fallback path** - what happens when a parser is unavailable at runtime
- **No extractor** - extensions with no registered capability yet

The registry lives in `src/infrastructure/capabilities.ts`. The extractor bindings live in `src/pipeline/extract.ts`. Tree-sitter WASM grammars are currently bundled for **Go, Java, Python, Ruby, and Rust**.

## Code extraction

| Coverage tier | Extensions | Primary path | Fallback / notes |
|---|---|---|---|
| TypeScript / JavaScript AST | `.ts` `.tsx` `.js` `.jsx` | TypeScript compiler API | Best code-structure coverage in the repo today |
| Tree-sitter primary | `.py` `.rb` | Tree-sitter WASM parser | Falls back to language-specific legacy extractor if the parser is unavailable |
| Tree-sitter primary | `.go` `.java` `.rs` | Tree-sitter WASM parser | Falls back to the generic structural extractor if the parser is unavailable |
| Generic structural extractor | `.c` `.cc` `.cpp` `.cxx` `.h` `.hpp` `.kt` `.kts` `.cs` `.scala` `.php` `.swift` `.zig` | Generic extractor | Heuristic structure, import, inheritance, and call extraction |
| Lightweight language-specific scanners | `.lua` `.ex` `.exs` `.jl` `.ps1` `.m` `.mm` `.toc` | Purpose-built scanners | Useful coverage, but less semantic depth than AST-backed paths |
| Unsupported | everything else | none | No extractor capability is registered, so the file is skipped |

## Documents and binary assets

| Coverage tier | Extensions | Primary path | Notes |
|---|---|---|---|
| Structured text | `.md` | Heading/link/citation extractor | Routed as `document` or `paper` depending on file classification |
| Structured text | `.txt` `.rst` | Heading/link/citation extractor | Routed as `document` or `paper` depending on file classification |
| Paper extractor | `.pdf` | PDF text + section/citation extractor | Best-effort extraction from local PDF content |
| OOXML document extractor | `.docx` | DOCX text + metadata extractor | Parses `word/document.xml` and core metadata safely |
| OOXML spreadsheet extractor | `.xlsx` | XLSX sheet-name + shared-string extractor | Captures workbook structure plus text cells |
| Metadata-only binary assets | `.gif` `.jpeg` `.jpg` `.png` `.svg` `.webp` | Image metadata node | No OCR; graph stores asset metadata only |
| Metadata-only binary assets | `.aac` `.flac` `.m4a` `.mp3` `.ogg` `.opus` `.wav` | Audio metadata node | No speech-to-text transcription |
| Metadata-only binary assets | `.avi` `.m4v` `.mkv` `.mov` `.mp4` `.webm` | Video metadata node | No video transcript or frame analysis |

## URL ingest

`graphify-ts add <url>` has built-in ingestors for:

- GitHub
- Reddit
- Hacker News
- X/Twitter
- arXiv
- YouTube
- direct PDF/image/audio/video URLs
- generic webpages

These ingestors fetch structured content into the local project so the normal graph build can include it. They are separate from local file extractors.

## How to read this matrix

- **Supported** means `graphify-ts` has a registered capability and a live handler for that extension or URL type.
- **Tree-sitter primary** means the runtime prefers a WASM grammar, then logs a one-time warning and falls back locally if that grammar is unavailable.
- **Generic** means the extractor is intentionally heuristic. It is useful for structure discovery, but it is not the same depth as the TypeScript AST path.
- **Metadata-only** means the graph will know the asset exists and keep file metadata, but it will not derive OCR, captions, or transcripts.

If you need exact command-level proof for the benchmark, eval, compare, and federation surfaces, see [proof-workflows.md](./proof-workflows.md).
