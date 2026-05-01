# 2026-05-02 — GoValidate PR review benchmark

This directory contains the raw evidence for graphify-ts's real PR-review benchmark on the GoValidate Platform codebase. The numbers below come directly from the committed `report.json` produced by `review-compare`.

## Setup

- **Codebase under test:** `govalidate/platform`, a real production repo at `/Users/mohammednaji/Desktop/projects/works/govalidate/platform`.
- **Compared base branch:** `origin/main`.
- **What `review-compare` measures:** the same live branch diff is converted into two `pr_impact` prompts:
  1. **verbose** — expanded PR-impact context
  2. **compact** — condensed PR-impact context
- **Runner:** `cat {prompt_file} | claude -p`
- **Committed artifact source:** `platform/graphify-out/review-compare/2026-05-01T23-23-54/`

## Headline numbers (copied from `report.json`)

| Metric | Verbose | Compact | Δ |
|---|---:|---:|---:|
| Prompt tokens | 63,310 | **8,740** | 7.244× smaller |
| Payload tokens | 42,255 | **6,143** | 6.879× smaller |
| Changed files in diff | 36 | 36 | same |
| Seed count | 143 | 143 | same |
| Hotspot count | 3 | 3 | same |
| Runner status | succeeded | succeeded | same |

This benchmark captures a real branch diff in `govalidate/platform` and shows the prompt-size reduction from compact `pr_impact` packaging without changing the underlying review target.

## Output files in this directory

- `report.json` — raw `review-compare` metrics and run metadata
- `verbose-prompt.txt` — verbose `pr_impact` prompt sent to the runner
- `compact-prompt.txt` — compact `pr_impact` prompt sent to the runner
- `verbose-answer.txt` — runner output for the verbose prompt
- `compact-answer.txt` — runner output for the compact prompt
- `verify.sh` — prints the headline numbers from the committed `report.json`

## Reproducing the headline numbers from this directory

```bash
bash docs/benchmarks/2026-05-02-govalidate-pr-review/verify.sh
```

Output:

```text
verbose_prompt_tokens   : 63310
compact_prompt_tokens   : 8740
prompt_reduction_ratio  : 7.244x
verbose_payload_tokens  : 42255
compact_payload_tokens  : 6143
payload_reduction_ratio : 6.879x
changed_files           : 36
seed_count              : 143
hotspot_count           : 3
```

## Reproducing end-to-end in the benchmark repo

```bash
cd /Users/mohammednaji/Desktop/projects/works/govalidate/platform
node /Users/mohammednaji/Desktop/projects/graphify-ts/.worktrees/proof-distribution/dist/src/cli/bin.js generate . --no-html

node /Users/mohammednaji/Desktop/projects/graphify-ts/.worktrees/proof-distribution/dist/src/cli/bin.js review-compare graphify-out/graph.json \
  --base-branch origin/main \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

The fresh run writes a new timestamped directory under `platform/graphify-out/review-compare/` with the same file set committed here.
