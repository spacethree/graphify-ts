import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBuiltInSkillContent } from './install-skill-templates.js'

export const INSTALL_PLATFORMS = ['claude', 'codex', 'opencode', 'claw', 'droid', 'trae', 'trae-cn', 'windows'] as const

export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number]

export const AGENT_PLATFORMS = ['codex', 'opencode', 'claw', 'droid', 'trae', 'trae-cn'] as const

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number]

interface InstallPlatformConfig {
  skillFile: string
  skillDestination: string
  registerClaudeMd: boolean
}

interface InstallSkillOptions {
  homeDir?: string
  packageRoot?: string
  version?: string
}

const PLATFORM_CONFIG: Record<InstallPlatform, InstallPlatformConfig> = {
  claude: {
    skillFile: 'skill.md',
    skillDestination: '.claude/skills/graphify/SKILL.md',
    registerClaudeMd: true,
  },
  codex: {
    skillFile: 'skill-codex.md',
    skillDestination: '.agents/skills/graphify/SKILL.md',
    registerClaudeMd: false,
  },
  opencode: {
    skillFile: 'skill-opencode.md',
    skillDestination: '.config/opencode/skills/graphify/SKILL.md',
    registerClaudeMd: false,
  },
  claw: {
    skillFile: 'skill-claw.md',
    skillDestination: '.claw/skills/graphify/SKILL.md',
    registerClaudeMd: false,
  },
  droid: {
    skillFile: 'skill-droid.md',
    skillDestination: '.factory/skills/graphify/SKILL.md',
    registerClaudeMd: false,
  },
  trae: {
    skillFile: 'skill-trae.md',
    skillDestination: '.trae/skills/graphify/SKILL.md',
    registerClaudeMd: false,
  },
  'trae-cn': {
    skillFile: 'skill-trae.md',
    skillDestination: '.trae-cn/skills/graphify/SKILL.md',
    registerClaudeMd: false,
  },
  windows: {
    skillFile: 'skill-windows.md',
    skillDestination: '.claude/skills/graphify/SKILL.md',
    registerClaudeMd: true,
  },
}

const SETTINGS_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  matcher: 'Glob|Grep',
  hooks: [
    {
      type: 'command',
      command:
        `[ -f graphify-out/graph.json ] && ` +
        `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"graphify: Knowledge graph exists. Read graphify-out/GRAPH_REPORT.md for god nodes and community structure before searching raw files."}}' || true`,
    },
  ],
}

const CODEX_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command:
              `[ -f graphify-out/graph.json ] && ` +
              `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"},"systemMessage":"graphify: Knowledge graph exists. Read graphify-out/GRAPH_REPORT.md for god nodes and community structure before searching raw files."}' || true`,
          },
        ],
      },
    ],
  },
}

const SKILL_REGISTRATION =
  '\n# graphify\n' +
  '- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`\n' +
  'When the user types `/graphify`, invoke the Skill tool with `skill: "graphify"` before doing anything else.\n'

const CLAUDE_MD_SECTION = `## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- Use only Node.js / TypeScript tooling in this repository. Do not install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
- After modifying code files in this session, refresh graph artifacts with this repository's TypeScript graphify-ts workflow only.
`

const AGENTS_MD_SECTION = `## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- Use only Node.js / TypeScript tooling in this repository. Do not install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
- After modifying code files in this session, refresh graph artifacts with this repository's TypeScript graphify-ts workflow only.
`

