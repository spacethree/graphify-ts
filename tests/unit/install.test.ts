import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentsInstall, agentsUninstall, claudeInstall, claudeUninstall, defaultInstallPlatform, installSkill } from '../../src/infrastructure/install.js'

const BUNDLED_ASSET_CONTENT = {
  'skill.md': '# graphify\n\nLocal bundled Claude skill\n',
  'skill-codex.md': '# graphify\n\nUse spawn_agent for Codex installs.\n',
  'skill-opencode.md': '# graphify\n\nUse @mention syntax for OpenCode installs.\n',
  'skill-claw.md': '# graphify\n\nSequential execution guidance for Claw installs.\n',
  'skill-droid.md': '# graphify\n\nFactory Droid bundled skill.\n',
  'skill-trae.md': '# graphify\n\nTrae bundled skill.\n',
  'skill-windows.md': '# graphify\n\nWindows bundled skill.\n',
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

describe('install helpers', () => {
  it('chooses the default platform from the host OS', () => {
    expect(defaultInstallPlatform('win32')).toBe('windows')
    expect(defaultInstallPlatform('darwin')).toBe('claude')
  })

  it('installs skills into the expected home-directory locations', () => {
    const expectedPaths = {
      claude: '.claude/skills/graphify/SKILL.md',
      codex: '.agents/skills/graphify/SKILL.md',
      opencode: '.config/opencode/skills/graphify/SKILL.md',
      claw: '.claw/skills/graphify/SKILL.md',
      droid: '.factory/skills/graphify/SKILL.md',
      trae: '.trae/skills/graphify/SKILL.md',
      'trae-cn': '.trae-cn/skills/graphify/SKILL.md',
      windows: '.claude/skills/graphify/SKILL.md',
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

  it('copies the expected skill content variants', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        installSkill('codex', { homeDir, packageRoot, version: 'test-version' })
        installSkill('opencode', { homeDir, packageRoot, version: 'test-version' })
        installSkill('claw', { homeDir, packageRoot, version: 'test-version' })

        expect(readFileSync(join(homeDir, '.agents', 'skills', 'graphify', 'SKILL.md'), 'utf8')).toContain('spawn_agent')
        expect(readFileSync(join(homeDir, '.config', 'opencode', 'skills', 'graphify', 'SKILL.md'), 'utf8')).toContain('@mention')
        expect(readFileSync(join(homeDir, '.claw', 'skills', 'graphify', 'SKILL.md'), 'utf8').toLowerCase()).toContain('sequential')
      })
    })
  })

  it('installs from bundled local assets without needing the Python reference checkout', () => {
    withBundledPackageRoot((packageRoot) => {
      withTempDir((homeDir) => {
        expect(existsSync(join(packageRoot, 'graphify'))).toBe(false)

        installSkill('claude', { homeDir, packageRoot, version: 'test-version' })

        expect(readFileSync(join(homeDir, '.claude', 'skills', 'graphify', 'SKILL.md'), 'utf8')).toContain('Local bundled Claude skill')
      })
    })
  })

  it('falls back to built-in templates when package assets are unavailable', () => {
    withTempDir((packageRoot) => {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'graphify-ts-test', version: '0.1.0' }), 'utf8')

      withTempDir((homeDir) => {
        installSkill('codex', { homeDir, packageRoot, version: 'test-version' })

        const installedSkill = readFileSync(join(homeDir, '.agents', 'skills', 'graphify', 'SKILL.md'), 'utf8')
        expect(installedSkill).toMatch(/^---\nname: graphify\n/)
        expect(installedSkill).toContain('spawn_agent')
        expect(installedSkill).toContain('# /graphify')
        expect(installedSkill).toContain('## Honesty Rules')
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
      })
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
      expect(uninstallMessage).toMatch(/graphify section removed|CLAUDE\.md was empty after removal/)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
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
      const codexMessage = agentsInstall(projectDir, 'codex')
      expect(codexMessage).toContain('AGENTS.md')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('## graphify')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('python3 -c')
      expect(existsSync(join(projectDir, '.codex', 'hooks.json'))).toBe(true)

      const opencodeMessage = agentsInstall(projectDir, 'opencode')
      expect(opencodeMessage).toMatch(/graphify section written|graphify already configured in AGENTS\.md/)
      expect(existsSync(join(projectDir, '.opencode', 'plugins', 'graphify.js'))).toBe(true)
      expect(existsSync(join(projectDir, 'opencode.json'))).toBe(true)
    })
  })

  it('uninstalls agent/project config while preserving unrelated content', () => {
    withTempDir((projectDir) => {
      writeFileSync(join(projectDir, 'AGENTS.md'), '# Existing rules\n\nKeep calm.\n', 'utf8')
      agentsInstall(projectDir, 'codex')
      const uninstallMessage = agentsUninstall(projectDir, 'codex')

      expect(uninstallMessage).toContain('graphify section removed')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).toContain('Keep calm.')
      expect(readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')).not.toContain('## graphify')
      expect(readFileSync(join(projectDir, '.codex', 'hooks.json'), 'utf8')).not.toContain('graphify')
    })
  })
})
