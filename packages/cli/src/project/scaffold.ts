import { mkdir, readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import {
  loadProjectConfig,
  resolveGeneratedSchemaPath,
} from './config'
import {
  AUTH_CONFIG_FILE_NAMES,
  BROADCAST_CONFIG_FILE_NAMES,
  CACHE_CONFIG_FILE_NAMES,
  MAIL_CONFIG_FILE_NAMES,
  NOTIFICATIONS_CONFIG_FILE_NAMES,
  QUEUE_CONFIG_FILE_NAMES,
  SECURITY_CONFIG_FILE_NAMES,
  SESSION_CONFIG_FILE_NAMES,
  type AuthInstallResult,
  type AuthorizationInstallResult,
  type BroadcastInstallResult,
  type CacheInstallResult,
  type EventsInstallResult,
  type MailInstallResult,
  type NotificationsInstallResult,
  type QueueInstallResult,
  type SecurityInstallResult,
  type SupportedCacheInstallerDriver,
  type SupportedQueueInstallerDriver,
  isSupportedCacheInstallerDriver,
  isSupportedQueueInstallerDriver,
  normalizeScaffoldOptionalPackages,
  pathExists,
  sanitizePackageName,
} from './shared'
import {
  readTextFile,
  resolveFirstExistingPath,
  writeTextFile,
} from './runtime'
import {
  authFeaturesRequireConfigUpdate,
  canSafelyRewriteAuthConfig,
  detectAuthInstallFeaturesFromConfig,
  ensureRateLimitStorageIgnore,
  ensureRedisConfigFile,
  injectBroadcastAuthEndpoint,
  mergeInstalledAuthFeatures,
  renderAuthConfig,
  renderBroadcastConfig,
  renderBroadcastEnvFiles,
  renderCacheConfig,
  renderMailConfig,
  renderMediaConfig,
  renderNotificationsConfig,
  renderQueueConfig,
  renderRedisConfig,
  renderSecurityConfig,
  renderSessionConfig,
  renderStorageConfig,
  resolveBroadcastConfigTargetPath,
  resolveConfigModuleFormat,
  syncBroadcastAuthSupportAfterAuthInstall,
} from './scaffold/config-renderers'
import {
  detectProjectFrameworkFromPackageJson,
  hasLoadedConfigFile,
  inferConnectionDriver,
  inferDatabaseDriverFromUrl,
  readPackageJsonDependencyState,
  syncManagedDriverDependencies,
  upsertAuthPackageDependencies,
  upsertAuthorizationPackageDependency,
  upsertBroadcastPackageDependencies,
  upsertCachePackageDependencies,
  upsertEventsPackageDependency,
  upsertMailPackageDependency,
  upsertNotificationsPackageDependency,
  upsertQueuePackageDependency,
  upsertSecurityPackageDependency,
} from './scaffold/dependencies'
import {
  renderFrameworkFiles,
  renderFrameworkRunner,
  renderNextHoloHelper,
  renderScaffoldPackageJson,
  renderSvelteHoloHelper,
  resolvePackageManagerVersion,
  scaffoldProject,
} from './scaffold/framework'
import {
  createAuthMigrationFiles,
  createNotificationsMigrationFiles,
  normalizeScaffoldEnvSegments,
  renderAuthEnvFiles,
  renderAuthMigration,
  renderAuthUserModel,
  renderAuthorizationAbilitiesReadme,
  renderAuthorizationPoliciesReadme,
  renderCacheEnvFiles,
  renderEnvFileContents,
  renderNotificationsMigration,
  renderQueueEnvFiles,
  renderScaffoldAppConfig,
  renderScaffoldDatabaseConfig,
  renderScaffoldEnvFiles,
  resolveDefaultDatabaseUrl,
  resolveAuthUserModelSchemaImportPath,
  upsertEnvContents,
} from './scaffold/project-renderers'
import {
  renderScaffoldGitignore,
  renderScaffoldTsconfig,
  renderVSCodeSettings,
} from './scaffold/workspace-renderers'
import {
  AUTH_MIGRATION_SLUGS,
  type AuthInstallFeatures,
  type AuthMigrationSlug,
  type LoadedConfigWithCache,
} from './scaffold/types'

async function resolveExistingModelPath(modelsRoot: string, modelName: string): Promise<string | undefined> {
  const supportedExtensions = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs']

  for (const extension of supportedExtensions) {
    const candidate = resolve(modelsRoot, `${modelName}${extension}`)
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  return undefined
}

async function resolveExistingAuthMigrationFiles(migrationsRoot: string): Promise<Map<AuthMigrationSlug, string>> {
  const entries = await readdir(migrationsRoot).catch(() => [] as string[])
  const resolved = new Map<AuthMigrationSlug, string>()

  for (const entry of entries) {
    for (const slug of AUTH_MIGRATION_SLUGS) {
      if (
        entry.endsWith(`_${slug}.ts`)
        || entry.endsWith(`_${slug}.mts`)
        || entry.endsWith(`_${slug}.js`)
        || entry.endsWith(`_${slug}.mjs`)
        || entry.endsWith(`_${slug}.cts`)
        || entry.endsWith(`_${slug}.cjs`)
      ) {
        resolved.set(slug, resolve(migrationsRoot, entry))
      }
    }
  }

  return resolved
}

async function resolveExistingNotificationsMigrationFiles(migrationsRoot: string): Promise<readonly string[]> {
  const entries = await readdir(migrationsRoot).catch(() => [] as string[])

  return entries
    .filter(entry => (
      entry.endsWith('_create_notifications.ts')
      || entry.endsWith('_create_notifications.mts')
      || entry.endsWith('_create_notifications.js')
      || entry.endsWith('_create_notifications.mjs')
      || entry.endsWith('_create_notifications.cts')
      || entry.endsWith('_create_notifications.cjs')
    ))
    .map(entry => resolve(migrationsRoot, entry))
}

export async function installAuthIntoProject(
  projectRoot: string,
  features: AuthInstallFeatures = {},
): Promise<AuthInstallResult> {
  const project = await loadProjectConfig(projectRoot)
  const modelsRoot = resolve(projectRoot, project.config.paths.models)
  const migrationsRoot = resolve(projectRoot, project.config.paths.migrations)
  const defaultDatabaseConnection = project.config.database?.defaultConnection ?? 'default'
  const authConfigPath = await resolveFirstExistingPath(projectRoot, AUTH_CONFIG_FILE_NAMES)
  const sessionConfigPath = await resolveFirstExistingPath(projectRoot, SESSION_CONFIG_FILE_NAMES)
  const userModelPath = await resolveExistingModelPath(modelsRoot, 'User')
  const existingMigrationFiles = await resolveExistingAuthMigrationFiles(migrationsRoot)
  const hasAllAuthMigrations = AUTH_MIGRATION_SLUGS.every(slug => existingMigrationFiles.has(slug))
  const existingAuthArtifacts = [
    authConfigPath,
    userModelPath,
    ...AUTH_MIGRATION_SLUGS.map(slug => existingMigrationFiles.get(slug)),
  ].filter((value): value is string => typeof value === 'string')

  if (authConfigPath && userModelPath && hasAllAuthMigrations) {
    const envPath = resolve(projectRoot, '.env')
    const envExamplePath = resolve(projectRoot, '.env.example')
    const currentAuthConfig = (await readTextFile(authConfigPath)) ?? ''
    const currentAuthFeatures = detectAuthInstallFeaturesFromConfig(currentAuthConfig)
    const nextAuthFeatures = mergeInstalledAuthFeatures(currentAuthFeatures, features)
    const authConfigModuleFormat = resolveConfigModuleFormat(authConfigPath, currentAuthConfig)
    const nextAuthConfig = renderAuthConfig(nextAuthFeatures, authConfigModuleFormat)
    const authEnvFiles = renderAuthEnvFiles(nextAuthFeatures, defaultDatabaseConnection)
    const nextEnv = upsertEnvContents(await readTextFile(envPath), authEnvFiles.env)
    const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), authEnvFiles.example)
    const authConfigChanged = authFeaturesRequireConfigUpdate(features) && currentAuthConfig !== nextAuthConfig

    if (authConfigChanged) {
      if (!canSafelyRewriteAuthConfig(currentAuthConfig, currentAuthFeatures, authConfigModuleFormat)) {
        throw new Error(
          `Auth support is already installed in ${projectRoot}, but ${authConfigPath} contains manual changes. `
          + 'Refusing to overwrite the existing auth config automatically.',
        )
      }
      await writeTextFile(authConfigPath, nextAuthConfig)
    }

    if (nextEnv.changed && typeof nextEnv.contents === 'string') {
      await writeTextFile(envPath, nextEnv.contents)
    }

    if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
      await writeTextFile(envExamplePath, nextEnvExample.contents)
    }

    await syncBroadcastAuthSupportAfterAuthInstall(projectRoot)

    return {
      updatedPackageJson: await upsertAuthPackageDependencies(projectRoot, nextAuthFeatures),
      createdAuthConfig: authConfigChanged,
      createdSessionConfig: false,
      createdUserModel: false,
      createdMigrationFiles: [],
      updatedEnv: nextEnv.changed,
      updatedEnvExample: nextEnvExample.changed,
    }
  }

  const collisions = sessionConfigPath && existingAuthArtifacts.length === 0
    ? []
    : [
        ...existingAuthArtifacts,
        ...(sessionConfigPath && existingAuthArtifacts.length > 0 ? [sessionConfigPath] : []),
      ]

  if (collisions.length > 0) {
    throw new Error(
      `Auth support is partially installed. Refusing to overwrite existing files in ${projectRoot}: ${collisions.join(', ')}`,
    )
  }

  const authConfigTargetPath = resolve(projectRoot, 'config/auth.ts')
  const sessionConfigTargetPath = resolve(projectRoot, 'config/session.ts')
  const userModelTargetPath = resolve(modelsRoot, 'User.ts')
  const generatedSchemaPath = resolveGeneratedSchemaPath(projectRoot, project.config)
  const migrationFiles = createAuthMigrationFiles()
  const authEnvFiles = renderAuthEnvFiles(features, defaultDatabaseConnection)

  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(modelsRoot, { recursive: true })
  await mkdir(migrationsRoot, { recursive: true })
  await ensureRedisConfigFile(projectRoot)
  await writeTextFile(authConfigTargetPath, renderAuthConfig(features))
  if (!sessionConfigPath) {
    await writeTextFile(sessionConfigTargetPath, renderSessionConfig(defaultDatabaseConnection))
  }
  await writeTextFile(
    userModelTargetPath,
    renderAuthUserModel(resolveAuthUserModelSchemaImportPath(
      userModelTargetPath,
      generatedSchemaPath,
    )),
  )

  const createdMigrationFiles: string[] = []
  for (const migrationFile of migrationFiles) {
    const migrationPath = resolve(migrationsRoot, migrationFile.path)
    await writeTextFile(migrationPath, migrationFile.contents)
    createdMigrationFiles.push(migrationPath)
  }

  const envPath = resolve(projectRoot, '.env')
  const envExamplePath = resolve(projectRoot, '.env.example')
  const nextEnv = upsertEnvContents(await readTextFile(envPath), authEnvFiles.env)
  const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), authEnvFiles.example)

  if (nextEnv.changed && typeof nextEnv.contents === 'string') {
    await writeTextFile(envPath, nextEnv.contents)
  }

  if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
    await writeTextFile(envExamplePath, nextEnvExample.contents)
  }

  await syncBroadcastAuthSupportAfterAuthInstall(projectRoot)

  return {
    updatedPackageJson: await upsertAuthPackageDependencies(projectRoot, features),
    createdAuthConfig: true,
    createdSessionConfig: !sessionConfigPath,
    createdUserModel: true,
    createdMigrationFiles,
    updatedEnv: nextEnv.changed,
    updatedEnvExample: nextEnvExample.changed,
  }
}

