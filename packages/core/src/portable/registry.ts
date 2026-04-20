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

export interface GeneratedBroadcastRegistryEntry {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
  readonly channels: readonly {
    readonly type: 'public' | 'private' | 'presence'
    readonly pattern: string
  }[]
}

export interface GeneratedChannelRegistryEntry {
  readonly sourcePath: string
  readonly pattern: string
  readonly exportName?: string
  readonly type: 'private' | 'presence'
  readonly params: readonly string[]
  readonly whispers: readonly string[]
}

export interface GeneratedAuthorizationPolicyRegistryEntry {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
  readonly target: string
  readonly classActions: readonly string[]
  readonly recordActions: readonly string[]
}

export interface GeneratedAuthorizationAbilityRegistryEntry {
  readonly sourcePath: string
  readonly name: string
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
  readonly broadcast: string
  readonly channels: string
  readonly authorizationPolicies: string
  readonly authorizationAbilities: string
  readonly generatedSchema: string
  }
  readonly models: readonly GeneratedModelRegistryEntry[]
  readonly migrations: readonly GeneratedMigrationRegistryEntry[]
  readonly seeders: readonly GeneratedSeederRegistryEntry[]
  readonly commands: readonly GeneratedCommandRegistryEntry[]
  readonly jobs: readonly GeneratedJobRegistryEntry[]
  readonly events: readonly GeneratedEventRegistryEntry[]
  readonly listeners: readonly GeneratedListenerRegistryEntry[]
  readonly broadcast: readonly GeneratedBroadcastRegistryEntry[]
  readonly channels: readonly GeneratedChannelRegistryEntry[]
  readonly authorizationPolicies: readonly GeneratedAuthorizationPolicyRegistryEntry[]
  readonly authorizationAbilities: readonly GeneratedAuthorizationAbilityRegistryEntry[]
}

export interface GeneratedBroadcastManifestEvent {
  readonly name: string
  readonly channels: readonly {
    readonly type: 'public' | 'private' | 'presence'
    readonly pattern: string
  }[]
}

export interface GeneratedBroadcastManifestChannel {
  readonly name: string
  readonly pattern: string
  readonly type: 'private' | 'presence'
  readonly params: readonly string[]
  readonly whispers: readonly string[]
  readonly member?: Readonly<Record<string, unknown>>
}

export interface GeneratedBroadcastManifest {
  readonly version: 1
  readonly generatedAt: string
  readonly events: readonly GeneratedBroadcastManifestEvent[]
  readonly channels: readonly GeneratedBroadcastManifestChannel[]
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

  if (paths && typeof paths.broadcast !== 'string') {
    paths.broadcast = 'server/broadcast'
  }

  if (paths && typeof paths.channels !== 'string') {
    paths.channels = 'server/channels'
  }

  if (paths && typeof paths.authorizationPolicies !== 'string') {
    paths.authorizationPolicies = 'server/policies'
  }

  if (paths && typeof paths.authorizationAbilities !== 'string') {
    paths.authorizationAbilities = 'server/abilities'
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

  if (!Array.isArray(value.broadcast)) {
    value.broadcast = []
  }

  if (!Array.isArray(value.channels)) {
    value.channels = []
  }

  if (!Array.isArray(value.authorizationPolicies)) {
    value.authorizationPolicies = []
  }

  if (!Array.isArray(value.authorizationAbilities)) {
    value.authorizationAbilities = []
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
    && Array.isArray(value.broadcast)
    && Array.isArray(value.channels)
    && Array.isArray(value.authorizationPolicies)
    && Array.isArray(value.authorizationAbilities)
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

export function createGeneratedBroadcastManifest(
  registry: Pick<GeneratedProjectRegistry, 'generatedAt' | 'broadcast' | 'channels'>,
): GeneratedBroadcastManifest {
  return Object.freeze({
    version: 1,
    generatedAt: registry.generatedAt,
    events: Object.freeze(registry.broadcast.map(entry => Object.freeze({
      name: entry.name,
      channels: Object.freeze(entry.channels.map(channel => Object.freeze({
        type: channel.type,
        pattern: channel.pattern,
      }))),
    }))),
    channels: Object.freeze(registry.channels.map(entry => Object.freeze({
      name: entry.pattern,
      pattern: entry.pattern,
      type: entry.type,
      params: Object.freeze([...entry.params]),
      whispers: Object.freeze([...entry.whispers]),
    }))),
  })
}

export async function loadGeneratedBroadcastManifest(
  projectRoot: string,
): Promise<GeneratedBroadcastManifest | undefined> {
  const registry = await loadGeneratedProjectRegistry(projectRoot)
  if (!registry) {
    return undefined
  }

  return createGeneratedBroadcastManifest(registry)
}

export const registryInternals = {
  createGeneratedBroadcastManifest,
  isGeneratedProjectRegistry,
  normalizeLegacyGeneratedProjectRegistry,
}
