import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  agentsInstall,
  agentsUninstall,
  claudeInstall,
  claudeUninstall,
  cursorInstall,
  cursorUninstall,
  defaultInstallPlatform,
  geminiInstall,
  geminiUninstall,
  installSkill,
  isAgentPlatform,
  isInstallPlatform,
  uninstallSkill,
} from '../../src/infrastructure/install.js'

const BUNDLED_ASSET_CONTENT = {
  'skill.md': '# graphify-ts\n\nLocal bundled Claude skill\n',
  'skill-aider.md': '# graphify-ts\n\nAider bundled skill.\n',
  'skill-codex.md': '# graphify-ts\n\nUse spawn_agent for Codex installs.\n',
  'skill-copilot.md': '# graphify-ts\n\nGitHub Copilot bundled skill.\n',
  'skill-opencode.md': '# graphify-ts\n\nUse @mention syntax for OpenCode installs.\n',
  'skill-claw.md': '# graphify-ts\n\nSequential execution guidance for Claw installs.\n',
  'skill-droid.md': '# graphify-ts\n\nFactory Droid bundled skill.\n',
  'skill-trae.md': '# graphify-ts\n\nTrae bundled skill.\n',
  'skill-windows.md': '# graphify-ts\n\nWindows bundled skill.\n',
} as const

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'graphify-ts-install-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function withBundledPackageRoot(callback: (packageRoot: string) => void): void {
  withTempDir((packageRoot) => {
    mkdirSync(join(packageRoot, 'assets', 'skills'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'graphify-ts-test', version: '0.1.0' }), 'utf8')

    for (const [fileName, content] of Object.entries(BUNDLED_ASSET_CONTENT)) {
      writeFileSync(join(packageRoot, 'assets', 'skills', fileName), content, 'utf8')
    }

    callback(packageRoot)
  })
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) {
    return 0
  }

  return content.split(needle).length - 1
}

