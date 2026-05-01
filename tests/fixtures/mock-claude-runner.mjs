#!/usr/bin/env node
// Mock `claude --output-format json` runner used by the compare native_agent
// smoke test. Emits a deterministic JSON object on stdout that conforms to the
// shape graphify's parser expects (top-level `usage`, `num_turns`, `duration_ms`,
// `total_cost_usd`, and a `result` text body).
//
// Usage:
//   mock-claude-runner.mjs <prompt-file>
//
// Behavior:
// - If GRAPHIFY_MOCK_MODE=baseline, emits the baseline numbers from the
//   2026-04-30 govalidate measurement.
// - If GRAPHIFY_MOCK_MODE=graphify (or unset), emits the graphify numbers.
// - Reads the prompt file (if provided) just to mirror what a real runner
//   would do; ignored otherwise.

import { existsSync, readFileSync } from 'node:fs'

const promptPath = process.argv[2] ?? null
const prompt = promptPath !== null && existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : ''
const mode = process.env.GRAPHIFY_MOCK_MODE === 'baseline' ? 'baseline' : 'graphify'

const baseline = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 96368,
  duration_api_ms: 95000,
  num_turns: 9,
  result: `mock baseline answer for prompt of length ${prompt.length}`,
  session_id: 'mock-baseline-session',
  total_cost_usd: 0.62,
  usage: {
    input_tokens: 14,
    cache_creation_input_tokens: 40648,
    cache_read_input_tokens: 574528,
    output_tokens: 3152,
  },
}

const graphify = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 34744,
  duration_api_ms: 34000,
  num_turns: 3,
  result: `mock graphify answer for prompt of length ${prompt.length}`,
  session_id: 'mock-graphify-session',
  total_cost_usd: 0.7,
  usage: {
    input_tokens: 13,
    cache_creation_input_tokens: 92833,
    cache_read_input_tokens: 140662,
    output_tokens: 1893,
  },
}

const payload = mode === 'baseline' ? baseline : graphify
process.stdout.write(`${JSON.stringify(payload)}\n`)