export async function installAuthorizationIntoProject(
  projectRoot: string,
): Promise<AuthorizationInstallResult> {
  await loadProjectConfig(projectRoot, { required: true })
  const policiesRoot = resolve(projectRoot, 'server/policies')
  const abilitiesRoot = resolve(projectRoot, 'server/abilities')
  const policiesDirectoryExists = await pathExists(policiesRoot)
  const abilitiesDirectoryExists = await pathExists(abilitiesRoot)
  const policiesReadmePath = resolve(policiesRoot, 'README.md')
  const abilitiesReadmePath = resolve(abilitiesRoot, 'README.md')
  const policiesReadmeExists = await pathExists(policiesReadmePath)
  const abilitiesReadmeExists = await pathExists(abilitiesReadmePath)

  await mkdir(policiesRoot, { recursive: true })
  await mkdir(abilitiesRoot, { recursive: true })

  if (!policiesReadmeExists) {
    await writeTextFile(policiesReadmePath, renderAuthorizationPoliciesReadme())
  }

  if (!abilitiesReadmeExists) {
    await writeTextFile(abilitiesReadmePath, renderAuthorizationAbilitiesReadme())
  }

  return {
    updatedPackageJson: await upsertAuthorizationPackageDependency(projectRoot),
    createdPoliciesDirectory: !policiesDirectoryExists,
    createdAbilitiesDirectory: !abilitiesDirectoryExists,
    createdPoliciesReadme: !policiesReadmeExists,
    createdAbilitiesReadme: !abilitiesReadmeExists,
  }
}

