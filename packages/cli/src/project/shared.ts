import { stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import type { BuildOptions, BuildResult } from 'esbuild'
import type { SupportedDatabaseDriver } from '@holo-js/config'
import type { HoloAppCommand } from '../types'

export type ProjectModuleBundler = (options: BuildOptions) => Promise<BuildResult>

export type CliModelReference = {
  readonly definition: {
    readonly kind?: string
    readonly name: string
    readonly prunable?: unknown
  }
  prune(): Promise<number>
}

export type InactiveGeneratedModelModule = {
  readonly holoModelPendingSchema: true
}

export type DiscoveredAppCommand = {
  readonly sourcePath: string
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly usage?: string
  load(): Promise<HoloAppCommand>
}

export type GeneratedModelRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly prunable: boolean
}

export type GeneratedMigrationRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
}

export type GeneratedSeederRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
}

export type GeneratedCommandRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
  readonly usage?: string
}

export type GeneratedJobRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
}

export type GeneratedEventRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
}

export type GeneratedListenerRegistryEntry = {
  readonly sourcePath: string
  readonly id: string
  readonly eventNames: readonly string[]
  readonly exportName?: string
}

export type GeneratedBroadcastRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
  readonly channels: readonly {
    readonly type: 'public' | 'private' | 'presence'
    readonly pattern: string
  }[]
}

export type GeneratedChannelRegistryEntry = {
  readonly sourcePath: string
  readonly pattern: string
  readonly exportName?: string
  readonly type: 'private' | 'presence'
  readonly params: readonly string[]
  readonly whispers: readonly string[]
}

export type GeneratedAuthorizationPolicyRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
  readonly target: string
  readonly classActions: readonly string[]
  readonly recordActions: readonly string[]
}

export type GeneratedAuthorizationAbilityRegistryEntry = {
  readonly sourcePath: string
  readonly name: string
  readonly exportName?: string
}

export type GeneratedProjectRegistry = {
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

export type SupportedScaffoldFramework = 'nuxt' | 'next' | 'sveltekit'

export type SupportedScaffoldPackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn'

export type SupportedScaffoldStorageDisk = 'local' | 'public'
export type SupportedScaffoldOptionalPackage = 'storage' | 'events' | 'queue' | 'validation' | 'forms' | 'auth' | 'authorization' | 'notifications' | 'mail' | 'broadcast' | 'security' | 'cache'
export type SupportedQueueInstallerDriver = 'sync' | 'redis' | 'database'
export type SupportedCacheInstallerDriver = 'file' | 'redis' | 'database'
export type SupportedAuthSocialProvider = 'google' | 'github' | 'discord' | 'facebook' | 'apple' | 'linkedin'
export type AuthInstallerFeature = 'social' | 'workos' | 'clerk'

export type ProjectScaffoldOptions = {
  readonly projectName: string
  readonly framework: SupportedScaffoldFramework
  readonly databaseDriver: SupportedDatabaseDriver
  readonly packageManager: SupportedScaffoldPackageManager
  readonly storageDefaultDisk: SupportedScaffoldStorageDisk
  readonly optionalPackages?: readonly SupportedScaffoldOptionalPackage[]
}

export type QueueDiscoveryModule = {
  isQueueJobDefinition(value: unknown): boolean
  normalizeQueueJobDefinition(value: unknown): NormalizedDiscoveredQueueJob
}

export type EventsDiscoveryModule = {
  isEventDefinition(value: unknown): boolean
  isListenerDefinition(value: unknown): boolean
  normalizeEventDefinition(value: unknown): { name?: string }
  normalizeListenerDefinition(value: unknown): NormalizedDiscoveredListener
}

export type BroadcastDiscoveryModule = {
  isBroadcastDefinition(value: unknown): boolean
  isChannelDefinition(value: unknown): boolean
  broadcastInternals: {
    extractChannelPatternParamNames(pattern: string): readonly string[]
  }
}

export type AuthorizationDiscoveryModule = {
  isAuthorizationPolicyDefinition(value: unknown): boolean
  isAuthorizationAbilityDefinition(value: unknown): boolean
  authorizationInternals: {
    getAuthorizationRuntimeState(): {
      policiesByName: Map<string, unknown>
      abilitiesByName: Map<string, unknown>
    }
    unregisterPolicyDefinition?(name: string): void
    unregisterAbilityDefinition?(name: string): void
    resetAuthorizationRuntimeState?(): void
  }
}

export type NormalizedDiscoveredQueueJob = {
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
}

export type DiscoveryListenerReference = string | { readonly name?: string }

export type MinimalListenerDefinition = {
  readonly listensTo: readonly DiscoveryListenerReference[]
}

export type NormalizedDiscoveredListener = MinimalListenerDefinition & {
  readonly name?: string
}

export type QueueInstallResult = {
  readonly createdQueueConfig: boolean
  readonly updatedPackageJson: boolean
  readonly updatedEnv: boolean
  readonly updatedEnvExample: boolean
  readonly createdJobsDirectory: boolean
}

export type EventsInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdEventsDirectory: boolean
  readonly createdListenersDirectory: boolean
}

