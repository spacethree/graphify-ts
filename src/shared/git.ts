import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function findGitRoot(path: string): string | null {
  let current = resolve(path)
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}