export async function installQueueIntoProject(
  projectRoot: string,
  options: {
    readonly driver?: SupportedQueueInstallerDriver
  } = {},
): Promise<QueueInstallResult> {
  const driver = options.driver ?? 'sync'
  if (!isSupportedQueueInstallerDriver(driver)) {
    throw new Error(`Unsupported queue driver: ${driver}.`)
  }

  const project = await loadProjectConfig(projectRoot)
  const defaultDatabaseConnection = project.config.database?.defaultConnection ?? 'default'
  const queueConfigPath = await resolveFirstExistingPath(projectRoot, QUEUE_CONFIG_FILE_NAMES) ?? resolve(projectRoot, 'config/queue.ts')
  const queueConfigExists = await pathExists(queueConfigPath)
  const jobsRoot = resolve(projectRoot, project.config.paths.jobs)
  const jobsDirectoryExists = await pathExists(jobsRoot)
  const queueEnvFiles = renderQueueEnvFiles(driver)

  if (!queueConfigExists) {
    await writeTextFile(queueConfigPath, renderQueueConfig({
      driver,
      defaultDatabaseConnection,
    }))
  }

  if (driver === 'redis') {
    await ensureRedisConfigFile(projectRoot)
  }

  await mkdir(jobsRoot, { recursive: true })

  const updatedPackageJson = await upsertQueuePackageDependency(
    projectRoot,
    !queueConfigExists || driver !== 'sync' ? driver : undefined,
  )
  const envPath = resolve(projectRoot, '.env')
  const envExamplePath = resolve(projectRoot, '.env.example')
  const nextEnv = upsertEnvContents(await readTextFile(envPath), queueEnvFiles.env)
  const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), queueEnvFiles.example)

  if (nextEnv.changed && typeof nextEnv.contents === 'string') {
    await writeTextFile(envPath, nextEnv.contents)
  }

  if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
    await writeTextFile(envExamplePath, nextEnvExample.contents)
  }

  return {
    createdQueueConfig: !queueConfigExists,
    updatedPackageJson,
    updatedEnv: nextEnv.changed,
    updatedEnvExample: nextEnvExample.changed,
    createdJobsDirectory: !jobsDirectoryExists,
  }
}

