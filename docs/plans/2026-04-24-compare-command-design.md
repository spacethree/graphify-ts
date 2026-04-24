# Compare Command Design

## Goal

Add a new `graphify-ts compare` command that creates a credible side-by-side proof of how a question is asked **with graphify** versus **without graphify**.

The command is intended as a **showcase and proof tool**. It may be used only occasionally, but when it is used it should create evidence that is easy to inspect, save, and share.

## Problem

Today `benchmark` and `eval` prove useful things:

- `benchmark` shows context-size reduction
- `eval` shows retrieval quality

But they do **not** run the same question through a real LLM twice and capture the actual prompt payloads and answers. Users who want a stronger proof want to see:

1. the naive prompt
2. the graphified prompt
3. the answer from each run
4. the measured token size difference between the two prompt packs

Without API keys and provider usage access, graphify-ts cannot claim true billed-token accounting. It can, however, run real prompt executions through terminal-callable LLM tools and save the exact prompt payloads used for those runs.

## Scope

This feature should:

- generate a **baseline** prompt pack for a question
- generate a **graphify** prompt pack for the same question
- estimate token size for the exact prompt text sent in each case
- execute both prompts through a user-provided terminal command
- save prompts, answers, and a structured report
- warn users before spending tokens

This feature should **not** initially include:

- provider billing integration
- answer quality scoring
- judge-model evaluation
- provider-specific SDK integrations
- a large plugin framework

## Command Shape

Primary form:

```bash
graphify-ts compare "<question>" \
  --graph graphify-out/graph.json \
  --exec 'claude -p "$(cat {prompt_file})"' \
  --yes
```

Batch form:

```bash
graphify-ts compare \
  --graph graphify-out/graph.json \
  --questions benchmark-questions.json \
  --exec 'gemini -p "$(cat {prompt_file})"'
```

Supported flags:

- `--graph <path>`: path to `graph.json`
- `--exec <template>`: terminal command template used to run each prompt
- `--questions <path>`: optional question file for batch comparison
- `--output-dir <path>`: custom output directory
- `--baseline-mode full|bounded`: choose naive baseline mode
- `--yes`: skip confirmation prompt
- `--limit <n>`: cap batch size

## Execution Model

The command should be **runner-driven**, not backend-hardcoded.

Instead of shipping a fixed list of providers, graphify-ts should accept a user-supplied execution template. That keeps the feature compatible with any terminal-callable LLM tool the user already trusts.

Example templates:

```bash
--exec 'claude -p "$(cat {prompt_file})"'
--exec 'gemini -p "$(cat {prompt_file})"'
--exec 'my-llm --input-file {prompt_file}'
```

Template placeholders:

- `{prompt_file}`: path to the generated prompt
- `{question}`: raw question text
- `{mode}`: `baseline` or `graphify`
- `{output_file}`: target path for captured output

The command should expand placeholders and run the resulting command in a controlled subprocess.

## Data Flow

For each question:

1. load the graph
2. build baseline context
3. build graphify context from the existing retrieval path
4. construct full prompt text for each side
5. estimate tokens for each exact prompt payload
6. print a cost warning
7. require confirmation unless `--yes` is set
8. execute baseline prompt
9. execute graphify prompt
10. save prompts, answers, timing, and metadata
11. print a short terminal summary

Batch mode repeats this per question and also writes an aggregate summary.

## Baseline and Graphify Packs

### Baseline pack

The baseline pack should represent the naive “without graphify” path. For v1 this should be deterministic and easy to explain. Two modes are enough:

- `full`: use the full detected corpus export
- `bounded`: use a bounded naive export if the corpus is very large

### Graphify pack

The graphify pack should come from the same graph-guided retrieval logic already used by the tool, so the comparison reflects real graphify behavior instead of a second retrieval algorithm invented just for the compare command.

## Output Artifacts

Default output location:

```text
graphify-out/compare/
  2026-04-24T19-30-00/
    report.json
    baseline-prompt.txt
    graphify-prompt.txt
    baseline-answer.txt
    graphify-answer.txt
```

Batch mode should create one folder per question plus a top-level summary file.

`report.json` should include:

- question
- graph path
- execution template
- baseline token count
- graphify token count
- reduction ratio
- start/end timestamps
- elapsed time for each side
- success/failure status
- output file paths

## Terminal UX

The command is a showcase tool, so the terminal output should be short and presentation-friendly.

Suggested flow:

1. show preflight summary
2. warn that two paid requests may be made
3. ask for confirmation unless `--yes` is present
4. print short run progress
5. print final summary with file paths

Example summary:

```text
graphify compare
──────────────────────────────────────────────────
Question: how does login create a session
Baseline prompt: 9,420 tokens
Graphify prompt: 1,830 tokens
Reduction: 5.1x fewer prompt tokens
Baseline run: success (8.2s)
Graphify run: success (4.1s)
Artifacts: graphify-out/compare/2026-04-24T19-30-00/
```

## Safety and Failure Handling

This command can spend money, so it must bias toward explicitness.

Before running:

- validate that `--exec` exists
- validate that graph and question inputs exist
- show both prompt token estimates
- show the exact execution template
- require confirmation unless `--yes` is present

Failure handling should preserve evidence:

- if baseline succeeds and graphify fails, save partial results
- if graphify succeeds and baseline fails, save partial results
- if both fail, still save prompts and stderr metadata

The command should never silently drop failed runs.

## Testing Strategy

### Unit tests

- CLI parsing for `compare`
- template placeholder expansion
- prompt file generation
- report generation
- token summary formatting
- confirmation behavior
- partial-failure behavior

### Integration tests

Use a fake deterministic runner that echoes output to stdout. This verifies orchestration without consuming tokens or depending on real external tools in CI.

Important integration cases:

- single-question success
- batch success
- baseline failure only
- graphify failure only
- missing `--exec`
- invalid placeholder templates

## Recommended Implementation Notes

- add a new `compare` CLI parser branch rather than overloading `benchmark`
- keep compare-specific logic in new infrastructure files
- reuse current retrieval and token-estimation logic wherever possible
- avoid coupling the feature to any specific provider brand
- keep the first version honest: compare exact prompt packs and captured outputs, not provider billing claims

## Recommendation

Ship `graphify-ts compare` as a runner-driven showcase command.

This gives users a concrete proof workflow:

1. ask one question
2. run it without graphify
3. run it with graphify
4. inspect the exact prompts, answers, and token-size difference

That is strong enough to demonstrate value, flexible enough to work with many terminal LLM tools, and small enough to implement without turning graphify-ts into a provider SDK wrapper.
