import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBuiltInSkillContent } from './install-skill-templates.js'

export const SKILL_INSTALL_PLATFORMS = ['claude', 'gemini', 'codex', 'opencode', 'aider', 'claw', 'droid', 'trae', 'trae-cn', 'copilot', 'windows'] as const

export type SkillInstallPlatform = (typeof SKILL_INSTALL_PLATFORMS)[number]

export const INSTALL_PLATFORMS = [...SKILL_INSTALL_PLATFORMS, 'cursor'] as const

export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number]

export const AGENT_PLATFORMS = ['codex', 'opencode', 'aider', 'claw', 'droid', 'trae', 'trae-cn'] as const

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

const SKILL_SLUG = 'graphify-ts'
const SKILL_COMMAND = '/graphify-ts'
const SECTION_MARKER = '## graphify-ts'
const HOME_SECTION_MARKER = '# graphify-ts'

const PLATFORM_CONFIG: Record<SkillInstallPlatform, InstallPlatformConfig> = {
  claude: {
    skillFile: 'skill.md',
    skillDestination: '.claude/skills/graphify-ts/SKILL.md',
    registerClaudeMd: true,
  },
  gemini: {
    skillFile: 'skill.md',
    skillDestination: '.gemini/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  aider: {
    skillFile: 'skill-aider.md',
    skillDestination: '.aider/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  codex: {
    skillFile: 'skill-codex.md',
    skillDestination: '.agents/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  copilot: {
    skillFile: 'skill-copilot.md',
    skillDestination: '.copilot/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  opencode: {
    skillFile: 'skill-opencode.md',
    skillDestination: '.config/opencode/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  claw: {
    skillFile: 'skill-claw.md',
    skillDestination: '.claw/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  droid: {
    skillFile: 'skill-droid.md',
    skillDestination: '.factory/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  trae: {
    skillFile: 'skill-trae.md',
    skillDestination: '.trae/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  'trae-cn': {
    skillFile: 'skill-trae.md',
    skillDestination: '.trae-cn/skills/graphify-ts/SKILL.md',
    registerClaudeMd: false,
  },
  windows: {
    skillFile: 'skill-windows.md',
    skillDestination: '.claude/skills/graphify-ts/SKILL.md',
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
        `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"graphify-ts: Knowledge graph exists. Use the retrieve MCP tool for codebase questions, or read graphify-out/GRAPH_REPORT.md for god nodes and community structure."}}' || true`,
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
              `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"},"systemMessage":"graphify-ts: Knowledge graph exists. Use the retrieve MCP tool for codebase questions, or read graphify-out/GRAPH_REPORT.md for god nodes and community structure."}' || true`,
          },
        ],
      },
    ],
  },
}

const GEMINI_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  matcher: 'read_file|list_directory',
  hooks: [
    {
      type: 'command',
      command:
        `[ -f graphify-out/graph.json ] && ` +
        `echo '{"decision":"allow","additionalContext":"graphify-ts: Knowledge graph exists. Use the retrieve MCP tool for codebase questions, or read graphify-out/GRAPH_REPORT.md for god nodes and community structure."}' || ` +
        `echo '{"decision":"allow"}'`,
    },
  ],
}

const SKILL_REGISTRATION =
  `\n${HOME_SECTION_MARKER}\n` +
  `- **${SKILL_SLUG}** (\`~/.claude/skills/${SKILL_SLUG}/SKILL.md\`) - any input to knowledge graph. Trigger: \`${SKILL_COMMAND}\`\n` +
  `When the user types \`${SKILL_COMMAND}\`, invoke the Skill tool with \`skill: "${SKILL_SLUG}"\` before doing anything else.\n`

const CLAUDE_MD_SECTION = `${SECTION_MARKER}

This project has a graphify-ts knowledge graph at graphify-out/.

Rules:
- When answering codebase questions, use the \`retrieve\` MCP tool (via graphify-ts serve --stdio) with a question and token budget to get relevant nodes, code snippets, relationships, and structural signals. Fall back to reading graphify-out/GRAPH_REPORT.md if the MCP server is not available.
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- Use only Node.js / TypeScript tooling in this repository. Do not install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
- After modifying code files in this session, refresh graph artifacts with this repository's TypeScript graphify-ts workflow only.
`

