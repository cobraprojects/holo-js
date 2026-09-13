import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUPPORTED_AGENT_SKILL_TARGETS = [
  'codex',
  'claude',
  'cursor',
  'windsurf',
  'opencode',
  'gemini',
  'kiro',
] as const

export type SupportedAgentSkillTarget = typeof SUPPORTED_AGENT_SKILL_TARGETS[number]

export type InstallAgentSkillsOptions = {
  readonly agents: readonly SupportedAgentSkillTarget[]
  readonly global?: boolean
  readonly force?: boolean
}

export type AgentSkillInstallResult = {
  readonly agent: SupportedAgentSkillTarget
  readonly path: string
  readonly status: 'created' | 'updated' | 'unchanged'
}

type AgentSkillFile = {
  readonly relativePath: string
  readonly contents: string
}

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PACKAGED_SKILL_ROOTS = [
  resolve(MODULE_DIRECTORY, '../skills/holo-js'),
  resolve(MODULE_DIRECTORY, '../../skills/holo-js'),
] as const

function agentRoot(agent: SupportedAgentSkillTarget): string {
  if (agent === 'claude') return '.claude'
  if (agent === 'opencode') return '.opencode'
  return `.${agent}`
}

function resolveAgentSkillDirectory(root: string, agent: SupportedAgentSkillTarget): string {
  return resolve(root, agentRoot(agent), 'skills/holo-js')
}

function resolveGlobalAgentSkillDirectory(agent: SupportedAgentSkillTarget): string {
  if (agent === 'opencode') {
    return resolve(homedir(), '.config/opencode/skills/holo-js')
  }
  return resolveAgentSkillDirectory(homedir(), agent)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === code
}

async function collectSkillFiles(root: string, directory = root): Promise<readonly AgentSkillFile[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(entries.map(async (entry): Promise<readonly AgentSkillFile[]> => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) return await collectSkillFiles(root, path)
    if (!entry.isFile()) throw new Error(`Unsupported skill entry: ${path}`)

    return [{
      relativePath: relative(root, path),
      contents: await readFile(path, 'utf8'),
    }]
  }))

  return nestedFiles
    .flat()
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function collectExistingSkillFiles(root: string): Promise<readonly AgentSkillFile[]> {
  try {
    return await collectSkillFiles(root)
  }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return []
    throw error
  }
}

async function collectPackagedSkillFiles(): Promise<readonly AgentSkillFile[]> {
  for (const root of PACKAGED_SKILL_ROOTS) {
    try {
      return await collectSkillFiles(root)
    }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error
    }
  }

  throw new Error('The packaged Holo-JS skill tree could not be found.')
}

function skillTreesMatch(
  installedFiles: readonly AgentSkillFile[],
  packagedFiles: readonly AgentSkillFile[],
): boolean {
  if (installedFiles.length !== packagedFiles.length) return false

  return packagedFiles.every((packagedFile, index) => {
    const installedFile = installedFiles[index]
    return installedFile?.relativePath === packagedFile.relativePath
      && installedFile.contents === packagedFile.contents
  })
}

async function writeSkillTree(
  targetRoot: string,
  packagedFiles: readonly AgentSkillFile[],
): Promise<void> {
  await rm(targetRoot, { recursive: true, force: true })

  for (const file of packagedFiles) {
    const path = join(targetRoot, file.relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.contents, 'utf8')
  }
}

export function normalizeAgentSkillTargets(
  values: readonly string[],
): SupportedAgentSkillTarget[] {
  const requested = (values.length > 0 ? values : ['all'])
    .flatMap(value => value.split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  const agents = new Set<SupportedAgentSkillTarget>()

  for (const value of requested) {
    if (value === 'all') {
      for (const agent of SUPPORTED_AGENT_SKILL_TARGETS) agents.add(agent)
      continue
    }

    if (!SUPPORTED_AGENT_SKILL_TARGETS.includes(value as SupportedAgentSkillTarget)) {
      throw new Error(`Unsupported agent skill target: ${value}.`)
    }

    agents.add(value as SupportedAgentSkillTarget)
  }

  return [...agents]
}

export async function installAgentSkills(
  projectRoot: string,
  options: InstallAgentSkillsOptions,
): Promise<readonly AgentSkillInstallResult[]> {
  const packagedFiles = await collectPackagedSkillFiles()
  const results: AgentSkillInstallResult[] = []

  for (const agent of options.agents) {
    const targetRoot = options.global
      ? resolveGlobalAgentSkillDirectory(agent)
      : resolveAgentSkillDirectory(projectRoot, agent)
    const installedFiles = await collectExistingSkillFiles(targetRoot)

    if (skillTreesMatch(installedFiles, packagedFiles)) {
      results.push({ agent, path: join(targetRoot, 'SKILL.md'), status: 'unchanged' })
      continue
    }

    if (installedFiles.length > 0 && !options.force) {
      throw new Error(
        `Refusing to overwrite existing ${agent} skill at ${join(targetRoot, 'SKILL.md')}. Use --force to replace it.`,
      )
    }

    await writeSkillTree(targetRoot, packagedFiles)
    results.push({
      agent,
      path: join(targetRoot, 'SKILL.md'),
      status: installedFiles.length > 0 ? 'updated' : 'created',
    })
  }

  return results
}