export type AuthInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdAuthConfig: boolean
  readonly createdSessionConfig: boolean
  readonly createdUserModel: boolean
  readonly createdMigrationFiles: readonly string[]
  readonly updatedEnv: boolean
  readonly updatedEnvExample: boolean
}

export type AuthorizationInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdPoliciesDirectory: boolean
  readonly createdAbilitiesDirectory: boolean
  readonly createdPoliciesReadme: boolean
  readonly createdAbilitiesReadme: boolean
}

export type NotificationsInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdNotificationsConfig: boolean
  readonly createdMigrationFiles: readonly string[]
}

export type MailInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdMailConfig: boolean
  readonly createdMailDirectory: boolean
}

export type SecurityInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdSecurityConfig: boolean
}

export type CacheInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdCacheConfig: boolean
  readonly createdRedisConfig: boolean
  readonly updatedEnv: boolean
  readonly updatedEnvExample: boolean
  readonly databaseDriver: boolean
}

export type BroadcastInstallResult = {
  readonly updatedPackageJson: boolean
  readonly createdBroadcastConfig: boolean
  readonly createdBroadcastDirectory: boolean
  readonly createdChannelsDirectory: boolean
  readonly createdBroadcastAuthRoute: boolean
  readonly createdFrameworkSetup: boolean
  readonly updatedEnv: boolean
  readonly updatedEnvExample: boolean
}

export const SUPPORTED_AUTH_SOCIAL_PROVIDERS = [
  'google',
  'github',
  'discord',
  'facebook',
  'apple',
  'linkedin',
] as const satisfies readonly SupportedAuthSocialProvider[]

export const AUTH_SOCIAL_PROVIDER_PACKAGE_NAMES = {
  google: '@holo-js/auth-social-google',
  github: '@holo-js/auth-social-github',
  discord: '@holo-js/auth-social-discord',
  facebook: '@holo-js/auth-social-facebook',
  apple: '@holo-js/auth-social-apple',
  linkedin: '@holo-js/auth-social-linkedin',
} as const satisfies Record<SupportedAuthSocialProvider, string>

export const APP_CONFIG_FILE_NAMES = [
  'config/app.ts',
  'config/app.mts',
  'config/app.js',
  'config/app.mjs',
] as const

export const DATABASE_CONFIG_FILE_NAMES = [
  'config/database.ts',
  'config/database.mts',
  'config/database.js',
  'config/database.mjs',
] as const

export const AUTH_CONFIG_FILE_NAMES = [
  'config/auth.ts',
  'config/auth.mts',
  'config/auth.js',
  'config/auth.mjs',
  'config/auth.cts',
  'config/auth.cjs',
] as const

export const SESSION_CONFIG_FILE_NAMES = [
  'config/session.ts',
  'config/session.mts',
  'config/session.js',
  'config/session.mjs',
  'config/session.cts',
  'config/session.cjs',
] as const

export const QUEUE_CONFIG_FILE_NAMES = [
  'config/queue.ts',
  'config/queue.mts',
  'config/queue.js',
  'config/queue.mjs',
] as const

export const REDIS_CONFIG_FILE_NAMES = [
  'config/redis.ts',
  'config/redis.mts',
  'config/redis.js',
  'config/redis.mjs',
  'config/redis.cts',
  'config/redis.cjs',
] as const

export const CACHE_CONFIG_FILE_NAMES = [
  'config/cache.ts',
  'config/cache.mts',
  'config/cache.js',
  'config/cache.mjs',
  'config/cache.cts',
  'config/cache.cjs',
] as const