describe('install helpers', () => {
  it('chooses the default platform from the host OS', () => {
    expect(defaultInstallPlatform('win32')).toBe('windows')
    expect(defaultInstallPlatform('darwin')).toBe('claude')
  })

  it('recognizes aider and copilot install platforms and treats aider as an agent platform', () => {
    expect(isInstallPlatform('aider')).toBe(true)
    expect(isInstallPlatform('copilot')).toBe(true)
    expect(isInstallPlatform('gemini')).toBe(true)
    expect(isInstallPlatform('cursor')).toBe(true)
    expect(isAgentPlatform('aider')).toBe(true)
    expect(isAgentPlatform('copilot')).toBe(false)
    expect(isAgentPlatform('gemini')).toBe(false)
    expect(isAgentPlatform('cursor')).toBe(false)
  })

  it('installs skills into the expected home-directory locations', () => {
    const expectedPaths = {
      claude: '.claude/skills/graphify-ts/SKILL.md',
      gemini: '.gemini/skills/graphify-ts/SKILL.md',
      aider: '.aider/graphify-ts/SKILL.md',
      codex: '.agents/skills/graphify-ts/SKILL.md',
      copilot: '.copilot/skills/graphify-ts/SKILL.md',
      opencode: '.config/opencode/skills/graphify-ts/SKILL.md',
      claw: '.claw/skills/graphify-ts/SKILL.md',
      droid: '.factory/skills/graphify-ts/SKILL.md',
      trae: '.trae/skills/graphify-ts/SKILL.md',
      'trae-cn': '.trae-cn/skills/graphify-ts/SKILL.md',
      windows: '.claude/skills/graphify-ts/SKILL.md',
    } as const

    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        for (const [platform, relativePath] of Object.entries(expectedPaths)) {
          installSkill(platform as keyof typeof expectedPaths, { homeDir, packageRoot, version: 'test-version' })
          expect(existsSync(join(homeDir, relativePath))).toBe(true)
          expect(readFileSync(join(homeDir, relativePath.replace('SKILL.md', '.graphify_version')), 'utf8')).toBe('test-version')
        }
      })
    })
  })

  it('registers CLAUDE.md for claude installs but not codex installs', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })
        expect(existsSync(join(homeDir, '.claude', 'CLAUDE.md'))).toBe(true)

        const secondHome = join(homeDir, 'other-home')
        installSkill('codex', { homeDir: secondHome, packageRoot, version: 'test-version' })
        expect(existsSync(join(secondHome, '.claude', 'CLAUDE.md'))).toBe(false)
      })
    })
  })

  it('does not duplicate the home CLAUDE.md registration when claude skill install runs twice', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })
        const firstClaudeMd = readFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')

        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })

        const secondClaudeMd = readFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')
        expect(secondClaudeMd).toBe(firstClaudeMd)
        expect(countOccurrences(secondClaudeMd, '- **graphify-ts**')).toBe(1)
      })
    })
  })

  it('copies the expected skill content variants', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('aider', { homeDir, packageRoot, version: 'test-version' })
        installSkill('gemini', { homeDir, packageRoot, version: 'test-version' })
        installSkill('codex', { homeDir, packageRoot, version: 'test-version' })
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })
        installSkill('opencode', { homeDir, packageRoot, version: 'test-version' })
        installSkill('claw', { homeDir, packageRoot, version: 'test-version' })

        expect(readFileSync(join(homeDir, '.aider', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('Aider bundled skill')
        expect(readFileSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('Local bundled Claude skill')
        expect(readFileSync(join(homeDir, '.agents', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('spawn_agent')
        expect(readFileSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('GitHub Copilot bundled skill')
        expect(readFileSync(join(homeDir, '.config', 'opencode', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('@mention')
        expect(readFileSync(join(homeDir, '.claw', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8').toLowerCase()).toContain('sequential')
      })
    })
  })

  it('installs from bundled local assets without needing the Python reference checkout', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        expect(existsSync(join(packageRoot, 'graphify'))).toBe(false)

        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })

        expect(readFileSync(join(homeDir, '.claude', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')).toContain('Local bundled Claude skill')
      })
    })
  })

  it('falls back to built-in templates when package assets are unavailable', () => {
    withTempDir((packageRoot) => {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'graphify-ts-test', version: '0.1.0' }), 'utf8')

      withTempDir((homeDir) => {
        installSkill('gemini', { homeDir, packageRoot, version: 'test-version' })
        installSkill('aider', { homeDir, packageRoot, version: 'test-version' })
        installSkill('codex', { homeDir, packageRoot, version: 'test-version' })
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })

        const geminiSkill = readFileSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')
        const aiderSkill = readFileSync(join(homeDir, '.aider', 'graphify-ts', 'SKILL.md'), 'utf8')
        const installedSkill = readFileSync(join(homeDir, '.agents', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')
        const copilotSkill = readFileSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'), 'utf8')
        expect(geminiSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(geminiSkill).toContain('# /graphify-ts')
        expect(aiderSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(aiderSkill).toContain('Aider')
        expect(installedSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(installedSkill).toContain('spawn_agent')
        expect(installedSkill).toContain('# /graphify-ts')
        expect(installedSkill).toContain('## Honesty Rules')
        expect(installedSkill).toContain('code/docs/papers/images/audio/video counts')
        expect(installedSkill).toContain('"schema_version":2')
        expect(installedSkill).toContain('"file_type":"code|document|paper|image|audio|video|rationale"')
        expect(installedSkill).toContain('"provenance":[{"capability_id":"')
        expect(installedSkill).toContain('local audio/video, plus direct audio/video URL ingests that download into the same hidden-sidecar path, currently land as deterministic file nodes only')
        expect(installedSkill).toContain('```bash')
        expect(installedSkill.length).toBeGreaterThan(1000)
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_BLOCK_START]]]')
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_BLOCK_END]]]')
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_SPAN_START]]]')
        expect(installedSkill).not.toContain('[[[GRAPHIFY_CODE_SPAN_END]]]')
        expect(installedSkill).not.toContain('\u0000')
        expect(installedSkill).not.toContain('python3 -c')
        expect(installedSkill).not.toContain('graphifyy')
        expect(installedSkill).not.toContain('from graphify.')
        expect(copilotSkill).toMatch(/^---\nname: graphify-ts\n/)
        expect(copilotSkill).toContain('# /graphify-ts')
      })
    })
  })

  it('uninstalls copilot skills from the home-directory location', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('copilot', { homeDir, packageRoot, version: 'test-version' })
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(true)

        const message = uninstallSkill('copilot', { homeDir })

        expect(message).toContain('skill removed')
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(false)
        expect(existsSync(join(homeDir, '.copilot', 'skills', 'graphify-ts', '.graphify_version'))).toBe(false)
      })
    })
  })

  it('writes and removes local Gemini project instructions, hook config, and home skill', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        withTempDir((projectDir) => {
          const installMessage = geminiInstall(projectDir, { homeDir, packageRoot, version: 'test-version' })
          expect(installMessage).toContain('GEMINI.md')
          expect(existsSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(true)
          expect(existsSync(join(projectDir, 'GEMINI.md'))).toBe(true)
          expect(existsSync(join(projectDir, '.gemini', 'settings.json'))).toBe(true)
          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toContain('TypeScript tooling')
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).toContain('graphify-ts')

          const uninstallMessage = geminiUninstall(projectDir, { homeDir })
          expect(uninstallMessage).toMatch(/graphify-ts section removed|GEMINI\.md was empty after removal/)
          expect(existsSync(join(homeDir, '.gemini', 'skills', 'graphify-ts', 'SKILL.md'))).toBe(false)
          expect(existsSync(join(projectDir, 'GEMINI.md'))).toBe(false)
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).not.toContain('graphify-ts')
        })
      })
    })
  })

  it('keeps Gemini project instructions and hooks idempotent across repeated installs', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        withTempDir((projectDir) => {
          geminiInstall(projectDir, { homeDir, packageRoot, version: 'test-version' })
          const firstGeminiMd = readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')
          const firstSettings = readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')

          geminiInstall(projectDir, { homeDir, packageRoot, version: 'test-version' })

          expect(readFileSync(join(projectDir, 'GEMINI.md'), 'utf8')).toBe(firstGeminiMd)
          expect(readFileSync(join(projectDir, '.gemini', 'settings.json'), 'utf8')).toBe(firstSettings)
          expect(countOccurrences(firstGeminiMd, '## graphify-ts')).toBe(1)
          expect(countOccurrences(firstSettings, 'graphify-ts')).toBeGreaterThan(0)
        })
      })
    })
  })

  it('fails loudly for malformed existing Gemini JSON config files', () => {
    withTempDir((projectDir) => {
      const settingsPath = join(projectDir, '.gemini', 'settings.json')
      mkdirSync(join(projectDir, '.gemini'), { recursive: true })
      writeFileSync(settingsPath, '{ not valid json', 'utf8')

      expect(() => geminiInstall(projectDir)).toThrow(`Failed to parse ${settingsPath}`)
    })
  })

  it('writes and removes the local Cursor rule file', () => {
    withTempDir((projectDir) => {
      const installMessage = cursorInstall(projectDir)
      expect(installMessage).toContain('.cursor/rules/graphify-ts.mdc')
      expect(existsSync(join(projectDir, '.cursor', 'rules', 'graphify-ts.mdc'))).toBe(true)
      expect(readFileSync(join(projectDir, '.cursor', 'rules', 'graphify-ts.mdc'), 'utf8')).toContain('alwaysApply: true')

      const uninstallMessage = cursorUninstall(projectDir)
      expect(uninstallMessage).toContain('removed')
      expect(existsSync(join(projectDir, '.cursor', 'rules', 'graphify-ts.mdc'))).toBe(false)
    })
  })

  it('writes and removes local Claude project instructions', () => {
    withTempDir((projectDir) => {
      const installMessage = claudeInstall(projectDir)
      expect(installMessage).toContain('CLAUDE.md')
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true)
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).not.toContain('python3 -c')
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('TypeScript tooling')

      const uninstallMessage = claudeUninstall(projectDir)
      expect(uninstallMessage).toMatch(/graphify-ts section removed|CLAUDE\.md was empty after removal/)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
    })
  })

  it('keeps Claude project instructions and hooks idempotent across repeated installs', () => {
    withTempDir((projectDir) => {
      claudeInstall(projectDir)
      const firstClaudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')
      const firstSettings = readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')

      claudeInstall(projectDir)

      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(firstClaudeMd)
      expect(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')).toBe(firstSettings)
      expect(countOccurrences(firstClaudeMd, '## graphify-ts')).toBe(1)
      expect(countOccurrences(firstSettings, 'graphify-ts')).toBeGreaterThan(0)
    })
  })

  it('fails loudly for malformed existing JSON config files', () => {
    withTempDir((projectDir) => {
      const settingsPath = join(projectDir, '.claude', 'settings.json')
      mkdirSync(join(projectDir, '.claude'), { recursive: true })
      writeFileSync(settingsPath, '{ not valid json', 'utf8')

      expect(() => claudeInstall(projectDir)).toThrow(`Failed to parse ${settingsPath}`)
    })
  })

  it('writes agents instructions and platform-specific plugin files', () => {
    withTempDir((projectDir) => {
      const aiderMessage = agentsInstall(projectDir, 'aider')
      const codexMessage = agentsInstall(projectDir, 'codex')
      expect(aiderMessage).toContain('AGENTS.md')
      expect(aiderMessage).toContain('Aider')
      expect(codexMessage).toContain('AGENTS.md')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('## graphify-ts')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('python3 -c')
      expect(existsSync(join(projectDir, '.codex', 'hooks.json'))).toBe(true)

      const opencodeMessage = agentsInstall(projectDir, 'opencode')
      expect(opencodeMessage).toMatch(/graphify-ts section (written|updated) in/)
      expect(existsSync(join(projectDir, '.opencode', 'plugins', 'graphify-ts.js'))).toBe(true)
      expect(existsSync(join(projectDir, 'opencode.json'))).toBe(true)
    })
  })

  it('keeps codex and opencode project integrations idempotent across repeated installs', () => {
    withTempDir((projectDir) => {
      agentsInstall(projectDir, 'codex')
      agentsInstall(projectDir, 'opencode')
      const firstAgentsMd = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')
      const firstCodexHooks = readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')
      const firstOpenCodeConfig = readFileSync(join(projectDir, 'opencode.json'), 'utf8')

      agentsInstall(projectDir, 'codex')
      agentsInstall(projectDir, 'opencode')

      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toBe(firstAgentsMd)
      expect(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')).toBe(firstCodexHooks)
      expect(readFileSync(join(projectDir, 'opencode.json'), 'utf8')).toBe(firstOpenCodeConfig)
      expect(countOccurrences(firstAgentsMd, '## graphify-ts')).toBe(1)
      expect(countOccurrences(firstCodexHooks, 'graphify-ts')).toBeGreaterThan(0)
      expect(countOccurrences(firstOpenCodeConfig, '.opencode/plugins/graphify-ts.js')).toBe(1)
    })
  })

  it('uninstalls agent/project config while preserving unrelated content', () => {
    withTempDir((projectDir) => {
      writeFileSync(join(projectDir, 'AGENTS.md'), '# Existing rules\n\nKeep calm.\n', 'utf8')
      agentsInstall(projectDir, 'codex')
      const uninstallMessage = agentsUninstall(projectDir, 'codex')

      expect(uninstallMessage).toContain('graphify-ts section removed')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('Keep calm.')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('## graphify-ts')
      expect(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')).not.toContain('graphify-ts')
    })
  })
})