export async function installEventsIntoProject(
  projectRoot: string,
): Promise<EventsInstallResult> {
  const project = await loadProjectConfig(projectRoot)
  const eventsRoot = resolve(projectRoot, project.config.paths.events)
  const listenersRoot = resolve(projectRoot, project.config.paths.listeners)
  const eventsDirectoryExists = await pathExists(eventsRoot)
  const listenersDirectoryExists = await pathExists(listenersRoot)

  await mkdir(eventsRoot, { recursive: true })
  await mkdir(listenersRoot, { recursive: true })

  return {
    updatedPackageJson: await upsertEventsPackageDependency(projectRoot),
    createdEventsDirectory: !eventsDirectoryExists,
    createdListenersDirectory: !listenersDirectoryExists,
  }
}

export async function installNotificationsIntoProject(
  projectRoot: string,
): Promise<NotificationsInstallResult> {
  const project = await loadProjectConfig(projectRoot)
  const migrationsRoot = resolve(projectRoot, project.config.paths.migrations)
  const notificationsConfigPath = await resolveFirstExistingPath(projectRoot, NOTIFICATIONS_CONFIG_FILE_NAMES)
  const existingMigrationFiles = await resolveExistingNotificationsMigrationFiles(migrationsRoot)

  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(migrationsRoot, { recursive: true })

  if (!notificationsConfigPath) {
    await writeTextFile(resolve(projectRoot, 'config/notifications.ts'), renderNotificationsConfig())
  }

  const createdMigrationFiles: string[] = []
  if (existingMigrationFiles.length === 0) {
    for (const migrationFile of createNotificationsMigrationFiles()) {
      const migrationPath = resolve(migrationsRoot, migrationFile.path)
      await writeTextFile(migrationPath, migrationFile.contents)
      createdMigrationFiles.push(migrationPath)
    }
  }

  return {
    updatedPackageJson: await upsertNotificationsPackageDependency(projectRoot),
    createdNotificationsConfig: !notificationsConfigPath,
    createdMigrationFiles,
  }
}