export const NOTIFICATIONS_CONFIG_FILE_NAMES = [
  'config/notifications.ts',
  'config/notifications.mts',
  'config/notifications.js',
  'config/notifications.mjs',
  'config/notifications.cts',
  'config/notifications.cjs',
] as const

export const MAIL_CONFIG_FILE_NAMES = [
  'config/mail.ts',
  'config/mail.mts',
  'config/mail.js',
  'config/mail.mjs',
  'config/mail.cts',
  'config/mail.cjs',
] as const

export const SECURITY_CONFIG_FILE_NAMES = [
  'config/security.ts',
  'config/security.mts',
  'config/security.js',
  'config/security.mjs',
  'config/security.cts',
  'config/security.cjs',
] as const

export const BROADCAST_CONFIG_FILE_NAMES = [
  'config/broadcast.ts',
  'config/broadcast.mts',
  'config/broadcast.js',
  'config/broadcast.mjs',
  'config/broadcast.cts',
  'config/broadcast.cjs',
] as const

export const DB_DRIVER_PACKAGE_NAMES = {
  sqlite: '@holo-js/db-sqlite',
  postgres: '@holo-js/db-postgres',
  mysql: '@holo-js/db-mysql',
} as const satisfies Record<SupportedDatabaseDriver, string>

export const COMMAND_FILE_PATTERN = /\.(?:[cm]?ts|[cm]?js)$/
export const MIGRATION_NAME_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+$/
export const HOLO_RUNTIME_ROOT = join('.holo-js', 'runtime')
export const CLI_RUNTIME_ROOT = join(HOLO_RUNTIME_ROOT, 'cli')
export const GENERATED_ROOT = join('.holo-js', 'generated')
export const GENERATED_INDEX_PATH = join(GENERATED_ROOT, 'index.ts')
export const GENERATED_METADATA_PATH = join(GENERATED_ROOT, 'metadata.ts')
export const GENERATED_MODELS_PATH = join(GENERATED_ROOT, 'models.ts')
export const GENERATED_MIGRATIONS_PATH = join(GENERATED_ROOT, 'migrations.ts')
export const GENERATED_SEEDERS_PATH = join(GENERATED_ROOT, 'seeders.ts')
export const GENERATED_COMMANDS_PATH = join(GENERATED_ROOT, 'commands.ts')
export const GENERATED_JOBS_PATH = join(GENERATED_ROOT, 'jobs.ts')
export const GENERATED_EVENTS_PATH = join(GENERATED_ROOT, 'events.ts')
export const GENERATED_LISTENERS_PATH = join(GENERATED_ROOT, 'listeners.ts')
export const GENERATED_BROADCAST_PATH = join(GENERATED_ROOT, 'broadcast.ts')
export const GENERATED_CHANNELS_PATH = join(GENERATED_ROOT, 'channels.ts')
export const GENERATED_BROADCAST_MANIFEST_PATH = join(GENERATED_ROOT, 'broadcast-manifest.ts')
export const GENERATED_AUTHORIZATION_ROOT = join(GENERATED_ROOT, 'authorization')
export const GENERATED_AUTHORIZATION_REGISTRY_PATH = join(GENERATED_AUTHORIZATION_ROOT, 'registry.ts')
export const GENERATED_AUTHORIZATION_TYPES_PATH = join(GENERATED_AUTHORIZATION_ROOT, 'types.d.ts')
export const GENERATED_CONFIG_TYPES_PATH = join(GENERATED_ROOT, 'config.d.ts')
export const GENERATED_QUEUE_TYPES_PATH = join(GENERATED_ROOT, 'queue.d.ts')
export const GENERATED_EVENT_TYPES_PATH = join(GENERATED_ROOT, 'events.d.ts')
export const GENERATED_BROADCAST_TYPES_PATH = join(GENERATED_ROOT, 'broadcast.d.ts')
export const GENERATED_REGISTRY_JSON_PATH = join(GENERATED_ROOT, 'registry.json')
export const GENERATED_TSCONFIG_PATH = join(GENERATED_ROOT, 'tsconfig.json')
export const GENERATED_GITIGNORE_PATH = join(GENERATED_ROOT, '.gitignore')
export const GENERATED_SVELTE_HOOKS_PATH = join(GENERATED_ROOT, 'hooks.ts')
export const GENERATED_SVELTE_SERVER_HOOKS_PATH = join(GENERATED_ROOT, 'hooks.server.ts')
export const CONFIG_EXTENSION_PRIORITY = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'] as const
export const SUPPORTED_CONFIG_EXTENSIONS = new Set<string>(CONFIG_EXTENSION_PRIORITY)
export const SUPPORTED_SCAFFOLD_FRAMEWORKS = ['nuxt', 'next', 'sveltekit'] as const
export const SUPPORTED_SCAFFOLD_PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'] as const
export const SUPPORTED_SCAFFOLD_STORAGE_DISKS = ['local', 'public'] as const
export const SUPPORTED_SCAFFOLD_OPTIONAL_PACKAGES = ['storage', 'events', 'queue', 'validation', 'forms', 'auth', 'authorization', 'notifications', 'mail', 'broadcast', 'security', 'cache'] as const
export const SUPPORTED_QUEUE_INSTALLER_DRIVERS = ['sync', 'redis', 'database'] as const
export const SUPPORTED_CACHE_INSTALLER_DRIVERS = ['file', 'redis', 'database'] as const
export const HOLO_EVENT_DEFINITION_MARKER = Symbol.for('holo-js.events.definition')
export const HOLO_LISTENER_DEFINITION_MARKER = Symbol.for('holo-js.events.listener')

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function hasEventDefinitionMarker(value: unknown): boolean {
  return value !== null && typeof value === 'object' && HOLO_EVENT_DEFINITION_MARKER in value
}