const SECTION_MARKER = '## graphify'
const SKILL_REGISTRATION_MARKER = '- **graphify**'
const LOCAL_SKILL_ASSET_DIRECTORY = join('assets', 'skills')
const OPENCODE_PLUGIN_RELATIVE_PATH = '.opencode/plugins/graphify.js'
const OPENCODE_CONFIG_PATH = 'opencode.json'
const OPENCODE_PLUGIN_JS = `// graphify OpenCode plugin
// Injects a knowledge graph reminder before bash tool calls when the graph exists.
import { existsSync } from "fs";
import { join } from "path";

export const GraphifyPlugin = async ({ directory }) => {
  let reminded = false;

  return {
    "tool.execute.before": async (input, output) => {
      if (reminded) return;
      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;

      if (input.tool === "bash") {
        output.args.command =
          'echo "[graphify] Knowledge graph available. Read graphify-out/GRAPH_REPORT.md for god nodes and architecture context before searching files." && ' +
          output.args.command;
        reminded = true;
      }
    },
  };
};
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {}
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isRecord(parsed)) {
      throw new Error(`Failed to parse ${filePath}: expected a JSON object at the top level.`)
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Failed to parse')) {
      throw error
    }
    throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  ensureParentDirectory(filePath)
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key]
  if (isRecord(existing)) {
    return existing
  }
  const next: Record<string, unknown> = {}
  parent[key] = next
  return next
}

function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  const existing = parent[key]
  if (Array.isArray(existing)) {
    return existing
  }
  const next: unknown[] = []
  parent[key] = next
  return next
}

function removeSection(content: string, marker: string): string {
  return content.replace(/\n*## graphify\n[\s\S]*?(?=\n## |$)/, '').trimEnd()
}

function findPackageRoot(startDirectory = dirname(fileURLToPath(import.meta.url))): string {
  let currentDirectory = resolve(startDirectory)

  while (true) {
    const packageJsonPath = join(currentDirectory, 'package.json')
    if (existsSync(packageJsonPath)) {
      return currentDirectory
    }

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      throw new Error('Could not locate package root from install helper module')
    }
    currentDirectory = parentDirectory
  }
}

function readPackageVersion(packageRoot: string): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    if (isRecord(packageJson) && typeof packageJson.version === 'string') {
      return packageJson.version
    }
  } catch {
    // ignore and fall back below
  }

  return 'unknown'
}

function resolveSkillSourcePath(platform: InstallPlatform, packageRoot: string): string | undefined {
  const config = PLATFORM_CONFIG[platform]
  const candidatePaths = [join(packageRoot, LOCAL_SKILL_ASSET_DIRECTORY, config.skillFile)]

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath
    }
  }

  return undefined
}

function resolveSkillContent(platform: InstallPlatform, packageRoot: string): string {
  const sourcePath = resolveSkillSourcePath(platform, packageRoot)
  if (sourcePath) {
    const content = readFileSync(sourcePath, 'utf8')
    if (content.trim().length === 0) {
      throw new Error(`error: ${sourcePath} is empty or corrupted`)
    }
    return content
  }

  const content = getBuiltInSkillContent(platform)
  if (content.trim().length === 0) {
    throw new Error(`error: built-in template for ${platform} is empty or corrupted`)
  }
  return content
}

function registerHomeClaudeSkill(homeDir: string): string {
  const claudeMdPath = join(homeDir, '.claude', 'CLAUDE.md')
  ensureParentDirectory(claudeMdPath)

  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, SKILL_REGISTRATION.trimStart(), 'utf8')
    return `CLAUDE.md -> created at ${claudeMdPath}`
  }

  const content = readFileSync(claudeMdPath, 'utf8')
  if (content.includes(SKILL_REGISTRATION_MARKER)) {
    return 'CLAUDE.md -> already registered (no change)'
  }

  writeFileSync(claudeMdPath, `${content.trimEnd()}${SKILL_REGISTRATION}`, 'utf8')
  return `CLAUDE.md -> skill registered in ${claudeMdPath}`
}

function installClaudeHook(projectDir: string): string {
  const settingsPath = join(projectDir, '.claude', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  if (preToolUse.some((hook) => isRecord(hook) && hook.matcher === 'Glob|Grep' && JSON.stringify(hook).includes('graphify'))) {
    return '.claude/settings.json -> hook already registered (no change)'
  }

  preToolUse.push(SETTINGS_HOOK)
  writeJson(settingsPath, settings)
  return '.claude/settings.json -> PreToolUse hook registered'
}

function uninstallClaudeHook(projectDir: string): string | undefined {
  const settingsPath = join(projectDir, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) {
    return undefined
  }

  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')
  const filtered = preToolUse.filter((hook) => !(isRecord(hook) && hook.matcher === 'Glob|Grep' && JSON.stringify(hook).includes('graphify')))

  if (filtered.length === preToolUse.length) {
    return undefined
  }

  hooks.PreToolUse = filtered
  writeJson(settingsPath, settings)
  return '.claude/settings.json -> PreToolUse hook removed'
}

function installCodexHook(projectDir: string): string {
  const hooksPath = join(projectDir, '.codex', 'hooks.json')
  const hooksConfig = readJsonObject(hooksPath)
  const hooks = ensureRecord(hooksConfig, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  if (preToolUse.some((hook) => JSON.stringify(hook).includes('graphify'))) {
    return '.codex/hooks.json -> hook already registered (no change)'
  }

  const additions = CODEX_HOOK.hooks.PreToolUse as unknown[]
  preToolUse.push(...additions)
  writeJson(hooksPath, hooksConfig)
  return '.codex/hooks.json -> PreToolUse hook registered'
}

function uninstallCodexHook(projectDir: string): string | undefined {
  const hooksPath = join(projectDir, '.codex', 'hooks.json')
  if (!existsSync(hooksPath)) {
    return undefined
  }

  const hooksConfig = readJsonObject(hooksPath)
  const hooks = ensureRecord(hooksConfig, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')
  const filtered = preToolUse.filter((hook) => !JSON.stringify(hook).includes('graphify'))

  if (filtered.length === preToolUse.length) {
    return undefined
  }

  hooks.PreToolUse = filtered
  writeJson(hooksPath, hooksConfig)
  return '.codex/hooks.json -> PreToolUse hook removed'
}

function installOpencodePlugin(projectDir: string): string[] {
  const pluginPath = join(projectDir, OPENCODE_PLUGIN_RELATIVE_PATH)
  ensureParentDirectory(pluginPath)
  writeFileSync(pluginPath, OPENCODE_PLUGIN_JS, 'utf8')

  const configPath = join(projectDir, OPENCODE_CONFIG_PATH)
  const config = readJsonObject(configPath)
  const plugins = ensureArray(config, 'plugin')
  const messages = ['.opencode/plugins/graphify.js -> tool.execute.before hook written']

  if (!plugins.includes(OPENCODE_PLUGIN_RELATIVE_PATH)) {
    plugins.push(OPENCODE_PLUGIN_RELATIVE_PATH)
    writeJson(configPath, config)
    messages.push('opencode.json -> plugin registered')
    return messages
  }

  writeJson(configPath, config)
  messages.push('opencode.json -> plugin already registered (no change)')
  return messages
}

function uninstallOpencodePlugin(projectDir: string): string[] {
  const pluginPath = join(projectDir, OPENCODE_PLUGIN_RELATIVE_PATH)
  const messages: string[] = []

  if (existsSync(pluginPath)) {
    unlinkSync(pluginPath)
    messages.push('.opencode/plugins/graphify.js -> removed')
  }

  const configPath = join(projectDir, OPENCODE_CONFIG_PATH)
  if (!existsSync(configPath)) {
    return messages
  }

  const config = readJsonObject(configPath)
  const plugins = ensureArray(config, 'plugin')
  const filtered = plugins.filter((entry) => entry !== OPENCODE_PLUGIN_RELATIVE_PATH)

  if (filtered.length === plugins.length) {
    return messages
  }

  if (filtered.length === 0) {
    delete config.plugin
  } else {
    config.plugin = filtered
  }

  writeJson(configPath, config)
  messages.push('opencode.json -> plugin deregistered')
  return messages
}

function writeSection(targetPath: string, section: string): string {
  ensureParentDirectory(targetPath)

  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, section, 'utf8')
    return `graphify section written to ${targetPath}`
  }

  const content = readFileSync(targetPath, 'utf8')
  if (content.includes(SECTION_MARKER)) {
    return `graphify already configured in ${targetPath.endsWith('CLAUDE.md') ? 'CLAUDE.md' : 'AGENTS.md'}`
  }

  writeFileSync(targetPath, `${content.trimEnd()}\n\n${section}`, 'utf8')
  return `graphify section written to ${targetPath}`
}

function removeSectionFromFile(targetPath: string): string {
  if (!existsSync(targetPath)) {
    return `No ${targetPath.endsWith('CLAUDE.md') ? 'CLAUDE.md' : 'AGENTS.md'} found in current directory - nothing to do`
  }

  const content = readFileSync(targetPath, 'utf8')
  if (!content.includes(SECTION_MARKER)) {
    return `graphify section not found in ${targetPath.endsWith('CLAUDE.md') ? 'CLAUDE.md' : 'AGENTS.md'} - nothing to do`
  }

  const cleaned = removeSection(content, SECTION_MARKER)
  if (cleaned.length > 0) {
    writeFileSync(targetPath, `${cleaned}\n`, 'utf8')
    return `graphify section removed from ${targetPath}`
  }

  rmSync(targetPath, { force: true })
  return `${targetPath.endsWith('CLAUDE.md') ? 'CLAUDE.md' : 'AGENTS.md'} was empty after removal - deleted ${targetPath}`
}

export function defaultInstallPlatform(nodePlatform = process.platform): InstallPlatform {
  return nodePlatform === 'win32' ? 'windows' : 'claude'
}

export function isInstallPlatform(value: string): value is InstallPlatform {
  return INSTALL_PLATFORMS.includes(value as InstallPlatform)
}

export function isAgentPlatform(value: string): value is AgentPlatform {
  return AGENT_PLATFORMS.includes(value as AgentPlatform)
}

export function installSkill(platform: InstallPlatform, options: InstallSkillOptions = {}): string {
  const homeDir = resolve(options.homeDir ?? homedir())
  const packageRoot = resolve(options.packageRoot ?? findPackageRoot())
  const version = options.version ?? readPackageVersion(packageRoot)
  const skillContent = resolveSkillContent(platform, packageRoot)
  const destinationPath = join(homeDir, PLATFORM_CONFIG[platform].skillDestination)

  ensureParentDirectory(destinationPath)
  writeFileSync(destinationPath, skillContent, 'utf8')
  writeFileSync(join(dirname(destinationPath), '.graphify_version'), version, 'utf8')

  const messages = [`skill installed -> ${destinationPath}`]
  if (PLATFORM_CONFIG[platform].registerClaudeMd) {
    messages.push(registerHomeClaudeSkill(homeDir))
  }
  messages.push('', 'Done. Open your AI coding assistant and type:', '', '  /graphify .')
  return messages.join('\n')
}

export function claudeInstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [writeSection(join(resolvedProjectDir, 'CLAUDE.md'), CLAUDE_MD_SECTION), installClaudeHook(resolvedProjectDir)]
  messages.push('', 'Claude Code will now check the knowledge graph before answering', 'codebase questions and rebuild it after code changes.')
  return messages.join('\n')
}

export function claudeUninstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [removeSectionFromFile(join(resolvedProjectDir, 'CLAUDE.md'))]
  const hookMessage = uninstallClaudeHook(resolvedProjectDir)
  if (hookMessage) {
    messages.push(hookMessage)
  }
  return messages.join('\n')
}

export function agentsInstall(projectDir = '.', platform: AgentPlatform): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [writeSection(join(resolvedProjectDir, 'AGENTS.md'), AGENTS_MD_SECTION)]

  if (platform === 'codex') {
    messages.push(installCodexHook(resolvedProjectDir))
  } else if (platform === 'opencode') {
    messages.push(...installOpencodePlugin(resolvedProjectDir))
  }

  messages.push('', `${platform} will now check the knowledge graph before answering`, 'codebase questions and rebuild it after code changes.')
  if (platform !== 'codex' && platform !== 'opencode') {
    messages.push('', `Note: unlike Claude Code, there is no PreToolUse hook equivalent for ${platform} - the AGENTS.md rules are the always-on mechanism.`)
  }
  return messages.join('\n')
}

export function agentsUninstall(projectDir = '.', platform: AgentPlatform): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [removeSectionFromFile(join(resolvedProjectDir, 'AGENTS.md'))]

  if (platform === 'codex') {
    const hookMessage = uninstallCodexHook(resolvedProjectDir)
    if (hookMessage) {
      messages.push(hookMessage)
    }
  } else if (platform === 'opencode') {
    messages.push(...uninstallOpencodePlugin(resolvedProjectDir))
  }

  return messages.join('\n')
}