export async function installMailIntoProject(
  projectRoot: string,
): Promise<MailInstallResult> {
  await loadProjectConfig(projectRoot, { required: true })
  const mailConfigPath = await resolveFirstExistingPath(projectRoot, MAIL_CONFIG_FILE_NAMES)
  const mailRoot = resolve(projectRoot, 'server/mail')
  const mailDirectoryExists = await pathExists(mailRoot)

  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(mailRoot, { recursive: true })

  if (!mailConfigPath) {
    await writeTextFile(resolve(projectRoot, 'config/mail.ts'), renderMailConfig())
  }

  return {
    updatedPackageJson: await upsertMailPackageDependency(projectRoot),
    createdMailConfig: !mailConfigPath,
    createdMailDirectory: !mailDirectoryExists,
  }
}

export async function installSecurityIntoProject(
  projectRoot: string,
): Promise<SecurityInstallResult> {
  await loadProjectConfig(projectRoot, { required: true })
  const securityConfigPath = await resolveFirstExistingPath(projectRoot, SECURITY_CONFIG_FILE_NAMES)

  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await ensureRateLimitStorageIgnore(projectRoot)
  await ensureRedisConfigFile(projectRoot)

  if (!securityConfigPath) {
    await writeTextFile(resolve(projectRoot, 'config/security.ts'), renderSecurityConfig())
  }

  return {
    updatedPackageJson: await upsertSecurityPackageDependency(projectRoot),
    createdSecurityConfig: !securityConfigPath,
  }
}