export function hasListenerDefinitionMarker(value: unknown): boolean {
  return value !== null && typeof value === 'object' && HOLO_LISTENER_DEFINITION_MARKER in value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function isSupportedScaffoldFramework(value: string): value is SupportedScaffoldFramework {
  return (SUPPORTED_SCAFFOLD_FRAMEWORKS as readonly string[]).includes(value)
}

export function isSupportedScaffoldPackageManager(value: string): value is SupportedScaffoldPackageManager {
  return (SUPPORTED_SCAFFOLD_PACKAGE_MANAGERS as readonly string[]).includes(value)
}

export function isSupportedScaffoldStorageDisk(value: string): value is SupportedScaffoldStorageDisk {
  return (SUPPORTED_SCAFFOLD_STORAGE_DISKS as readonly string[]).includes(value)
}

export function isSupportedScaffoldOptionalPackage(value: string): value is SupportedScaffoldOptionalPackage {
  return (SUPPORTED_SCAFFOLD_OPTIONAL_PACKAGES as readonly string[]).includes(value)
}

export function normalizeScaffoldOptionalPackageName(value: string): string {
  const current = value.trim().toLowerCase()
  if (current === 'validate') {
    return 'validation'
  }

  if (current === 'form') {
    return 'forms'
  }

  return current
}

export function normalizeScaffoldOptionalPackages(
  value: readonly string[] | readonly SupportedScaffoldOptionalPackage[] | undefined,
): readonly SupportedScaffoldOptionalPackage[] {
  if (!value || value.length === 0) {
    return []
  }

  const normalized = new Set<SupportedScaffoldOptionalPackage>()
  for (const entry of value) {
    const current = normalizeScaffoldOptionalPackageName(entry)
    if (!isSupportedScaffoldOptionalPackage(current)) {
      throw new Error(
        `Unsupported optional package: ${entry}. Expected one of ${SUPPORTED_SCAFFOLD_OPTIONAL_PACKAGES.join(', ')}.`,
      )
    }

    normalized.add(current)
    if (current === 'forms') {
      normalized.add('validation')
    }
  }

  return [...normalized].sort((left, right) => left.localeCompare(right))
}

export function isSupportedQueueInstallerDriver(value: string): value is SupportedQueueInstallerDriver {
  return (SUPPORTED_QUEUE_INSTALLER_DRIVERS as readonly string[]).includes(value)
}

export function isSupportedCacheInstallerDriver(value: string): value is SupportedCacheInstallerDriver {
  return (SUPPORTED_CACHE_INSTALLER_DRIVERS as readonly string[]).includes(value)
}

export function sanitizePackageName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function makeProjectRelativePath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(relative(projectRoot, absolutePath))
}

export function resolveDefaultArtifactPath(
  projectRoot: string,
  relativeDir: string,
  fileName: string,
): string {
  return resolve(projectRoot, relativeDir, fileName)
}

export function stripFileExtension(filePath: string): string {
  return filePath.slice(0, filePath.length - extname(filePath).length)
}
