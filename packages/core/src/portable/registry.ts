import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_HOLO_PROJECT_PATHS } from '@holo-js/db'

export interface GeneratedModelRegistryEntry {
  readonly sourcePath: string
  readonly name: string
  readonly prunable: boolean
}

export interface GeneratedMigrationRegistryEntry {
  readonly sourcePath: string
  readonly name: string
}

export interface GeneratedSeederRegistryEntry {
  readonly sourcePath: string
  readonly name: string
}

export interface GeneratedCommandRegistryEntry {
  readonly sourcePath: string
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
  readonly usage?: string
}

export interface GeneratedJobRegistryEntry {
  readonly sourcePath: string
  readonly name: string
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
}

export interface GeneratedEventRegistryEntry {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
}

export interface GeneratedListenerRegistryEntry {
  readonly sourcePath: string
  readonly id: string
  readonly eventNames: readonly string[]
  readonly exportName?: string
}

export interface GeneratedProjectRegistry {
  readonly version: 1
  readonly generatedAt: string
  readonly paths: {
    readonly models: string
    readonly migrations: string
    readonly seeders: string
    readonly commands: string
    readonly jobs: string
    readonly events: string
    readonly listeners: string
    readonly generatedSchema: string
  }
  readonly models: readonly GeneratedModelRegistryEntry[]
  readonly migrations: readonly GeneratedMigrationRegistryEntry[]
  readonly seeders: readonly GeneratedSeederRegistryEntry[]
  readonly commands: readonly GeneratedCommandRegistryEntry[]
  readonly jobs: readonly GeneratedJobRegistryEntry[]
  readonly events: readonly GeneratedEventRegistryEntry[]
  readonly listeners: readonly GeneratedListenerRegistryEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeLegacyGeneratedProjectRegistry(value: Record<string, unknown>): void {
  const paths = isRecord(value.paths) ? value.paths : undefined
  if (paths && typeof paths.jobs !== 'string') {
    paths.jobs = DEFAULT_HOLO_PROJECT_PATHS.jobs
  }

  if (paths && typeof paths.events !== 'string') {
    paths.events = DEFAULT_HOLO_PROJECT_PATHS.events
  }

  if (paths && typeof paths.listeners !== 'string') {
    paths.listeners = DEFAULT_HOLO_PROJECT_PATHS.listeners
  }

  if (!Array.isArray(value.jobs)) {
    value.jobs = []
  }

  if (!Array.isArray(value.events)) {
    value.events = []
  }

  if (!Array.isArray(value.listeners)) {
    value.listeners = []
  }
}

function isGeneratedProjectRegistry(value: unknown): value is GeneratedProjectRegistry {
  if (!isRecord(value)) {
    return false
  }

  normalizeLegacyGeneratedProjectRegistry(value)
  return value.version === 1
    && isRecord(value.paths)
    && Array.isArray(value.models)
    && Array.isArray(value.migrations)
    && Array.isArray(value.seeders)
    && Array.isArray(value.commands)
    && Array.isArray(value.jobs)
    && Array.isArray(value.events)
    && Array.isArray(value.listeners)
}

export function resolveGeneratedProjectRegistryPath(projectRoot: string): string {
  return resolve(projectRoot, '.holo-js', 'generated', 'registry.json')
}

export async function loadGeneratedProjectRegistry(
  projectRoot: string,
): Promise<GeneratedProjectRegistry | undefined> {
  const filePath = resolveGeneratedProjectRegistryPath(projectRoot)
  const contents = await readFile(filePath, 'utf8').catch(() => undefined)
  if (!contents) {
    return undefined
  }

  try {
    const parsed = JSON.parse(contents) as unknown
    return isGeneratedProjectRegistry(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const registryInternals = {
  isGeneratedProjectRegistry,
  normalizeLegacyGeneratedProjectRegistry,
}