export async function installCacheIntoProject(
  projectRoot: string,
  options: {
    readonly driver?: SupportedCacheInstallerDriver
  } = {},
): Promise<CacheInstallResult> {
  const project = await loadProjectConfig(projectRoot, { required: true })
  const driver = options.driver ?? 'file'
  if (!isSupportedCacheInstallerDriver(driver)) {
    throw new Error(`Unsupported cache driver: ${driver}.`)
  }

  const cacheConfigPath = await resolveFirstExistingPath(projectRoot, CACHE_CONFIG_FILE_NAMES)
  const loadedConfig = await loadConfigDirectory(projectRoot, {
    preferCache: false,
    processEnv: process.env,
  }) as LoadedConfigWithCache
  const defaultDatabaseConnection = project.config.database?.defaultConnection ?? 'default'
  const defaultRedisConnection = loadedConfig.redis.default
  const loadedCacheConfig = cacheConfigPath
    ? loadedConfig.cache
    : undefined

  if (
    loadedCacheConfig
    && !Object.values(loadedCacheConfig.drivers).some(entry => entry.driver === driver)
  ) {
    throw new Error(
      `config/cache.ts already exists and does not configure the "${driver}" cache driver. `
      + `Update your cache config first, then rerun "holo install cache".`,
    )
  }

  await mkdir(resolve(projectRoot, 'config'), { recursive: true })

  if (!cacheConfigPath) {
    await writeTextFile(
      resolve(projectRoot, 'config/cache.ts'),
      renderCacheConfig(driver, defaultDatabaseConnection, defaultRedisConnection),
    )
  }

  let createdRedisConfig = false
  if (driver === 'redis') {
    createdRedisConfig = await ensureRedisConfigFile(projectRoot)
  }

  const cacheEnvFiles = renderCacheEnvFiles(driver)
  const envPath = resolve(projectRoot, '.env')
  const envExamplePath = resolve(projectRoot, '.env.example')
  const nextEnv = upsertEnvContents(await readTextFile(envPath), cacheEnvFiles.env)
  const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), cacheEnvFiles.example)

  if (nextEnv.changed && typeof nextEnv.contents === 'string') {
    await writeTextFile(envPath, nextEnv.contents)
  }

  if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
    await writeTextFile(envExamplePath, nextEnvExample.contents)
  }

  return {
    updatedPackageJson: await upsertCachePackageDependencies(projectRoot, driver),
    createdCacheConfig: !cacheConfigPath,
    createdRedisConfig,
    updatedEnv: nextEnv.changed,
    updatedEnvExample: nextEnvExample.changed,
    databaseDriver: driver === 'database',
  }
}

