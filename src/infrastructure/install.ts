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

// Cross-platform hook: base64-encodes JSON payloads so the node -e command has
// zero special shell characters. Works on macOS, Linux, and Windows (PowerShell/CMD).
function hookCommand(payloadJson: string): string {
  const b64 = Buffer.from(payloadJson).toString('base64')
  return `node -e "try{require('fs').accessSync('graphify-out/graph.json');process.stdout.write(Buffer.from('${b64}','base64').toString())}catch(e){}"`
}

function hookCommandWithFallback(matchJson: string, missJson: string): string {
  const b64Match = Buffer.from(matchJson).toString('base64')
  const b64Miss = Buffer.from(missJson).toString('base64')
  return `node -e "var f;try{require('fs').accessSync('graphify-out/graph.json');f='${b64Match}'}catch(e){f='${b64Miss}'}process.stdout.write(Buffer.from(f,'base64').toString())"`
}

const RETRIEVE_FIRST_MESSAGE =
  'STOP. This project has a graphify-ts knowledge graph. Call mcp__graphify-ts__retrieve FIRST before using Glob, Grep, Bash, Read, or Agent tools. Graphify answers most codebase questions in 1 retrieve call instead of 5–10 sequential file reads (3x fewer turns, ~2.8x faster on a real production codebase). Only fall back to raw file tools if retrieve returns no relevant nodes.'

const SETTINGS_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  matcher: 'Glob|Grep|Bash|Agent|Read',
  hooks: [
    {
      type: 'command',
      command: hookCommand(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: RETRIEVE_FIRST_MESSAGE,
          },
        }),
      ),
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
            command: hookCommand(
              JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'allow',
                },
                systemMessage: RETRIEVE_FIRST_MESSAGE,
              }),
            ),
          },
        ],
      },
    ],
  },
}

const GEMINI_HOOK = {
  // SECURITY: Keep this command static. Do not interpolate user-controlled input here.
  matcher: 'read_file|list_directory|search_for_pattern',
  hooks: [
    {
      type: 'command',
      command: hookCommandWithFallback(
        JSON.stringify({
          decision: 'allow',
          additionalContext: RETRIEVE_FIRST_MESSAGE,
        }),
        JSON.stringify({ decision: 'allow' }),
      ),
    },
  ],
}

const SKILL_REGISTRATION =
  `\n${HOME_SECTION_MARKER}\n` +
  `- **${SKILL_SLUG}** (\`~/.claude/skills/${SKILL_SLUG}/SKILL.md\`) - any input to knowledge graph. Trigger: \`${SKILL_COMMAND}\`\n` +
  `When the user types \`${SKILL_COMMAND}\`, invoke the Skill tool with \`skill: "${SKILL_SLUG}"\` before doing anything else.\n`

const CLAUDE_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a graphify-ts knowledge graph. You MUST follow these rules:

1. **BEFORE answering ANY codebase question**, call the \`retrieve\` MCP tool with your question and a token budget (default 3000). Do NOT use Glob, Grep, Bash, Read, or dispatch Agent/Explore subagents to search the codebase until you have called retrieve first.
2. **Only fall back to raw file tools** if retrieve returns no relevant results or the MCP server is unavailable. In that case, read graphify-out/GRAPH_REPORT.md first.
3. **For impact analysis** ("what breaks if I change X?"), use the \`impact\` MCP tool.
4. **Do NOT dispatch Explore or research agents** for codebase questions — the knowledge graph already has the structural context they would spend tokens discovering.
`

const AGENTS_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a graphify-ts knowledge graph. You MUST follow these rules:

1. **BEFORE answering ANY codebase question**, call the \`retrieve\` MCP tool with your question and a token budget (default 3000). Do NOT search the codebase with other tools until you have called retrieve first.
2. **Only fall back to raw file tools** if retrieve returns no relevant results or the MCP server is unavailable. In that case, read graphify-out/GRAPH_REPORT.md first.
3. **For impact analysis** ("what breaks if I change X?"), use the \`impact\` MCP tool.
`

