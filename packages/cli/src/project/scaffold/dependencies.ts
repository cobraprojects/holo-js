import { resolve } from 'node:path'
import { loadConfigDirectory, type SupportedDatabaseDriver } from '@holo-js/config'
import {
  ESBUILD_PACKAGE_VERSION,
  HOLO_PACKAGE_VERSION,
} from '../../metadata'
import { loadProjectConfig } from '../config'
import {
  AUTH_SOCIAL_PROVIDER_PACKAGE_NAMES,
  CACHE_CONFIG_FILE_NAMES,
  DB_DRIVER_PACKAGE_NAMES,
  type GeneratedProjectRegistry,
  type SupportedAuthSocialProvider,
  type SupportedCacheInstallerDriver,
  type SupportedQueueInstallerDriver,
  pathExists,
} from '../shared'
import {
  readTextFile,
  resolveFirstExistingPath,
  writeTextFile,
} from '../runtime'
import { loadGeneratedProjectRegistry } from '../registry'
import type { LoadedConfigWithCache } from './types'

const IOREDIS_PACKAGE_VERSION = '^5.4.2'

function normalizeDependencyMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, dependencyVersion]) => typeof dependencyVersion === 'string')
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

export async function readPackageJsonDependencyState(projectRoot: string): Promise<{
  packageJsonPath: string
  parsed: Record<string, unknown>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}> {
  const packageJsonPath = resolve(projectRoot, 'package.json')
  const existing = await readTextFile(packageJsonPath)
  if (!existing) {
    throw new Error(`Missing package.json in ${projectRoot}.`)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>
  } catch {
    throw new Error(`Invalid package.json in ${projectRoot}.`)
  }

  return {
    packageJsonPath,
    parsed,
    dependencies: normalizeDependencyMap(parsed.dependencies),
    devDependencies: normalizeDependencyMap(parsed.devDependencies),
  }
}

