#!/usr/bin/env node

import { executeCli } from './main.js'

try {
  const exitCode = await executeCli(process.argv.slice(2))
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
} catch (error) {
  console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