const GEMINI_MD_SECTION = `${SECTION_MARKER}

IMPORTANT: This project has a graphify-ts knowledge graph. You MUST follow these rules:

1. **BEFORE answering ANY codebase question**, call the \`retrieve\` MCP tool with your question and a token budget (default 3000). Do NOT search the codebase with other tools until you have called retrieve first.
2. **Only fall back to raw file tools** if retrieve returns no relevant results or the MCP server is unavailable. In that case, read graphify-out/GRAPH_REPORT.md first.
3. **For impact analysis** ("what breaks if I change X?"), use the \`impact\` MCP tool.
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
description: graphify-ts knowledge graph — MUST use retrieve MCP tool before searching files
alwaysApply: true
---

IMPORTANT: This project has a graphify-ts knowledge graph.

1. **BEFORE answering ANY codebase question**, call the \`retrieve\` MCP tool with your question and a token budget (default 3000). Do NOT search the codebase with other tools until you have called retrieve first.
2. **Only fall back to raw file tools** if retrieve returns no relevant results or the MCP server is unavailable. In that case, read graphify-out/GRAPH_REPORT.md first.
3. **For impact analysis** ("what breaks if I change X?"), use the \`impact\` MCP tool.
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

type McpConfigTarget = 'claude' | 'cursor' | 'copilot'
const NPM_PACKAGE_NAME = '@mohammednagy/graphify-ts'

const MCP_CONFIG_PATHS: Record<McpConfigTarget, string> = {
  claude: '.mcp.json',
  cursor: join('.cursor', 'mcp.json'),
  copilot: join('.vscode', 'mcp.json'),
}

function installPackageSpecifier(packageRoot = findPackageRoot()): string {
  const version = readPackageVersion(packageRoot)
  if (version === 'unknown') {
    throw new Error(`Could not determine graphify-ts package version from ${join(packageRoot, 'package.json')}`)
  }

  return `${NPM_PACKAGE_NAME}@${version}`
}

function installMcpServer(projectDir: string, target: McpConfigTarget = 'claude', nodePlatform = process.platform): string {
  const mcpJsonPath = join(projectDir, MCP_CONFIG_PATHS[target])
  ensureParentDirectory(mcpJsonPath)
  const mcpConfig = readJsonObject(mcpJsonPath)

  const graphPath = join(projectDir, 'graphify-out', 'graph.json')
  const isVscode = target === 'copilot'
  // Use npx.cmd on Windows so MCP server starts without a shell wrapper.
  // --yes skips the interactive install prompt that hangs in stdio mode.
  // Scoped name ensures npx resolves the package on first run.
  const npxCommand = nodePlatform === 'win32' ? 'npx.cmd' : 'npx'
  const npxArgs = ['--yes', installPackageSpecifier(), 'serve', '--stdio', graphPath]
  // Default to the lean MCP tool surface ("core" = 6 tools). Reduces cache_creation
  // overhead per session vs. advertising all tools. Users can opt into the legacy
  // 21-tool surface by setting GRAPHIFY_TOOL_PROFILE=full in this env block.
  const env = { GRAPHIFY_TOOL_PROFILE: 'core' }
  const serverConfig = isVscode
    ? { type: 'stdio', command: npxCommand, args: npxArgs, env }
    : { command: npxCommand, args: npxArgs, env }

  // VS Code uses "servers" key, Claude/Cursor use "mcpServers"
  const serversKey = isVscode ? 'servers' : 'mcpServers'
  const mcpServers = ensureRecord(mcpConfig, serversKey)

  const existed = isRecord(mcpServers[SKILL_SLUG])
  mcpServers[SKILL_SLUG] = serverConfig
  writeJson(mcpJsonPath, mcpConfig)

  // Clean up legacy mcpServers from .claude/settings.json if present
  if (target === 'claude') {
    const legacySettingsPath = join(projectDir, '.claude', 'settings.json')
    if (existsSync(legacySettingsPath)) {
      const legacySettings = readJsonObject(legacySettingsPath)
      if (isRecord(legacySettings.mcpServers) && Object.hasOwn(legacySettings.mcpServers, SKILL_SLUG)) {
        delete (legacySettings.mcpServers as Record<string, unknown>)[SKILL_SLUG]
        writeJson(legacySettingsPath, legacySettings)
      }
    }
  }

  const displayPath = MCP_CONFIG_PATHS[target]
  return existed ? `${displayPath} -> MCP server updated` : `${displayPath} -> MCP server registered`
}

function installClaudeHook(projectDir: string): string {
  const settingsPath = join(projectDir, '.claude', 'settings.json')
  const settings = readJsonObject(settingsPath)
  const hooks = ensureRecord(settings, 'hooks')
  const preToolUse = ensureArray(hooks, 'PreToolUse')

  const existingIndex = preToolUse.findIndex((hook) => isRecord(hook) && JSON.stringify(hook).includes('graphify-out'))
  if (existingIndex >= 0) {
    preToolUse[existingIndex] = SETTINGS_HOOK
    writeJson(settingsPath, settings)
    return '.claude/settings.json -> hook updated'
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
  const filtered = preToolUse.filter((hook) => !(isRecord(hook) && JSON.stringify(hook).includes('graphify-out')))

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

  if (beforeTool.some((hook) => JSON.stringify(hook).includes('graphify-out'))) {
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
  const filtered = beforeTool.filter((hook) => !JSON.stringify(hook).includes('graphify-out'))

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

  if (preToolUse.some((hook) => JSON.stringify(hook).includes('graphify-out'))) {
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
  const filtered = preToolUse.filter((hook) => !JSON.stringify(hook).includes('graphify-out'))

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
    const cleaned = removeSection(content).trimEnd()
    const updated = cleaned.length > 0 ? `${cleaned}\n\n${section}` : section
    writeFileSync(targetPath, updated, 'utf8')
    return `graphify-ts section updated in ${targetPath}`
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

export function installCopilotMcp(projectDir = '.'): string {
  return installMcpServer(resolve(projectDir), 'copilot')
}

export function cursorInstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const rulePath = join(resolvedProjectDir, CURSOR_RULE_RELATIVE_PATH)
  ensureParentDirectory(rulePath)

  const messages: string[] = []

  if (existsSync(rulePath)) {
    messages.push(`graphify-ts Cursor rule already exists at ${rulePath} (no change)`)
  } else {
    writeFileSync(rulePath, CURSOR_RULE, 'utf8')
    messages.push(`graphify-ts Cursor rule written to ${rulePath}`)
  }

  messages.push(installMcpServer(resolvedProjectDir, 'cursor'))
  return messages.join('\n')
}

export function cursorUninstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages: string[] = []
  const rulePath = join(resolvedProjectDir, CURSOR_RULE_RELATIVE_PATH)

  if (existsSync(rulePath)) {
    unlinkSync(rulePath)
    messages.push(`graphify-ts Cursor rule removed from ${rulePath}`)
  } else {
    messages.push('No graphify-ts Cursor rule found - nothing to do')
  }

  const mcpJsonPath = join(resolvedProjectDir, MCP_CONFIG_PATHS.cursor)
  if (existsSync(mcpJsonPath)) {
    const mcpConfig = readJsonObject(mcpJsonPath)
    if (isRecord(mcpConfig.mcpServers) && Object.hasOwn(mcpConfig.mcpServers, SKILL_SLUG)) {
      delete (mcpConfig.mcpServers as Record<string, unknown>)[SKILL_SLUG]
      writeJson(mcpJsonPath, mcpConfig)
      messages.push('.cursor/mcp.json -> MCP server removed')
    }
  }

  return messages.join('\n')
}

export function claudeInstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [writeSection(join(resolvedProjectDir, 'CLAUDE.md'), CLAUDE_MD_SECTION), installClaudeHook(resolvedProjectDir), installMcpServer(resolvedProjectDir)]
  messages.push('', 'Claude Code will now call the retrieve MCP tool BEFORE', 'searching raw files for any codebase question.')
  return messages.join('\n')
}

export function claudeUninstall(projectDir = '.'): string {
  const resolvedProjectDir = resolve(projectDir)
  const messages = [removeSectionFromFile(join(resolvedProjectDir, 'CLAUDE.md'))]
  const hookMessage = uninstallClaudeHook(resolvedProjectDir)
  if (hookMessage) {
    messages.push(hookMessage)
  }

  const mcpJsonPath = join(resolvedProjectDir, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    const mcpConfig = readJsonObject(mcpJsonPath)
    if (isRecord(mcpConfig.mcpServers) && Object.hasOwn(mcpConfig.mcpServers, SKILL_SLUG)) {
      delete (mcpConfig.mcpServers as Record<string, unknown>)[SKILL_SLUG]
      writeJson(mcpJsonPath, mcpConfig)
      messages.push('.mcp.json -> MCP server removed')
    }
  }

  // Clean up legacy location
  const settingsPath = join(resolvedProjectDir, '.claude', 'settings.json')
  if (existsSync(settingsPath)) {
    const settings = readJsonObject(settingsPath)
    if (isRecord(settings.mcpServers) && Object.hasOwn(settings.mcpServers, SKILL_SLUG)) {
      delete (settings.mcpServers as Record<string, unknown>)[SKILL_SLUG]
      writeJson(settingsPath, settings)
    }
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