async function writePackageJsonDependencyState(
  packageJsonPath: string,
  parsed: Record<string, unknown>,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): Promise<void> {
  parsed.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  )

  if (Object.keys(devDependencies).length > 0) {
    parsed.devDependencies = Object.fromEntries(
      Object.entries(devDependencies).sort(([left], [right]) => left.localeCompare(right)),
    )
  } else {
    delete parsed.devDependencies
  }

  await writeTextFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`)
}

export function hasLoadedConfigFile(
  loadedFiles: readonly string[],
  configName: string,
): boolean {
  return loadedFiles.some((filePath) => {
    const normalizedPath = filePath.replaceAll('\\', '/')
    return normalizedPath.endsWith(`/config/${configName}.ts`)
      || normalizedPath.endsWith(`/config/${configName}.mts`)
      || normalizedPath.endsWith(`/config/${configName}.js`)
      || normalizedPath.endsWith(`/config/${configName}.mjs`)
      || normalizedPath.endsWith(`/config/${configName}.cts`)
      || normalizedPath.endsWith(`/config/${configName}.cjs`)
  })
}

export function inferDatabaseDriverFromUrl(value: string | undefined): SupportedDatabaseDriver | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://')) {
    return 'postgres'
  }

  if (normalized.startsWith('mysql://') || normalized.startsWith('mysql2://')) {
    return 'mysql'
  }

  if (
    normalized === ':memory:'
    || normalized.startsWith('file:')
    || normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.endsWith('.db')
    || normalized.endsWith('.sqlite')
    || normalized.endsWith('.sqlite3')
  ) {
    return 'sqlite'
  }

  return undefined
}

export function inferConnectionDriver(
  connection: {
    driver?: string
    url?: string
    filename?: string
  } | string,
): SupportedDatabaseDriver | undefined {
  if (typeof connection === 'string') {
    return inferDatabaseDriverFromUrl(connection)
  }

  const explicitDriver = connection.driver
  if (explicitDriver === 'sqlite' || explicitDriver === 'postgres' || explicitDriver === 'mysql') {
    return explicitDriver
  }

  return inferDatabaseDriverFromUrl(connection.url ?? connection.filename)
}

function registryHasJobs(
  registry: GeneratedProjectRegistry | undefined,
): boolean {
  return (registry?.jobs.length ?? 0) > 0
}

function registryHasEvents(
  registry: GeneratedProjectRegistry | undefined,
): boolean {
  return (registry?.events.length ?? 0) > 0
    || (registry?.listeners.length ?? 0) > 0
}

function registryHasBroadcastDefinitions(
  registry: GeneratedProjectRegistry | undefined,
): boolean {
  return (registry?.broadcast.length ?? 0) > 0
    || (registry?.channels.length ?? 0) > 0
}

function registryHasAuthorizationDefinitions(
  registry: GeneratedProjectRegistry | undefined,
): boolean {
  return (registry?.authorizationPolicies.length ?? 0) > 0
    || (registry?.authorizationAbilities.length ?? 0) > 0
}

function authConfigUsesSocialProviders(
  loaded: Awaited<ReturnType<typeof loadConfigDirectory>>,
): boolean {
  return Object.keys(loaded.auth.social).length > 0
}

function authConfigUsesWorkosProviders(
  loaded: Awaited<ReturnType<typeof loadConfigDirectory>>,
): boolean {
  return Object.keys(loaded.auth.workos).length > 0
}

function authConfigUsesClerkProviders(
  loaded: Awaited<ReturnType<typeof loadConfigDirectory>>,
): boolean {
  return Object.keys(loaded.auth.clerk).length > 0
}

function mailConfigUsesQueue(
  loaded: Awaited<ReturnType<typeof loadConfigDirectory>>,
): boolean {
  return loaded.mail.queue.queued
    || Object.values(loaded.mail.mailers).some(mailer => mailer.queue.queued)
}

async function projectHasAuthorizationScaffold(projectRoot: string): Promise<boolean> {
  const project = await loadProjectConfig(projectRoot)
  const policiesRoot = resolve(projectRoot, project.config.paths.authorizationPolicies ?? 'server/policies')
  const abilitiesRoot = resolve(projectRoot, project.config.paths.authorizationAbilities ?? 'server/abilities')

  return await pathExists(policiesRoot) || await pathExists(abilitiesRoot)
}

async function projectHasEventsScaffold(projectRoot: string): Promise<boolean> {
  const project = await loadProjectConfig(projectRoot)
  const eventsRoot = resolve(projectRoot, project.config.paths.events)
  const listenersRoot = resolve(projectRoot, project.config.paths.listeners)

  return await pathExists(eventsRoot) || await pathExists(listenersRoot)
}

export async function syncManagedDriverDependencies(
  projectRoot: string,
  registry?: GeneratedProjectRegistry,
): Promise<boolean> {
  const loaded = await loadConfigDirectory(projectRoot, {
    preferCache: false,
    processEnv: process.env,
  }) as LoadedConfigWithCache
  const discoveredRegistry = registry ?? await loadGeneratedProjectRegistry(projectRoot)
  const authConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'auth')
  const broadcastConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'broadcast')
  const cacheConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'cache')
  const mailConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'mail')
  const notificationsConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'notifications')
  const queueConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'queue')
  const securityConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'security')
  const sessionConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'session')
  const storageConfigured = hasLoadedConfigFile(loaded.loadedFiles, 'storage')
  const requiredPackages = new Set<string>()
  const hasAuthorizationScaffold = await projectHasAuthorizationScaffold(projectRoot)
  const hasEventsScaffold = await projectHasEventsScaffold(projectRoot)
  const {
    packageJsonPath,
    parsed,
    dependencies,
    devDependencies,
  } = await readPackageJsonDependencyState(projectRoot)
  const cachePackageInstalled = typeof dependencies['@holo-js/cache'] !== 'undefined'
    || typeof devDependencies['@holo-js/cache'] !== 'undefined'

  requiredPackages.add('@holo-js/core')

  for (const connection of Object.values(loaded.database.connections)) {
    const inferredDriver = inferConnectionDriver(connection)
    if (inferredDriver) {
      requiredPackages.add(DB_DRIVER_PACKAGE_NAMES[inferredDriver])
    }
  }

  if (authConfigured || sessionConfigured) {
    requiredPackages.add('@holo-js/session')
  }

  if (authConfigured || securityConfigured) {
    requiredPackages.add('@holo-js/security')
  }

  if (authConfigured) {
    requiredPackages.add('@holo-js/auth')

    if (authConfigUsesSocialProviders(loaded)) {
      requiredPackages.add('@holo-js/auth-social')

      for (const [providerName, provider] of Object.entries(loaded.auth.social)) {
        if (typeof provider.runtime === 'string' && provider.runtime.trim()) {
          continue
        }

        const builtinPackage = AUTH_SOCIAL_PROVIDER_PACKAGE_NAMES[providerName as SupportedAuthSocialProvider]
        if (builtinPackage) {
          requiredPackages.add(builtinPackage)
        }
      }
    }

    if (authConfigUsesWorkosProviders(loaded)) {
      requiredPackages.add('@holo-js/auth-workos')
    }

    if (authConfigUsesClerkProviders(loaded)) {
      requiredPackages.add('@holo-js/auth-clerk')
    }
  }

  if (mailConfigured) {
    requiredPackages.add('@holo-js/mail')
  }

  if (cacheConfigured || cachePackageInstalled) {
    requiredPackages.add('@holo-js/cache')
  }

  if (cacheConfigured) {
    const cacheDrivers = Object.values(loaded.cache.drivers)
    if (cacheDrivers.some(driver => driver.driver === 'redis')) {
      requiredPackages.add('@holo-js/cache-redis')
    }

    if (cacheDrivers.some(driver => driver.driver === 'database')) {
      requiredPackages.add('@holo-js/cache-db')
    }
  }

  if (notificationsConfigured) {
    requiredPackages.add('@holo-js/notifications')
  }

  if (broadcastConfigured || registryHasBroadcastDefinitions(discoveredRegistry)) {
    requiredPackages.add('@holo-js/broadcast')
  }

  if (registryHasAuthorizationDefinitions(discoveredRegistry) || hasAuthorizationScaffold) {
    requiredPackages.add('@holo-js/authorization')
  }

  if (registryHasEvents(discoveredRegistry) || hasEventsScaffold) {
    requiredPackages.add('@holo-js/events')
    requiredPackages.add('@holo-js/queue')
  }

  if (queueConfigured || registryHasJobs(discoveredRegistry) || mailConfigUsesQueue(loaded)) {
    requiredPackages.add('@holo-js/queue')

    if (queueConfigured) {
      const queueConnections = Object.values(loaded.queue.connections)
      if (queueConnections.some(connection => connection.driver === 'redis')) {
        requiredPackages.add('@holo-js/queue-redis')
      }

      if (
        queueConnections.some(connection => connection.driver === 'database')
        || loaded.queue.failed !== false
      ) {
        requiredPackages.add('@holo-js/queue-db')
      }
    }
  }

  if (
    Object.values(loaded.cache?.drivers ?? {}).some(driver => driver.driver === 'redis')
    || loaded.security?.rateLimit?.driver === 'redis'
    || Object.values(loaded.session?.stores ?? {}).some(store => store.driver === 'redis')
    || (loaded.broadcast?.worker != null && loaded.broadcast.worker.scaling !== false)
  ) {
    requiredPackages.add('ioredis')
  }

  if (storageConfigured) {
    requiredPackages.add('@holo-js/storage')

    if (Object.values(loaded.storage.disks).some(disk => disk.driver === 's3')) {
      requiredPackages.add('@holo-js/storage-s3')
    }
  }

  let changed = false
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const removableManagedPackages = new Set<string>([
    '@holo-js/core',
    ...Object.values(DB_DRIVER_PACKAGE_NAMES),
    '@holo-js/auth',
    '@holo-js/auth-clerk',
    '@holo-js/auth-social',
    '@holo-js/auth-workos',
    '@holo-js/authorization',
    '@holo-js/broadcast',
    '@holo-js/cache',
    '@holo-js/cache-db',
    '@holo-js/cache-redis',
    '@holo-js/events',
    '@holo-js/mail',
    '@holo-js/notifications',
    '@holo-js/queue',
    '@holo-js/queue-db',
    '@holo-js/queue-redis',
    '@holo-js/security',
    '@holo-js/session',
    '@holo-js/storage',
    '@holo-js/storage-s3',
    ...Object.values(AUTH_SOCIAL_PROVIDER_PACKAGE_NAMES),
    'ioredis',
  ])

  for (const packageName of requiredPackages) {
    const requiredVersion = packageName === 'ioredis'
      ? IOREDIS_PACKAGE_VERSION
      : nextVersion
    if (dependencies[packageName] !== requiredVersion || typeof devDependencies[packageName] !== 'undefined') {
      dependencies[packageName] = requiredVersion
      delete devDependencies[packageName]
      changed = true
    }
  }

  for (const packageName of removableManagedPackages) {
    if (requiredPackages.has(packageName)) {
      continue
    }

    if (typeof dependencies[packageName] !== 'undefined' || typeof devDependencies[packageName] !== 'undefined') {
      delete dependencies[packageName]
      delete devDependencies[packageName]
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertQueuePackageDependency(
  projectRoot: string,
  driver?: SupportedQueueInstallerDriver,
): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const queueConfigPath = await resolveFirstExistingPath(projectRoot, ['config/queue.ts', 'config/queue.mts', 'config/queue.js', 'config/queue.mjs', 'config/queue.cts', 'config/queue.cjs'])
  const loadedQueueConfig = queueConfigPath
    ? loadConfigDirectory(projectRoot, {
        preferCache: false,
        processEnv: process.env,
      }).then(config => config.queue)
        .catch(() => undefined)
    : Promise.resolve(undefined)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const nextEsbuildVersion = ESBUILD_PACKAGE_VERSION
  const queueConfig = typeof driver === 'undefined'
    ? await loadedQueueConfig
    : undefined
  const resolvedQueueDriver = driver && driver !== 'sync'
    ? driver
    : queueConfig?.connections[queueConfig.default]?.driver ?? driver
  const requiresQueueDb = resolvedQueueDriver === 'database'
    || (queueConfig?.failed ?? false) !== false
    || Object.values(queueConfig?.connections ?? {}).some(connection => connection.driver === 'database')
  const requiresQueueRedis = resolvedQueueDriver === 'redis'
    || Object.values(queueConfig?.connections ?? {}).some(connection => connection.driver === 'redis')
  const currentVersion = dependencies['@holo-js/queue']
  const currentQueueDbVersion = dependencies['@holo-js/queue-db']
  const currentQueueRedisVersion = dependencies['@holo-js/queue-redis']
  const currentDevVersion = devDependencies['@holo-js/queue']
  const currentDevQueueDbVersion = devDependencies['@holo-js/queue-db']
  const currentDevQueueRedisVersion = devDependencies['@holo-js/queue-redis']
  const currentEsbuildVersion = dependencies.esbuild
  const currentDevEsbuildVersion = devDependencies.esbuild

  if (
    currentVersion === nextVersion
    && (requiresQueueDb ? currentQueueDbVersion === nextVersion : typeof currentQueueDbVersion === 'undefined')
    && (requiresQueueRedis ? currentQueueRedisVersion === nextVersion : typeof currentQueueRedisVersion === 'undefined')
    && typeof currentDevVersion === 'undefined'
    && typeof currentDevQueueDbVersion === 'undefined'
    && typeof currentDevQueueRedisVersion === 'undefined'
    && currentEsbuildVersion === nextEsbuildVersion
    && typeof currentDevEsbuildVersion === 'undefined'
  ) {
    return false
  }

  dependencies['@holo-js/queue'] = nextVersion
  if (requiresQueueDb) {
    dependencies['@holo-js/queue-db'] = nextVersion
  } else {
    delete dependencies['@holo-js/queue-db']
  }
  if (requiresQueueRedis) {
    dependencies['@holo-js/queue-redis'] = nextVersion
  } else {
    delete dependencies['@holo-js/queue-redis']
  }
  dependencies.esbuild = nextEsbuildVersion
  delete devDependencies['@holo-js/queue']
  delete devDependencies['@holo-js/queue-db']
  delete devDependencies['@holo-js/queue-redis']
  delete devDependencies.esbuild

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertEventsPackageDependency(projectRoot: string): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const currentVersion = dependencies['@holo-js/events']
  const currentDevVersion = devDependencies['@holo-js/events']

  if (currentVersion === nextVersion && typeof currentDevVersion === 'undefined') {
    return false
  }

  dependencies['@holo-js/events'] = nextVersion
  delete devDependencies['@holo-js/events']

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertNotificationsPackageDependency(projectRoot: string): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const currentVersion = dependencies['@holo-js/notifications']
  const currentDevVersion = devDependencies['@holo-js/notifications']

  if (currentVersion === nextVersion && typeof currentDevVersion === 'undefined') {
    return false
  }

  dependencies['@holo-js/notifications'] = nextVersion
  delete devDependencies['@holo-js/notifications']
  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertMailPackageDependency(projectRoot: string): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const currentVersion = dependencies['@holo-js/mail']
  const currentDevVersion = devDependencies['@holo-js/mail']

  if (currentVersion === nextVersion && typeof currentDevVersion === 'undefined') {
    return false
  }

  dependencies['@holo-js/mail'] = nextVersion
  delete devDependencies['@holo-js/mail']
  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertSecurityPackageDependency(projectRoot: string): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const currentVersion = dependencies['@holo-js/security']
  const currentDevVersion = devDependencies['@holo-js/security']

  if (currentVersion === nextVersion && typeof currentDevVersion === 'undefined') {
    return false
  }

  dependencies['@holo-js/security'] = nextVersion
  delete devDependencies['@holo-js/security']
  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertCachePackageDependencies(
  projectRoot: string,
  driver: SupportedCacheInstallerDriver = 'file',
): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const cacheConfigPath = await resolveFirstExistingPath(projectRoot, CACHE_CONFIG_FILE_NAMES)
  const cacheConfig = cacheConfigPath
    ? await loadConfigDirectory(projectRoot, {
        preferCache: false,
        processEnv: process.env,
      }).then(config => (config as LoadedConfigWithCache).cache)
        .catch(() => undefined)
    : undefined
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const requiresCacheRedis = driver === 'redis'
    || Object.values(cacheConfig?.drivers ?? {}).some(connection => connection.driver === 'redis')
  const requiresCacheDb = driver === 'database'
    || Object.values(cacheConfig?.drivers ?? {}).some(connection => connection.driver === 'database')
  const currentVersion = dependencies['@holo-js/cache']
  const currentCacheDbVersion = dependencies['@holo-js/cache-db']
  const currentCacheRedisVersion = dependencies['@holo-js/cache-redis']
  const currentDevVersion = devDependencies['@holo-js/cache']
  const currentDevCacheDbVersion = devDependencies['@holo-js/cache-db']
  const currentDevCacheRedisVersion = devDependencies['@holo-js/cache-redis']

  if (
    currentVersion === nextVersion
    && (requiresCacheDb ? currentCacheDbVersion === nextVersion : typeof currentCacheDbVersion === 'undefined')
    && (requiresCacheRedis ? currentCacheRedisVersion === nextVersion : typeof currentCacheRedisVersion === 'undefined')
    && typeof currentDevVersion === 'undefined'
    && typeof currentDevCacheDbVersion === 'undefined'
    && typeof currentDevCacheRedisVersion === 'undefined'
  ) {
    return false
  }

  dependencies['@holo-js/cache'] = nextVersion
  if (requiresCacheDb) {
    dependencies['@holo-js/cache-db'] = nextVersion
  } else {
    delete dependencies['@holo-js/cache-db']
  }
  if (requiresCacheRedis) {
    dependencies['@holo-js/cache-redis'] = nextVersion
  } else {
    delete dependencies['@holo-js/cache-redis']
  }
  delete devDependencies['@holo-js/cache']
  delete devDependencies['@holo-js/cache-db']
  delete devDependencies['@holo-js/cache-redis']

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

export function detectProjectFrameworkFromPackageJson(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): 'next' | 'nuxt' | 'sveltekit' | undefined {
  if (dependencies.next || devDependencies.next) {
    return 'next'
  }

  if (dependencies.nuxt || devDependencies.nuxt) {
    return 'nuxt'
  }

  if (dependencies['@sveltejs/kit'] || devDependencies['@sveltejs/kit']) {
    return 'sveltekit'
  }

  return undefined
}

export async function upsertBroadcastPackageDependencies(projectRoot: string): Promise<{
  readonly updated: boolean
  readonly framework: 'next' | 'nuxt' | 'sveltekit' | undefined
}> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const framework = detectProjectFrameworkFromPackageJson(dependencies, devDependencies)
  let changed = false

  const requestedPackages = new Set<string>([
    '@holo-js/broadcast',
    '@holo-js/flux',
  ])

  if (framework === 'next') {
    requestedPackages.add('@holo-js/flux-react')
    requestedPackages.add('@holo-js/adapter-next')
  } else if (framework === 'nuxt') {
    requestedPackages.add('@holo-js/flux-vue')
    requestedPackages.add('@holo-js/adapter-nuxt')
  } else if (framework === 'sveltekit') {
    requestedPackages.add('@holo-js/flux-svelte')
    requestedPackages.add('@holo-js/adapter-sveltekit')
  }

  for (const packageName of requestedPackages) {
    if (dependencies[packageName] !== nextVersion || typeof devDependencies[packageName] !== 'undefined') {
      dependencies[packageName] = nextVersion
      delete devDependencies[packageName]
      changed = true
    }
  }

  if (!changed) {
    return {
      updated: false,
      framework,
    }
  }

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return {
    updated: true,
    framework,
  }
}

async function upsertAuthPackageDependencies(
  projectRoot: string,
  features: {
    readonly social?: boolean
    readonly socialProviders?: readonly SupportedAuthSocialProvider[]
    readonly workos?: boolean
    readonly clerk?: boolean
  } = {},
): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const socialEnabled = features.social === true || (features.socialProviders?.length ?? 0) > 0
  const requestedPackages = {
    '@holo-js/auth': true,
    '@holo-js/session': true,
    '@holo-js/auth-social': socialEnabled,
    '@holo-js/auth-workos': features.workos === true,
    '@holo-js/auth-clerk': features.clerk === true,
  } as const
  const requestedSocialProviders = new Set(features.socialProviders ?? (socialEnabled ? ['google'] : []))

  let changed = false

  for (const [packageName, enabled] of Object.entries(requestedPackages)) {
    const currentDependency = dependencies[packageName]
    const currentDevDependency = devDependencies[packageName]

    if (enabled) {
      if (currentDependency !== nextVersion || typeof currentDevDependency !== 'undefined') {
        dependencies[packageName] = nextVersion
        delete devDependencies[packageName]
        changed = true
      }
      continue
    }

    if (typeof currentDevDependency !== 'undefined') {
      delete devDependencies[packageName]
      changed = true
    }

    if (typeof currentDependency !== 'undefined') {
      delete dependencies[packageName]
      changed = true
    }
  }

  for (const [providerName, packageName] of Object.entries(AUTH_SOCIAL_PROVIDER_PACKAGE_NAMES)) {
    const enabled = requestedSocialProviders.has(providerName as SupportedAuthSocialProvider)
    const currentDependency = dependencies[packageName]
    const currentDevDependency = devDependencies[packageName]

    if (enabled) {
      if (currentDependency !== nextVersion || typeof currentDevDependency !== 'undefined') {
        dependencies[packageName] = nextVersion
        delete devDependencies[packageName]
        changed = true
      }
      continue
    }

    if (typeof currentDevDependency !== 'undefined') {
      delete devDependencies[packageName]
      changed = true
    }

    if (typeof currentDependency !== 'undefined') {
      delete dependencies[packageName]
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

async function upsertAuthorizationPackageDependency(projectRoot: string): Promise<boolean> {
  const { packageJsonPath, parsed, dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const nextVersion = `^${HOLO_PACKAGE_VERSION}`
  const currentVersion = dependencies['@holo-js/authorization']
  const currentDevVersion = devDependencies['@holo-js/authorization']

  if (currentVersion === nextVersion && typeof currentDevVersion === 'undefined') {
    return false
  }

  dependencies['@holo-js/authorization'] = nextVersion
  delete devDependencies['@holo-js/authorization']

  await writePackageJsonDependencyState(packageJsonPath, parsed, dependencies, devDependencies)
  return true
}

export {
  upsertAuthPackageDependencies,
  upsertAuthorizationPackageDependency,
  upsertCachePackageDependencies,
  upsertEventsPackageDependency,
  upsertMailPackageDependency,
  upsertNotificationsPackageDependency,
  upsertQueuePackageDependency,
  upsertSecurityPackageDependency,
}
