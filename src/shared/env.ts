import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function readDotEnvFile(rootPath = '.'): Record<string, string> {
  const envPath = resolve(rootPath, '.env')
  if (!existsSync(envPath)) {
    return {}
  }

  const values: Record<string, string> = {}
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue
    }

    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim())
    values[key] = value
  }

  return values
}

export function getEnvValue(key: string, rootPath = '.', env: NodeJS.ProcessEnv = process.env): string | undefined {
  const runtimeValue = env[key]?.trim()
  if (runtimeValue && runtimeValue.length > 0) {
    return runtimeValue
  }

  const fileValue = readDotEnvFile(rootPath)[key]?.trim()
  if (fileValue && fileValue.length > 0) {
    return fileValue
  }

  return undefined
}