const AGENTS_MD_SECTION = `${SECTION_MARKER}

This project has a graphify-ts knowledge graph at graphify-out/.

Rules:
- When answering codebase questions, use the \`retrieve\` MCP tool (via graphify-ts serve --stdio) with a question and token budget to get relevant nodes, code snippets, relationships, and structural signals. Fall back to reading graphify-out/GRAPH_REPORT.md if the MCP server is not available.
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- Use only Node.js / TypeScript tooling in this repository. Do not install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
- After modifying code files in this session, refresh graph artifacts with this repository's TypeScript graphify-ts workflow only.
`

const GEMINI_MD_SECTION = `${SECTION_MARKER}

This project has a graphify-ts knowledge graph at graphify-out/.

Rules:
- When answering codebase questions, use the \`retrieve\` MCP tool (via graphify-ts serve --stdio) with a question and token budget to get relevant nodes, code snippets, relationships, and structural signals. Fall back to reading graphify-out/GRAPH_REPORT.md if the MCP server is not available.
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- Use only Node.js / TypeScript tooling in this repository. Do not install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
- After modifying code files in this session, refresh graph artifacts with this repository's TypeScript graphify-ts workflow only.
`

const SKILL_REGISTRATION_MARKER = '- **graphify-ts**'
const LOCAL_SKILL_ASSET_DIRECTORY = join('assets', 'skills')
const OPENCODE_PLUGIN_RELATIVE_PATH = '.opencode/plugins/graphify-ts.js'
const OPENCODE_CONFIG_PATH = 'opencode.json'
const CURSOR_RULE_RELATIVE_PATH = '.cursor/rules/graphify-ts.mdc'
const OPENCODE_PLUGIN_JS = `// graphify-ts OpenCode plugin
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
          'echo "[graphify-ts] Knowledge graph available. Use the retrieve MCP tool for codebase questions, or read graphify-out/GRAPH_REPORT.md for context." && ' +
          output.args.command;
        reminded = true;
      }
    },
  };
};
`