export async function installBroadcastIntoProject(
  projectRoot: string,
): Promise<BroadcastInstallResult> {
  const project = await loadProjectConfig(projectRoot, { required: true })
  const manifestPath = project.manifestPath!
  const manifestContents = (await readTextFile(manifestPath))!
  const manifestFormat = resolveConfigModuleFormat(manifestPath, manifestContents)
  const broadcastConfigTargetPath = resolveBroadcastConfigTargetPath(projectRoot, manifestPath, manifestFormat)
  const broadcastConfigIsTypeScript = ['.ts', '.mts', '.cts'].includes(extname(broadcastConfigTargetPath))
  const broadcastConfigPath = await resolveFirstExistingPath(projectRoot, BROADCAST_CONFIG_FILE_NAMES)
  const authConfigPath = await resolveFirstExistingPath(projectRoot, AUTH_CONFIG_FILE_NAMES)
  const { dependencies, devDependencies } = await readPackageJsonDependencyState(projectRoot)
  const framework = detectProjectFrameworkFromPackageJson(dependencies, devDependencies)
  const canCreateBroadcastAuthRoute = framework === 'next' || framework === 'nuxt' || framework === 'sveltekit'
  const broadcastRoot = resolve(projectRoot, 'server/broadcast')
  const channelsRoot = resolve(projectRoot, 'server/channels')
  const broadcastDirectoryExists = await pathExists(broadcastRoot)
  const channelsDirectoryExists = await pathExists(channelsRoot)

  await mkdir(resolve(projectRoot, 'config'), { recursive: true })
  await mkdir(broadcastRoot, { recursive: true })
  await mkdir(channelsRoot, { recursive: true })
  await ensureRedisConfigFile(projectRoot)

  if (!broadcastConfigPath) {
    await writeTextFile(
      broadcastConfigTargetPath,
      renderBroadcastConfig(
        manifestFormat,
        Boolean(authConfigPath) && canCreateBroadcastAuthRoute,
        broadcastConfigIsTypeScript,
      ),
    )
  }

  const broadcastEnvFiles = renderBroadcastEnvFiles()
  const envPath = resolve(projectRoot, '.env')
  const envExamplePath = resolve(projectRoot, '.env.example')
  const nextEnv = upsertEnvContents(await readTextFile(envPath), broadcastEnvFiles.env)
  const nextEnvExample = upsertEnvContents(await readTextFile(envExamplePath), broadcastEnvFiles.example)

  const dependencyResult = await upsertBroadcastPackageDependencies(projectRoot)
  let createdFrameworkSetup = false

  if (framework === 'next') {
    const holoHelperPath = resolve(projectRoot, 'server/holo.ts')
    if (!(await pathExists(holoHelperPath))) {
      await writeTextFile(holoHelperPath, renderNextHoloHelper())
      createdFrameworkSetup = true
    }
  } else if (framework === 'sveltekit') {
    const holoHelperPath = resolve(projectRoot, 'src/lib/server/holo.ts')
    if (!(await pathExists(holoHelperPath))) {
      await writeTextFile(holoHelperPath, renderSvelteHoloHelper())
      createdFrameworkSetup = true
    }
  }
  const broadcastAuthSupport = await syncBroadcastAuthSupportAfterAuthInstall(projectRoot)

  if (nextEnv.changed && typeof nextEnv.contents === 'string') {
    await writeTextFile(envPath, nextEnv.contents)
  }

  if (nextEnvExample.changed && typeof nextEnvExample.contents === 'string') {
    await writeTextFile(envExamplePath, nextEnvExample.contents)
  }

  return {
    updatedPackageJson: dependencyResult.updated,
    createdBroadcastConfig: !broadcastConfigPath,
    createdBroadcastDirectory: !broadcastDirectoryExists,
    createdChannelsDirectory: !channelsDirectoryExists,
    createdBroadcastAuthRoute: broadcastAuthSupport.createdBroadcastAuthRoute,
    createdFrameworkSetup,
    updatedEnv: nextEnv.changed,
    updatedEnvExample: nextEnvExample.changed,
  }
}

export {
  authFeaturesRequireConfigUpdate,
  detectAuthInstallFeaturesFromConfig,
  hasLoadedConfigFile,
  inferConnectionDriver,
  inferDatabaseDriverFromUrl,
  isSupportedCacheInstallerDriver,
  isSupportedQueueInstallerDriver,
  injectBroadcastAuthEndpoint,
  normalizeScaffoldOptionalPackages,
  renderAuthConfig,
  renderAuthEnvFiles,
  renderAuthMigration,
  renderAuthUserModel,
  renderCacheConfig,
  renderCacheEnvFiles,
  renderEnvFileContents,
  renderFrameworkFiles,
  renderFrameworkRunner,
  renderMailConfig,
  renderMediaConfig,
  renderNotificationsConfig,
  renderNotificationsMigration,
  normalizeScaffoldEnvSegments,
  renderQueueConfig,
  renderQueueEnvFiles,
  renderRedisConfig,
  renderScaffoldAppConfig,
  renderScaffoldDatabaseConfig,
  renderScaffoldEnvFiles,
  renderScaffoldGitignore,
  renderScaffoldPackageJson,
  renderScaffoldTsconfig,
  renderSecurityConfig,
  renderSessionConfig,
  renderStorageConfig,
  renderVSCodeSettings,
  resolveBroadcastConfigTargetPath,
  resolveDefaultDatabaseUrl,
  resolvePackageManagerVersion,
  sanitizePackageName,
  scaffoldProject,
  syncManagedDriverDependencies,
  upsertAuthPackageDependencies,
  upsertCachePackageDependencies,
  upsertEventsPackageDependency,
  upsertMailPackageDependency,
  upsertNotificationsPackageDependency,
  upsertSecurityPackageDependency,
}