const CURSOR_RULE = `---
description: graphify-ts knowledge graph context
alwaysApply: true
---

This project has a graphify-ts knowledge graph at graphify-out/.

- When answering codebase questions, use the \`retrieve\` MCP tool (via graphify-ts serve --stdio) with a question and token budget to get relevant nodes, code snippets, relationships, and structural signals. Fall back to reading graphify-out/GRAPH_REPORT.md if the MCP server is not available.
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- Use only Node.js / TypeScript tooling in this repository. Do not install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
- After modifying code files in this session, refresh graph artifacts with this repository's TypeScript graphify-ts workflow only.
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

function sectionFileDisplayName(targetPath: string): string {
  const fileName = basename(targetPath)
  if (fileName === 'CLAUDE.md' || fileName === 'GEMINI.md' || fileName === 'AGENTS.md') {
    return fileName
  }
  return 'AGENTS.md'
}

function removeMarkdownSection(content: string, marker: string, nextHeadingPrefix: string): string {
  const startIndex = content.indexOf(marker)
  if (startIndex === -1) {
    return content.trimEnd()
  }

  const nextHeadingIndex = content.indexOf(`\n${nextHeadingPrefix}`, startIndex + marker.length)
  const before = content.slice(0, startIndex).trimEnd()
  const after = nextHeadingIndex === -1 ? '' : content.slice(nextHeadingIndex + 1).trimStart()

  if (before.length > 0 && after.length > 0) {
    return `${before}\n\n${after}`.trimEnd()
  }

  return `${before}${after}`.trimEnd()
}

function removeSection(content: string): string {
  return removeMarkdownSection(content, SECTION_MARKER, '## ')
}

function removeHomeSkillRegistration(content: string): string {
  return removeMarkdownSection(content, HOME_SECTION_MARKER, '# ')
}

function removeInstalledSkill(destinationPath: string, stopDirectory: string, label = 'skill removed'): string | undefined {
  if (!existsSync(destinationPath)) {
    return undefined
  }

  unlinkSync(destinationPath)
  const versionPath = join(dirname(destinationPath), '.graphify_version')
  if (existsSync(versionPath)) {
    unlinkSync(versionPath)
  }

  removeEmptyDirectories(dirname(destinationPath), stopDirectory)
  return `${label} -> ${destinationPath}`
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

function formatPlatformDisplayName(platform: AgentPlatform): string {
  if (platform === 'codex') {
    return 'Codex'
  }
  if (platform === 'opencode') {
    return 'OpenCode'
  }
  if (platform === 'aider') {
    return 'Aider'
  }
  if (platform === 'claw') {
    return 'OpenClaw'
  }
  if (platform === 'droid') {
    return 'Factory Droid'
  }
  if (platform === 'trae') {
    return 'Trae'
  }
  return 'Trae CN'
}

function removeEmptyDirectories(startDirectory: string, stopDirectory: string): void {
  let currentDirectory = resolve(startDirectory)
  const resolvedStopDirectory = resolve(stopDirectory)

  while (currentDirectory.startsWith(`${resolvedStopDirectory}/`) || currentDirectory === resolvedStopDirectory) {
    if (currentDirectory === resolvedStopDirectory) {
      break
    }

    try {
      rmdirSync(currentDirectory)
    } catch {
      break
    }

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      break
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

function resolveSkillSourcePath(platform: SkillInstallPlatform, packageRoot: string): string | undefined {
  const config = PLATFORM_CONFIG[platform]
  const candidatePath = join(packageRoot, LOCAL_SKILL_ASSET_DIRECTORY, config.skillFile)

  if (existsSync(candidatePath)) {
    return candidatePath
  }

  return undefined
}

function resolveSkillContent(platform: SkillInstallPlatform, packageRoot: string): string {
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
  const registrationBlock = SKILL_REGISTRATION.trimStart()

  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, registrationBlock, 'utf8')
    return `CLAUDE.md -> created at ${claudeMdPath}`
  }

  const content = readFileSync(claudeMdPath, 'utf8')
  if (content.includes(SKILL_REGISTRATION_MARKER)) {
    return 'CLAUDE.md -> already registered (no change)'
  }

  const hasCurrentSection = content.includes(HOME_SECTION_MARKER)
  const cleanedContent = hasCurrentSection ? removeHomeSkillRegistration(content) : content.trimEnd()
  const nextContent = cleanedContent.length > 0 ? `${cleanedContent}\n\n${registrationBlock}` : registrationBlock
  writeFileSync(claudeMdPath, `${nextContent.trimEnd()}\n`, 'utf8')
  return hasCurrentSection ? `CLAUDE.md -> skill registration updated in ${claudeMdPath}` : `CLAUDE.md -> skill registered in ${claudeMdPath}`
}

function installClaudeHook(projectDir: string): string {
  const settingsPath = join(projectDir, '.claude', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  if (preToolUse.some((hook) => isRecord(hook) && hook.matcher === 'Glob|Grep' && JSON.stringify(hook).includes(SKILL_SLUG))) {
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
  const filtered = preToolUse.filter((hook) => !(isRecord(hook) && hook.matcher === 'Glob|Grep' && JSON.stringify(hook).includes(SKILL_SLUG)))

  if (filtered.length === preToolUse.length) {
    return undefined
  }

  hooks.PreToolUse = filtered
  writeJson(settingsPath, settings)
  return '.claude/settings.json -> PreToolUse hook removed'
}

function installGeminiHook(projectDir: string): string {
  const settingsPath = join(projectDir, '.gemini', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const beforeTool = ensureArray(hooks, 'BeforeTool')

  if (beforeTool.some((hook) => JSON.stringify(hook).includes(SKILL_SLUG))) {
    return '.gemini/settings.json -> BeforeTool hook already registered (no change)'
  }

  beforeTool.push(GEMINI_HOOK)
  writeJson(settingsPath, settings)
  return '.gemini/settings.json -> BeforeTool hook registered'
}

function uninstallGeminiHook(projectDir: string): string | undefined {
  const settingsPath = join(projectDir, '.gemini', 'settings.json')
  if (!existsSync(settingsPath)) {
    return undefined
  }

  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const beforeTool = ensureArray(hooks, 'BeforeTool')
  const filtered = beforeTool.filter((hook) => !JSON.stringify(hook).includes(SKILL_SLUG))

  if (filtered.length === beforeTool.length) {
    return undefined
  }

  hooks.BeforeTool = filtered
  writeJson(settingsPath, settings)
  return '.gemini/settings.json -> BeforeTool hook removed'
}

function installCodexHook(projectDir: string): string {
  const hooksPath = join(projectDir, '.codex', 'hooks.json')
  const hooksConfig = readJsonObject(hooksPath)
  const hooks = ensureRecord(hooksConfig, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  if (preToolUse.some((hook) => JSON.stringify(hook).includes(SKILL_SLUG))) {
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
  const filtered = preToolUse.filter((hook) => !JSON.stringify(hook).includes(SKILL_SLUG))

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
  const messages = ['.opencode/plugins/graphify-ts.js -> tool.execute.before hook written']

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
    messages.push('.opencode/plugins/graphify-ts.js -> removed')
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
  const fileLabel = sectionFileDisplayName(targetPath)

  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, section, 'utf8')
    return `graphify-ts section written to ${targetPath}`
  }

  const content = readFileSync(targetPath, 'utf8')
  if (content.includes(SECTION_MARKER)) {
    return `graphify-ts already configured in ${fileLabel}`
  }

  writeFileSync(targetPath, `${content.trimEnd()}\n\n${section}`, 'utf8')
  return `graphify-ts section written to ${targetPath}`
}

function removeSectionFromFile(targetPath: string): string {
  const fileLabel = sectionFileDisplayName(targetPath)

  if (!existsSync(targetPath)) {
    return `No ${fileLabel} found in current directory - nothing to do`
  }

  const content = readFileSync(targetPath, 'utf8')
  if (!content.includes(SECTION_MARKER)) {
    return `graphify-ts section not found in ${fileLabel} - nothing to do`
  }

  const cleaned = removeSection(content)
  if (cleaned.length > 0) {
    writeFileSync(targetPath, `${cleaned}\n`, 'utf8')
    return `graphify-ts section removed from ${targetPath}`
  }

  rmSync(targetPath, { force: true })
  return `${fileLabel} was empty after removal - deleted ${targetPath}`
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

export function installSkill(platform: SkillInstallPlatform, options: InstallSkillOptions = {}): string {
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
  messages.push('', 'Done. Open your AI coding assistant and type:', '', '  /graphify-ts .')
  return messages.join('\n')
}

export function uninstallSkill(platform: SkillInstallPlatform, options: Pick<InstallSkillOptions, 'homeDir'> = {}): string {
  const homeDir = resolve(options.homeDir ?? homedir())
  const destinationPath = join(homeDir, PLATFORM_CONFIG[platform].skillDestination)
  const messages: string[] = []

  const removalMessage = removeInstalledSkill(destinationPath, homeDir)
  if (removalMessage) {
    messages.push(removalMessage)
  }

  if (messages.length === 0) {
    return 'nothing to remove'
  }

  return messages.join('\n')
}

export function geminiInstall(projectDir = '.', options: InstallSkillOptions = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [installSkill('gemini', options), writeSection(join(resolvedProjectDir, 'GEMINI.md'), GEMINI_MD_SECTION), installGeminiHook(resolvedProjectDir)]
  messages.push('', 'Gemini CLI will now check the knowledge graph before answering', 'codebase questions and rebuild it after code changes.')
  return messages.join('\n')
}

export function geminiUninstall(projectDir = '.', options: Pick<InstallSkillOptions, 'homeDir'> = {}): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages: string[] = []
  const skillMessage = uninstallSkill('gemini', options)
  if (skillMessage !== 'nothing to remove') {
    messages.push(skillMessage)
  }
  messages.push(removeSectionFromFile(join(resolvedProjectDir, 'GEMINI.md')))
  const hookMessage = uninstallGeminiHook(resolvedProjectDir)
  if (hookMessage) {
    messages.push(hookMessage)
  }
  return messages.join('\n')
}

export function cursorInstall(projectDir = '.'): string {
  const rulePath = join(resolve(projectDir), CURSOR_RULE_RELATIVE_PATH)
  ensureParentDirectory(rulePath)

  if (existsSync(rulePath)) {
    return `graphify-ts Cursor rule already exists at ${rulePath} (no change)`
  }

  writeFileSync(rulePath, CURSOR_RULE, 'utf8')
  return `graphify-ts Cursor rule written to ${rulePath}`
}

export function cursorUninstall(projectDir = '.'): string {
  const rulePath = join(resolve(projectDir), CURSOR_RULE_RELATIVE_PATH)
  if (!existsSync(rulePath)) {
    return 'No graphify-ts Cursor rule found - nothing to do'
  }

  unlinkSync(rulePath)
  return `graphify-ts Cursor rule removed from ${rulePath}`
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
  const displayName = formatPlatformDisplayName(platform)
  const messages = [writeSection(join(resolvedProjectDir, 'AGENTS.md'), AGENTS_MD_SECTION)]

  if (platform === 'codex') {
    messages.push(installCodexHook(resolvedProjectDir))
  } else if (platform === 'opencode') {
    messages.push(...installOpencodePlugin(resolvedProjectDir))
  }

  messages.push('', `${displayName} will now check the knowledge graph before answering`, 'codebase questions and rebuild it after code changes.')
  if (platform !== 'codex' && platform !== 'opencode') {
    messages.push('', `Note: unlike Claude Code, there is no PreToolUse hook equivalent for ${displayName} - the AGENTS.md rules are the always-on mechanism.`)
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
