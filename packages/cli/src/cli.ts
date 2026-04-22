import { resolve } from 'node:path'
import { clearConfigCache, resolveConfigCachePath } from '@holo-js/config'
import {
  parseTokens,
  isInteractive,
  confirm,
  normalizeChoice,
  normalizeOptionalPackages,
  resolveNewProjectInput,
  ensureRequiredArg,
  resolveStringFlag,
  collectMultiStringFlag,
  resolveBooleanFlag,
  parseNumberFlag,
  splitCsv,
  SUPPORTED_INSTALL_TARGETS,
  SUPPORTED_CACHE_INSTALL_DRIVERS,
  SUPPORTED_QUEUE_INSTALL_DRIVERS,
} from './parsing'
import { fileExists } from './fs-utils'
import { writeLine } from './io'
import { hasProjectDependency } from './package-json'
import type * as DevModule from './dev'
import type * as ProjectConfigModule from './project/config'
import type * as ProjectDiscoveryModule from './project/discovery'
import type * as ProjectRuntimeModule from './project/runtime'
import type * as ProjectScaffoldModule from './project/scaffold'
import {
  SUPPORTED_AUTH_SOCIAL_PROVIDERS,
  type SupportedAuthSocialProvider,
} from './project/shared'
import type * as RuntimeModule from './runtime'
import type * as QueueModule from './queue'
import type * as CacheModule from './cache'
import type * as QueueMigrationsModule from './queue-migrations'
import type * as CacheMigrationsModule from './cache-migrations'
import type * as GeneratorsModule from './generators'
import type * as BroadcastModule from './broadcast'
import type * as SecurityModule from './security'
import type { LoadedProjectConfig, CommandFlagValue, CommandExecutionContext } from './types'
import type {
  IoStreams,
  CommandDefinition,
  InternalCommandContext,
  PreparedInput,
  SupportedScaffoldFramework,
  SupportedScaffoldPackageManager,
  SupportedScaffoldStorageDisk,
  SupportedCacheInstallerDriver,
  SupportedQueueInstallerDriver,
  ProjectScaffoldOptions,
  DiscoveredAppCommand,
} from './cli-types'

type RuntimeExecutor = typeof RuntimeModule.withRuntimeEnvironment
type ProjectCommandExecutors = {
  runProjectPrepare?: typeof DevModule.runProjectPrepare
  runProjectDevServer?: typeof DevModule.runProjectDevServer
  runProjectLifecycleScript?: typeof DevModule.runProjectLifecycleScript
}
type QueueCommandExecutors = {
  runQueueFailedCommand?: typeof QueueModule.runQueueFailedCommand
  runQueueFailedTableCommand?: typeof QueueMigrationsModule.runQueueFailedTableCommand
  runQueueFlushCommand?: typeof QueueModule.runQueueFlushCommand
  runQueueWorkCommand?: typeof QueueModule.runQueueWorkCommand
  runQueueForgetCommand?: typeof QueueModule.runQueueForgetCommand
  runQueueListen?: typeof QueueModule.runQueueListen
  runQueueRestartCommand?: typeof QueueModule.runQueueRestartCommand
  runQueueRetryCommand?: typeof QueueModule.runQueueRetryCommand
  runQueueTableCommand?: typeof QueueMigrationsModule.runQueueTableCommand
  runQueueClearCommand?: typeof QueueModule.runQueueClearCommand
}
type CacheCommandExecutors = {
  runCacheTableCommand?: typeof CacheMigrationsModule.runCacheTableCommand
  runCacheClearCommand?: typeof CacheModule.runCacheClearCommand
  runCacheForgetCommand?: typeof CacheModule.runCacheForgetCommand
}
type BroadcastCommandExecutors = {
  runBroadcastWorkCommand?: typeof BroadcastModule.runBroadcastWorkCommand
}
type SecurityCommandExecutors = {
  runRateLimitClearCommand?: typeof SecurityModule.runRateLimitClearCommand
}

let runtimeModulePromise: Promise<typeof RuntimeModule> | undefined
let queueModulePromise: Promise<typeof QueueModule> | undefined
let cacheModulePromise: Promise<typeof CacheModule> | undefined
let queueMigrationsModulePromise: Promise<typeof QueueMigrationsModule> | undefined
let cacheMigrationsModulePromise: Promise<typeof CacheMigrationsModule> | undefined
let generatorsModulePromise: Promise<typeof GeneratorsModule> | undefined
let broadcastModulePromise: Promise<typeof BroadcastModule> | undefined
let securityModulePromise: Promise<typeof SecurityModule> | undefined
let devModulePromise: Promise<typeof DevModule> | undefined
let projectConfigModulePromise: Promise<typeof ProjectConfigModule> | undefined
let projectDiscoveryModulePromise: Promise<typeof ProjectDiscoveryModule> | undefined
let projectRuntimeModulePromise: Promise<typeof ProjectRuntimeModule> | undefined
let projectScaffoldModulePromise: Promise<typeof ProjectScaffoldModule> | undefined

function loadRuntimeModule(): Promise<typeof RuntimeModule> {
  runtimeModulePromise ??= import('./runtime')
  return runtimeModulePromise
}

function loadQueueModule(): Promise<typeof QueueModule> {
  queueModulePromise ??= import('./queue')
  return queueModulePromise
}

function loadCacheModule(): Promise<typeof CacheModule> {
  cacheModulePromise ??= import('./cache')
  return cacheModulePromise
}

function loadQueueMigrationsModule(): Promise<typeof QueueMigrationsModule> {
  queueMigrationsModulePromise ??= import('./queue-migrations')
  return queueMigrationsModulePromise
}

function loadCacheMigrationsModule(): Promise<typeof CacheMigrationsModule> {
  cacheMigrationsModulePromise ??= import('./cache-migrations')
  return cacheMigrationsModulePromise
}

function loadGeneratorsModule(): Promise<typeof GeneratorsModule> {
  generatorsModulePromise ??= import('./generators')
  return generatorsModulePromise
}

function loadBroadcastModule(): Promise<typeof BroadcastModule> {
  broadcastModulePromise ??= import('./broadcast')
  return broadcastModulePromise
}

function loadSecurityModule(): Promise<typeof SecurityModule> {
  securityModulePromise ??= import('./security')
  return securityModulePromise
}

function loadDevModule(): Promise<typeof DevModule> {
  devModulePromise ??= import('./dev')
  return devModulePromise
}

function loadProjectConfigModule(): Promise<typeof ProjectConfigModule> {
  projectConfigModulePromise ??= import('./project/config')
  return projectConfigModulePromise
}

function loadProjectDiscoveryModule(): Promise<typeof ProjectDiscoveryModule> {
  projectDiscoveryModulePromise ??= import('./project/discovery')
  return projectDiscoveryModulePromise
}

function loadProjectRuntimeModule(): Promise<typeof ProjectRuntimeModule> {
  projectRuntimeModulePromise ??= import('./project/runtime')
  return projectRuntimeModulePromise
}

function loadProjectScaffoldModule(): Promise<typeof ProjectScaffoldModule> {
  projectScaffoldModulePromise ??= import('./project/scaffold')
  return projectScaffoldModulePromise
}

type QueueExecutorKey = keyof QueueCommandExecutors
type QueueExecutorLoaderMap = {
  [TKey in QueueExecutorKey]: () => Promise<NonNullable<QueueCommandExecutors[TKey]>>
}
type CacheExecutorKey = keyof CacheCommandExecutors
type CacheExecutorLoaderMap = {
  [TKey in CacheExecutorKey]: () => Promise<NonNullable<CacheCommandExecutors[TKey]>>
}
type ProjectExecutorKey = keyof ProjectCommandExecutors
type ProjectExecutorLoaderMap = {
  [TKey in ProjectExecutorKey]: () => Promise<NonNullable<ProjectCommandExecutors[TKey]>>
}
type GeneratorCommandKey =
  | 'runMakeModel'
  | 'runMakeMigration'
  | 'runMakeSeeder'
  | 'runMakeMail'
  | 'runMakeJob'
  | 'runMakeEvent'
  | 'runMakeBroadcast'
  | 'runMakeChannel'
  | 'runMakeListener'
  | 'runMakeObserver'
  | 'runMakeFactory'
type BroadcastExecutorKey = keyof BroadcastCommandExecutors
type BroadcastExecutorLoaderMap = {
  [TKey in BroadcastExecutorKey]: () => Promise<NonNullable<BroadcastCommandExecutors[TKey]>>
}

async function resolveRuntimeExecutor(runtimeExecutor?: RuntimeExecutor): Promise<RuntimeExecutor> {
  return runtimeExecutor ?? (await loadRuntimeModule()).withRuntimeEnvironment
}

const projectExecutorLoaders: ProjectExecutorLoaderMap = {
  runProjectPrepare: async () => (await loadDevModule()).runProjectPrepare,
  runProjectDevServer: async () => (await loadDevModule()).runProjectDevServer,
  runProjectLifecycleScript: async () => (await loadDevModule()).runProjectLifecycleScript,
}

async function resolveProjectExecutor<TKey extends ProjectExecutorKey>(
  projectExecutors: ProjectCommandExecutors,
  key: TKey,
): Promise<NonNullable<ProjectCommandExecutors[TKey]>> {
  const existing = projectExecutors[key]
  if (existing) {
    return existing as NonNullable<ProjectCommandExecutors[TKey]>
  }

  return projectExecutorLoaders[key]()
}

const queueExecutorLoaders: QueueExecutorLoaderMap = {
  runQueueFailedTableCommand: async () => (await loadQueueMigrationsModule()).runQueueFailedTableCommand,
  runQueueTableCommand: async () => (await loadQueueMigrationsModule()).runQueueTableCommand,
  runQueueFailedCommand: async () => (await loadQueueModule()).runQueueFailedCommand,
  runQueueFlushCommand: async () => (await loadQueueModule()).runQueueFlushCommand,
  runQueueWorkCommand: async () => (await loadQueueModule()).runQueueWorkCommand,
  runQueueForgetCommand: async () => (await loadQueueModule()).runQueueForgetCommand,
  runQueueListen: async () => (await loadQueueModule()).runQueueListen,
  runQueueRestartCommand: async () => (await loadQueueModule()).runQueueRestartCommand,
  runQueueRetryCommand: async () => (await loadQueueModule()).runQueueRetryCommand,
  runQueueClearCommand: async () => (await loadQueueModule()).runQueueClearCommand,
}

const cacheExecutorLoaders: CacheExecutorLoaderMap = {
  runCacheTableCommand: async () => (await loadCacheMigrationsModule()).runCacheTableCommand,
  runCacheClearCommand: async () => (await loadCacheModule()).runCacheClearCommand,
  runCacheForgetCommand: async () => (await loadCacheModule()).runCacheForgetCommand,
}

const broadcastExecutorLoaders: BroadcastExecutorLoaderMap = {
  runBroadcastWorkCommand: async () => (await loadBroadcastModule()).runBroadcastWorkCommand,
}

async function resolveQueueExecutor<TKey extends QueueExecutorKey>(
  queueExecutors: QueueCommandExecutors,
  key: TKey,
): Promise<NonNullable<QueueCommandExecutors[TKey]>> {
  const existing = queueExecutors[key]
  if (existing) {
    return existing as NonNullable<QueueCommandExecutors[TKey]>
  }

  return queueExecutorLoaders[key]()
}

async function resolveCacheExecutor<TKey extends CacheExecutorKey>(
  cacheExecutors: CacheCommandExecutors,
  key: TKey,
): Promise<NonNullable<CacheCommandExecutors[TKey]>> {
  const existing = cacheExecutors[key]
  if (existing) {
    return existing as NonNullable<CacheCommandExecutors[TKey]>
  }

  return cacheExecutorLoaders[key]()
}

async function resolveBroadcastExecutor<TKey extends BroadcastExecutorKey>(
  broadcastExecutors: BroadcastCommandExecutors,
  key: TKey,
): Promise<NonNullable<BroadcastCommandExecutors[TKey]>> {
  const existing = broadcastExecutors[key]
  if (existing) {
    return existing as NonNullable<BroadcastCommandExecutors[TKey]>
  }

  return broadcastExecutorLoaders[key]()
}

async function resolveGeneratorCommand<TKey extends GeneratorCommandKey>(
  key: TKey,
): Promise<typeof GeneratorsModule[TKey]> {
  return (await loadGeneratorsModule())[key]
}

export function createCommandContext(
  io: IoStreams,
  projectRoot: string,
  loadProject: () => Promise<LoadedProjectConfig>,
  input: PreparedInput,
): CommandExecutionContext {
  return {
    cwd: io.cwd,
    projectRoot,
    args: input.args,
    flags: input.flags,
    loadProject,
  }
}

export function printCommandList(io: IoStreams, registry: readonly CommandDefinition[]): void {
  const internal = registry.filter(command => command.source === 'internal')
  const app = registry.filter(command => command.source === 'app')

  writeLine(io.stdout, 'Internal Commands')
  for (const command of internal) {
    writeLine(io.stdout, `  ${command.usage}  ${command.description}`)
  }

  writeLine(io.stdout)
  writeLine(io.stdout, 'App Commands')
  if (app.length === 0) {
    writeLine(io.stdout, '  (none)')
    return
  }

  for (const command of app) {
    writeLine(io.stdout, `  ${command.usage}  ${command.description}`)
  }
}

export function printCommandHelp(io: IoStreams, command: CommandDefinition): void {
  writeLine(io.stdout, command.usage)
  writeLine(io.stdout, command.description)
}

export function resolvePackageManagerInstallCommand(packageManager: SupportedScaffoldPackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun install'
    case 'npm':
      return 'npm install'
    case 'pnpm':
      return 'pnpm install'
    case 'yarn':
      return 'yarn install'
  }
}

export function resolvePackageManagerDevCommand(packageManager: SupportedScaffoldPackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun run dev'
    case 'npm':
      return 'npm run dev'
    case 'pnpm':
      return 'pnpm dev'
    case 'yarn':
      return 'yarn dev'
  }
}

export function createInternalCommands(
  context: InternalCommandContext,
  runtimeExecutor?: RuntimeExecutor,
  queueExecutors: QueueCommandExecutors = {},
  projectExecutors: ProjectCommandExecutors = {},
  broadcastExecutors: BroadcastCommandExecutors = {},
  securityExecutors: SecurityCommandExecutors = {},
  cacheExecutors: CacheCommandExecutors = {},
): CommandDefinition[] {
  return [
    {
      name: 'list',
      description: 'List all available internal and app commands.',
      usage: 'holo list',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        printCommandList(context, context.registry)
      },
    },
    {
      name: 'new',
      description: 'Scaffold a new Holo project',
      usage: 'holo-js new <name> [--framework <nuxt|next|sveltekit>] [--database <sqlite|mysql|postgres>] [--package-manager <bun|npm|pnpm|yarn>] [--package <storage|events|queue|validation|forms|auth|authorization|notifications|mail|broadcast|security|cache>] [--storage-default-disk <local|public>]',
      source: 'internal',
      async prepare(input) {
        const resolved = await resolveNewProjectInput(context, input)

        return {
          args: [resolved.projectName],
          flags: {
            framework: resolved.framework,
            database: resolved.databaseDriver,
            ['package-manager']: resolved.packageManager,
            ['storage-default-disk']: resolved.storageDefaultDisk,
            ...(resolved.optionalPackages.length > 0
              ? { package: resolved.optionalPackages }
              : {}),
          },
        }
      },
      async run(commandContext) {
        const projectName = String(commandContext.args[0] ?? '')
        const framework = String(commandContext.flags.framework ?? 'nuxt') as SupportedScaffoldFramework
        const databaseDriver = String(commandContext.flags.database ?? 'sqlite') as ProjectScaffoldOptions['databaseDriver']
        const packageManager = String(commandContext.flags['package-manager'] ?? 'bun') as SupportedScaffoldPackageManager
        const storageDefaultDisk = String(commandContext.flags['storage-default-disk'] ?? 'local') as SupportedScaffoldStorageDisk
        const optionalPackages = normalizeOptionalPackages(
          (collectMultiStringFlag(commandContext.flags, 'package') ?? []).flatMap(entry => splitCsv(entry) ?? []),
        )
        const targetDir = resolve(commandContext.cwd, projectName)

        const { scaffoldProject } = await loadProjectScaffoldModule()
        await scaffoldProject(targetDir, {
          projectName,
          framework,
          databaseDriver,
          packageManager,
          storageDefaultDisk,
          optionalPackages,
        })

        writeLine(context.stdout, `Created Holo project: ${targetDir}`)
        writeLine(context.stdout)
        writeLine(context.stdout, 'Next steps')
        writeLine(context.stdout, `  cd ${projectName}`)
        writeLine(context.stdout, `  ${resolvePackageManagerInstallCommand(packageManager)}`)
        writeLine(context.stdout, `  ${resolvePackageManagerDevCommand(packageManager)}`)
      },
    },
    {
      name: 'install',
      description: 'Install first-party Holo support into an existing project.',
      usage: 'holo install <queue|events|auth|authorization|notifications|mail|broadcast|security|cache> [--driver <sync|file|redis|database>] [--social] [--provider <google|github|discord|facebook|apple|linkedin>] [--workos] [--clerk]',
      source: 'internal',
      async prepare(input) {
        const target = normalizeChoice(
          await ensureRequiredArg(context, input, 0, 'Install target'),
          SUPPORTED_INSTALL_TARGETS,
          'install target',
        )
        const requestedDriver = resolveStringFlag(input.flags, 'driver')
        if (target === 'events' && requestedDriver) {
          throw new Error('The events installer does not support --driver.')
        }
        if (target === 'auth' && requestedDriver) {
          throw new Error('The auth installer does not support --driver.')
        }
        if (target === 'authorization' && requestedDriver) {
          throw new Error('The authorization installer does not support --driver.')
        }
        if (target === 'notifications' && requestedDriver) {
          throw new Error('The notifications installer does not support --driver.')
        }
        if (target === 'mail' && requestedDriver) {
          throw new Error('The mail installer does not support --driver.')
        }
        if (target === 'broadcast' && requestedDriver) {
          throw new Error('The broadcast installer does not support --driver.')
        }
        if (target === 'security' && requestedDriver) {
          throw new Error('The security installer does not support --driver.')
        }

        const driver = target === 'queue'
          ? (requestedDriver
              ? normalizeChoice(requestedDriver, SUPPORTED_QUEUE_INSTALL_DRIVERS, 'queue driver')
              : 'sync')
          : target === 'cache'
            ? (requestedDriver
                ? normalizeChoice(requestedDriver, SUPPORTED_CACHE_INSTALL_DRIVERS, 'cache driver')
                : 'file')
          : undefined
        const socialProviders = target === 'auth'
          ? ((collectMultiStringFlag(input.flags, 'provider') ?? [])
              .flatMap(entry => splitCsv(entry) ?? [])
              .map(provider => normalizeChoice(provider, SUPPORTED_AUTH_SOCIAL_PROVIDERS, 'auth social provider')) as SupportedAuthSocialProvider[])
          : []
        const social = target === 'auth'
          ? resolveBooleanFlag(input.flags, 'social') === true || socialProviders.length > 0
          : false
        const workos = target === 'auth'
          ? resolveBooleanFlag(input.flags, 'workos') === true
          : false
        const clerk = target === 'auth'
          ? resolveBooleanFlag(input.flags, 'clerk') === true
          : false

        return {
          args: [target],
          flags: {
            ...(driver ? { driver } : {}),
            ...(social ? { social } : {}),
            ...(socialProviders.length > 0 ? { provider: socialProviders } : {}),
            ...(workos ? { workos } : {}),
            /* v8 ignore next -- exercised only by the install-command prepare path with a clerk flag */
            ...(clerk ? { clerk } : {}),
          },
        }
      },
      async run(commandContext) {
        const target = String(commandContext.args[0] ?? '')

        if (target === 'events') {
          const {
            installEventsIntoProject,
            installQueueIntoProject,
          } = await loadProjectScaffoldModule()
          const eventsResult = await installEventsIntoProject(context.projectRoot)
          let queueResult:
            | Awaited<ReturnType<typeof ProjectScaffoldModule.installQueueIntoProject>>
            | undefined

          const queueConfigured = await hasProjectDependency(context.projectRoot, '@holo-js/queue')
            || await fileExists(resolve(context.projectRoot, 'config/queue.ts'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.mts'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.js'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.mjs'))

          if (
            !queueConfigured
            && isInteractive(context, commandContext.flags as Record<string, string | boolean | readonly string[]>)
          ) {
            const enableQueuedListeners = await confirm(
              context,
              'Enable queued listeners too?',
              false,
            )

            if (enableQueuedListeners) {
              queueResult = await installQueueIntoProject(context.projectRoot, { driver: 'sync' })
            }
          }

          const changed = eventsResult.updatedPackageJson
            || eventsResult.createdEventsDirectory
            || eventsResult.createdListenersDirectory
            || !!queueResult

          writeLine(context.stdout, changed ? 'Installed events support.' : 'Events support is already installed.')
          if (eventsResult.updatedPackageJson || queueResult?.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (eventsResult.createdEventsDirectory) writeLine(context.stdout, '  - created server/events')
          if (eventsResult.createdListenersDirectory) writeLine(context.stdout, '  - created server/listeners')
          if (queueResult) {
            writeLine(context.stdout, '  - enabled queued listeners')
            if (queueResult.createdQueueConfig) writeLine(context.stdout, '  - created config/queue.ts')
            /* v8 ignore next 2 -- queued listeners are auto-enabled with the sync driver in this flow */
            if (queueResult.updatedEnv) writeLine(context.stdout, '  - updated .env')
            /* v8 ignore next 2 -- queued listeners are auto-enabled with the sync driver in this flow */
            if (queueResult.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
            if (queueResult.createdJobsDirectory) writeLine(context.stdout, '  - created server/jobs')
          }
          return
        }

        if (target === 'auth') {
          const { installAuthIntoProject } = await loadProjectScaffoldModule()
          const socialProviders = ((collectMultiStringFlag(commandContext.flags, 'provider') ?? [])
            .flatMap(entry => splitCsv(entry) ?? [])
            .map(provider => normalizeChoice(provider, SUPPORTED_AUTH_SOCIAL_PROVIDERS, 'auth social provider')) as SupportedAuthSocialProvider[])
          const result = await installAuthIntoProject(context.projectRoot, {
            social: commandContext.flags.social === true,
            ...(socialProviders.length > 0 ? { socialProviders } : {}),
            workos: commandContext.flags.workos === true,
            clerk: commandContext.flags.clerk === true,
          })
          const changed = result.updatedPackageJson
            || result.createdAuthConfig
            || result.createdSessionConfig
            || result.createdUserModel
            || result.createdMigrationFiles.length > 0
            || result.updatedEnv
            || result.updatedEnvExample

          writeLine(context.stdout, changed ? 'Installed auth support.' : 'Auth support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdAuthConfig) writeLine(context.stdout, '  - created config/auth.ts')
          if (result.createdSessionConfig) writeLine(context.stdout, '  - created config/session.ts')
          if (result.createdUserModel) writeLine(context.stdout, '  - created server/models/User.ts')
          if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
          if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
          if (result.createdMigrationFiles.length > 0) writeLine(context.stdout, `  - created ${result.createdMigrationFiles.length} auth migrations`)
          return
        }

        if (target === 'authorization') {
          const { installAuthorizationIntoProject } = await loadProjectScaffoldModule()
          const result = await installAuthorizationIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdPoliciesDirectory
            || result.createdAbilitiesDirectory
            || result.createdPoliciesReadme
            || result.createdAbilitiesReadme

          writeLine(context.stdout, changed ? 'Installed authorization support.' : 'Authorization support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdPoliciesDirectory) writeLine(context.stdout, '  - created server/policies')
          if (result.createdAbilitiesDirectory) writeLine(context.stdout, '  - created server/abilities')
          if (result.createdPoliciesReadme) writeLine(context.stdout, '  - created server/policies/README.md')
          if (result.createdAbilitiesReadme) writeLine(context.stdout, '  - created server/abilities/README.md')
          return
        }

        if (target === 'notifications') {
          const { installNotificationsIntoProject } = await loadProjectScaffoldModule()
          const result = await installNotificationsIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdNotificationsConfig
            || result.createdMigrationFiles.length > 0

          writeLine(context.stdout, changed ? 'Installed notifications support.' : 'Notifications support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdNotificationsConfig) writeLine(context.stdout, '  - created config/notifications.ts')
          if (result.createdMigrationFiles.length > 0) {
            writeLine(context.stdout, `  - created ${result.createdMigrationFiles.length} notifications migration`)
          }
          return
        }

        if (target === 'mail') {
          const { installMailIntoProject } = await loadProjectScaffoldModule()
          const result = await installMailIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdMailConfig
            || result.createdMailDirectory

          writeLine(context.stdout, changed ? 'Installed mail support.' : 'Mail support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdMailConfig) writeLine(context.stdout, '  - created config/mail.ts')
          if (result.createdMailDirectory) writeLine(context.stdout, '  - created server/mail')
          return
        }

        if (target === 'broadcast') {
          const { installBroadcastIntoProject } = await loadProjectScaffoldModule()
          const result = await installBroadcastIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson
            || result.createdBroadcastConfig
            || result.createdBroadcastDirectory
            || result.createdChannelsDirectory
            || result.createdBroadcastAuthRoute
            || result.createdFrameworkSetup
            || result.updatedEnv
            || result.updatedEnvExample

          writeLine(context.stdout, changed ? 'Installed broadcast support.' : 'Broadcast support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
          if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
          if (result.createdBroadcastConfig) writeLine(context.stdout, '  - created config/broadcast.ts')
          if (result.createdBroadcastDirectory) writeLine(context.stdout, '  - created server/broadcast')
          if (result.createdChannelsDirectory) writeLine(context.stdout, '  - created server/channels')
          if (result.createdBroadcastAuthRoute) writeLine(context.stdout, '  - created /broadcasting/auth route')
          if (result.createdFrameworkSetup) writeLine(context.stdout, '  - created framework Flux setup')
          return
        }

        if (target === 'security') {
          const { installSecurityIntoProject } = await loadProjectScaffoldModule()
          const result = await installSecurityIntoProject(context.projectRoot)
          const changed = result.updatedPackageJson || result.createdSecurityConfig

          writeLine(context.stdout, changed ? 'Installed security support.' : 'Security support is already installed.')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.createdSecurityConfig) writeLine(context.stdout, '  - created config/security.ts')
          return
        }

        if (target === 'cache') {
          const { installCacheIntoProject } = await loadProjectScaffoldModule()
          const result = await installCacheIntoProject(context.projectRoot, {
            driver: String(commandContext.flags.driver ?? 'file') as SupportedCacheInstallerDriver,
          })

          const changed = result.createdCacheConfig
            || result.createdRedisConfig
            || result.updatedPackageJson
            || result.updatedEnv
            || result.updatedEnvExample

          writeLine(context.stdout, changed ? 'Installed cache support.' : 'Cache support is already installed.')
          if (result.createdCacheConfig) writeLine(context.stdout, '  - created config/cache.ts')
          if (result.createdRedisConfig) writeLine(context.stdout, '  - created config/redis.ts')
          if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
          if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
          if (result.databaseDriver) writeLine(context.stdout, '  - run "holo cache:table" to create the cache tables')
          return
        }

        if (target !== 'queue') {
          throw new Error(`Unsupported install target: ${target || '(empty)'}.`)
        }

        const { installQueueIntoProject } = await loadProjectScaffoldModule()
        const result = await installQueueIntoProject(context.projectRoot, {
          driver: String(commandContext.flags.driver ?? 'sync') as SupportedQueueInstallerDriver,
        })

        const changed = result.createdQueueConfig
          || result.updatedPackageJson
          || result.updatedEnv
          || result.updatedEnvExample
          || result.createdJobsDirectory

        writeLine(context.stdout, changed ? 'Installed queue support.' : 'Queue support is already installed.')
        if (result.createdQueueConfig) writeLine(context.stdout, '  - created config/queue.ts')
        if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
        if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
        if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
        if (result.createdJobsDirectory) writeLine(context.stdout, '  - created server/jobs')
      },
    },
    {
      name: 'prepare',
      description: 'Discover Holo resources and refresh generated registries.',
      usage: 'holo prepare',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runProjectPrepare = await resolveProjectExecutor(projectExecutors, 'runProjectPrepare')
        await runProjectPrepare(context.projectRoot, context)
        writeLine(context.stdout, 'Prepared Holo discovery artifacts.')
      },
    },
    {
      name: 'dev',
      description: 'Prepare Holo discovery artifacts and run the project dev script.',
      usage: 'holo dev',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runProjectDevServer = await resolveProjectExecutor(projectExecutors, 'runProjectDevServer')
        await runProjectDevServer(context, context.projectRoot)
      },
    },
    {
      name: 'build',
      description: 'Prepare Holo discovery artifacts and run the project build script.',
      usage: 'holo build',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runProjectPrepare = await resolveProjectExecutor(projectExecutors, 'runProjectPrepare')
        const runProjectLifecycleScript = await resolveProjectExecutor(projectExecutors, 'runProjectLifecycleScript')
        await runProjectPrepare(context.projectRoot, context)
        await runProjectLifecycleScript(context, context.projectRoot, 'holo:build')
      },
    },
    {
      name: 'broadcast:work',
      description: 'Run the self-hosted broadcast worker.',
      usage: 'holo broadcast:work',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runBroadcastWorkCommand = await resolveBroadcastExecutor(broadcastExecutors, 'runBroadcastWorkCommand')
        await runBroadcastWorkCommand(context, context.projectRoot)
      },
    },
    {
      name: 'cache:table',
      description: 'Generate the database cache table migration.',
      usage: 'holo cache:table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runCacheTableCommand = await resolveCacheExecutor(cacheExecutors, 'runCacheTableCommand')
        await runCacheTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'cache:clear',
      description: 'Clear the configured cache store.',
      usage: 'holo cache:clear [--driver <name>]',
      source: 'internal',
      async prepare(input) {
        const driver = resolveStringFlag(input.flags, 'driver', 'd')
        return {
          args: [],
          flags: {
            ...(driver ? { driver } : {}),
          },
        }
      },
      async run(commandContext) {
        const runCacheClearCommand = await resolveCacheExecutor(cacheExecutors, 'runCacheClearCommand')
        await runCacheClearCommand(
          context,
          context.projectRoot,
          typeof commandContext.flags.driver === 'string' ? commandContext.flags.driver : undefined,
        )
      },
    },
    {
      name: 'cache:forget',
      description: 'Forget a single cache key.',
      usage: 'holo cache:forget <key> [--driver <name>]',
      source: 'internal',
      async prepare(input) {
        const key = await ensureRequiredArg(context, input, 0, 'Cache key')
        const driver = resolveStringFlag(input.flags, 'driver', 'd')
        return {
          args: [key],
          flags: {
            ...(driver ? { driver } : {}),
          },
        }
      },
      async run(commandContext) {
        const runCacheForgetCommand = await resolveCacheExecutor(cacheExecutors, 'runCacheForgetCommand')
        await runCacheForgetCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
          typeof commandContext.flags.driver === 'string' ? commandContext.flags.driver : undefined,
        )
      },
    },
    {
      name: 'queue:table',
      description: 'Generate the database queue jobs table migration.',
      usage: 'holo queue:table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueTableCommand = await resolveQueueExecutor(queueExecutors, 'runQueueTableCommand')
        await runQueueTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:failed-table',
      description: 'Generate the failed jobs table migration.',
      usage: 'holo queue:failed-table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueFailedTableCommand = await resolveQueueExecutor(queueExecutors, 'runQueueFailedTableCommand')
        await runQueueFailedTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:work',
      description: 'Run the queue worker for an async queue connection.',
      usage: 'holo queue:work [--connection <name>] [--queue <name>] [--once] [--stop-when-empty] [--sleep N] [--tries N] [--timeout N] [--max-jobs N] [--max-time N]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        const sleep = parseNumberFlag(input.flags, 'sleep')
        const tries = parseNumberFlag(input.flags, 'tries')
        const timeout = parseNumberFlag(input.flags, 'timeout')
        const maxJobs = parseNumberFlag(input.flags, 'max-jobs')
        const maxTime = parseNumberFlag(input.flags, 'max-time')
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
            once: resolveBooleanFlag(input.flags, 'once'),
            ['stop-when-empty']: resolveBooleanFlag(input.flags, 'stop-when-empty'),
            ...(typeof sleep === 'number' ? { sleep } : {}),
            ...(typeof tries === 'number' ? { tries } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            ...(typeof maxJobs === 'number' ? { ['max-jobs']: maxJobs } : {}),
            ...(typeof maxTime === 'number' ? { ['max-time']: maxTime } : {}),
          },
        }
      },
      async run(commandContext) {
        const runQueueWorkCommand = await resolveQueueExecutor(queueExecutors, 'runQueueWorkCommand')
        await runQueueWorkCommand(context, context.projectRoot, {
          ...(typeof commandContext.flags.connection === 'string' ? { connection: commandContext.flags.connection } : {}),
          ...(Array.isArray(commandContext.flags.queue) ? { queueNames: commandContext.flags.queue } : {}),
          once: commandContext.flags.once === true,
          stopWhenEmpty: commandContext.flags['stop-when-empty'] === true,
          ...(typeof commandContext.flags.sleep === 'number' ? { sleep: commandContext.flags.sleep } : {}),
          ...(typeof commandContext.flags.tries === 'number' ? { tries: commandContext.flags.tries } : {}),
          ...(typeof commandContext.flags.timeout === 'number' ? { timeout: commandContext.flags.timeout } : {}),
          ...(typeof commandContext.flags['max-jobs'] === 'number' ? { maxJobs: commandContext.flags['max-jobs'] } : {}),
          ...(typeof commandContext.flags['max-time'] === 'number' ? { maxTime: commandContext.flags['max-time'] } : {}),
        })
      },
    },
    {
      name: 'queue:listen',
      description: 'Watch queue-related project files and restart the queue worker on change.',
      usage: 'holo queue:listen [--connection <name>] [--queue <name>] [--sleep N] [--tries N] [--timeout N] [--max-jobs N] [--max-time N]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        const sleep = parseNumberFlag(input.flags, 'sleep')
        const tries = parseNumberFlag(input.flags, 'tries')
        const timeout = parseNumberFlag(input.flags, 'timeout')
        const maxJobs = parseNumberFlag(input.flags, 'max-jobs')
        const maxTime = parseNumberFlag(input.flags, 'max-time')
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
            ...(typeof sleep === 'number' ? { sleep } : {}),
            ...(typeof tries === 'number' ? { tries } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            ...(typeof maxJobs === 'number' ? { ['max-jobs']: maxJobs } : {}),
            ...(typeof maxTime === 'number' ? { ['max-time']: maxTime } : {}),
          },
        }
      },
      async run(commandContext) {
        const runQueueListen = await resolveQueueExecutor(queueExecutors, 'runQueueListen')
        await runQueueListen(context, context.projectRoot, commandContext.flags)
      },
    },
    {
      name: 'rate-limit:clear',
      description: 'Clear rate-limit buckets for the configured security driver.',
      usage: 'holo rate-limit:clear [--limiter <name>] [--key <value>] [--all]',
      source: 'internal',
      async prepare(input) {
        const limiter = resolveStringFlag(input.flags, 'limiter')
        const key = resolveStringFlag(input.flags, 'key')
        const all = resolveBooleanFlag(input.flags, 'all')

        if (!all && !limiter) {
          throw new Error('rate-limit:clear requires --limiter <name> unless --all is used.')
        }

        return {
          args: [],
          flags: {
            ...(limiter ? { limiter } : {}),
            ...(key ? { key } : {}),
            ...(all ? { all } : {}),
          },
        }
      },
      async run(commandContext) {
        const runRateLimitClearCommand = securityExecutors.runRateLimitClearCommand
          ?? (await loadSecurityModule()).runRateLimitClearCommand

        await runRateLimitClearCommand(context, context.projectRoot, {
          ...(typeof commandContext.flags.limiter === 'string' ? { limiter: commandContext.flags.limiter } : {}),
          ...(typeof commandContext.flags.key === 'string' ? { key: commandContext.flags.key } : {}),
          ...(commandContext.flags.all === true ? { all: true } : {}),
        })
      },
    },
    {
      name: 'queue:restart',
      description: 'Signal long-lived queue workers to restart after the current job.',
      usage: 'holo queue:restart',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueRestartCommand = await resolveQueueExecutor(queueExecutors, 'runQueueRestartCommand')
        await runQueueRestartCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:clear',
      description: 'Clear pending jobs for a queue connection.',
      usage: 'holo queue:clear [--connection <name>] [--queue <name>]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
          },
        }
      },
      async run(commandContext) {
        const runQueueClearCommand = await resolveQueueExecutor(queueExecutors, 'runQueueClearCommand')
        await runQueueClearCommand(
          context,
          context.projectRoot,
          typeof commandContext.flags.connection === 'string' ? commandContext.flags.connection : undefined,
          Array.isArray(commandContext.flags.queue) ? commandContext.flags.queue : undefined,
        )
      },
    },
    {
      name: 'queue:failed',
      description: 'List failed queued jobs.',
      usage: 'holo queue:failed',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueFailedCommand = await resolveQueueExecutor(queueExecutors, 'runQueueFailedCommand')
        await runQueueFailedCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:retry',
      description: 'Retry one failed job or all failed jobs.',
      usage: 'holo queue:retry <id|all>',
      source: 'internal',
      async prepare(input) {
        const identifier = await ensureRequiredArg(context, input, 0, 'Failed job id')
        return {
          args: [identifier],
          flags: {},
        }
      },
      async run(commandContext) {
        const runQueueRetryCommand = await resolveQueueExecutor(queueExecutors, 'runQueueRetryCommand')
        await runQueueRetryCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
        )
      },
    },
    {
      name: 'queue:forget',
      description: 'Delete one failed job record.',
      usage: 'holo queue:forget <id>',
      source: 'internal',
      async prepare(input) {
        const identifier = await ensureRequiredArg(context, input, 0, 'Failed job id')
        return {
          args: [identifier],
          flags: {},
        }
      },
      async run(commandContext) {
        const runQueueForgetCommand = await resolveQueueExecutor(queueExecutors, 'runQueueForgetCommand')
        await runQueueForgetCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
        )
      },
    },
    {
      name: 'queue:flush',
      description: 'Clear the failed jobs table.',
      usage: 'holo queue:flush',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const runQueueFlushCommand = await resolveQueueExecutor(queueExecutors, 'runQueueFlushCommand')
        await runQueueFlushCommand(context, context.projectRoot)
      },
    },
    {
      name: 'config:cache',
      description: 'Compile config files into a reusable cache artifact.',
      usage: 'holo config:cache',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const { cacheProjectConfig } = await loadRuntimeModule()
        const cachePath = await cacheProjectConfig(context.projectRoot)
        writeLine(context.stdout, `Config cached: ${cachePath}`)
      },
    },
    {
      name: 'config:clear',
      description: 'Remove the generated config cache artifact.',
      usage: 'holo config:clear',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const removed = await clearConfigCache(context.projectRoot)
        const cachePath = resolveConfigCachePath(context.projectRoot)
        writeLine(
          context.stdout,
          removed ? `Config cache cleared: ${cachePath}` : `Config cache was already clear: ${cachePath}`,
        )
      },
    },
    {
      name: 'make:model',
      description: 'Create a model and optionally related database artifacts.',
      usage: 'holo make:model <name> [--table <table>] [-m] [-o] [-s] [-f]',
      source: 'internal',
      async prepare(input) {
        const name = await ensureRequiredArg(context, input, 0, 'Model name')
        const table = resolveStringFlag(input.flags, 'table')
        const flags: PreparedInput['flags'] = {
          migration: resolveBooleanFlag(input.flags, 'migration', 'm'),
          observer: resolveBooleanFlag(input.flags, 'observer', 'o'),
          seeder: resolveBooleanFlag(input.flags, 'seeder', 's'),
          factory: resolveBooleanFlag(input.flags, 'factory', 'f'),
          ...(typeof table === 'string' ? { table } : {}),
        }

        /* v8 ignore start */
        if (isInteractive(context, input.flags)) {
          const noneSelected = [flags.migration, flags.observer, flags.seeder, flags.factory].every(value => value !== true)
          if (noneSelected && await confirm(context, 'Generate a migration?', true)) {
            flags.migration = true
          }
          if (!flags.observer && await confirm(context, 'Generate an observer?')) {
            flags.observer = true
          }
          if (!flags.seeder && await confirm(context, 'Generate a seeder?')) {
            flags.seeder = true
          }
          if (!flags.factory && await confirm(context, 'Generate a factory?')) {
            flags.factory = true
          }
        }
        /* v8 ignore stop */

        return {
          args: [name],
          flags,
        }
      },
      async run(commandContext) {
        const runMakeModel = await resolveGeneratorCommand('runMakeModel')
        await runMakeModel(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:migration',
      description: 'Create and register a migration file.',
      usage: 'holo make:migration <name> [--create users] [--table users]',
      source: 'internal',
      async prepare(input) {
        const create = resolveStringFlag(input.flags, 'create')
        const table = resolveStringFlag(input.flags, 'table')

        if (create && table) {
          throw new Error('Use either "--create" or "--table", not both.')
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Migration name')],
          flags: {
            ...(typeof create === 'string' ? { create } : {}),
            ...(typeof table === 'string' ? { table } : {}),
          },
        }
      },
      async run(commandContext) {
        const runMakeMigration = await resolveGeneratorCommand('runMakeMigration')
        await runMakeMigration(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:seeder',
      description: 'Create and register a seeder file.',
      usage: 'holo make:seeder <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Seeder name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeSeeder = await resolveGeneratorCommand('runMakeSeeder')
        await runMakeSeeder(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:mail',
      description: 'Create a mail definition file.',
      usage: 'holo make:mail <name> [--markdown]',
      source: 'internal',
      async prepare(input) {
        const markdown = resolveBooleanFlag(input.flags, 'markdown') === true
        const view = resolveBooleanFlag(input.flags, 'view') === true

        if (markdown && view) {
          throw new Error('Use either "--markdown" or "--view", not both.')
        }

        if (view) {
          throw new Error(
            'View-backed mail scaffolding requires a renderView runtime binding, which the first-party app scaffolds do not configure yet. Use "--markdown" instead.',
          )
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Mail name')],
          flags: { type: 'markdown' },
        }
      },
      async run(commandContext) {
        const runMakeMail = await resolveGeneratorCommand('runMakeMail')
        await runMakeMail(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:event',
      description: 'Create and register an event file.',
      usage: 'holo make:event <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Event name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeEvent = await resolveGeneratorCommand('runMakeEvent')
        await runMakeEvent(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:broadcast',
      description: 'Create and register a broadcast definition file.',
      usage: 'holo make:broadcast <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Broadcast name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeBroadcast = await resolveGeneratorCommand('runMakeBroadcast')
        await runMakeBroadcast(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:channel',
      description: 'Create and register a channel authorization definition file.',
      usage: 'holo make:channel <pattern>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Channel pattern')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeChannel = await resolveGeneratorCommand('runMakeChannel')
        await runMakeChannel(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:job',
      description: 'Create and register a queue job file.',
      usage: 'holo make:job <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Job name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeJob = await resolveGeneratorCommand('runMakeJob')
        await runMakeJob(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:listener',
      description: 'Create and register an event listener file.',
      usage: 'holo make:listener <name> --event <event-name> [--event <event-name>]',
      source: 'internal',
      async prepare(input) {
        const eventNames = (collectMultiStringFlag(input.flags, 'event') ?? [])
          .flatMap(entry => splitCsv(entry))
          .map(value => value.trim())
          .filter(Boolean)
        if (eventNames.length === 0) {
          throw new Error('Listener event name is required. Use "--event <event-name>".')
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Listener name')],
          flags: { event: eventNames },
        }
      },
      async run(commandContext) {
        const runMakeListener = await resolveGeneratorCommand('runMakeListener')
        await runMakeListener(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:observer',
      description: 'Create an observer file.',
      usage: 'holo make:observer <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Observer name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeObserver = await resolveGeneratorCommand('runMakeObserver')
        await runMakeObserver(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:factory',
      description: 'Create a factory file.',
      usage: 'holo make:factory <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Factory name')],
          flags: {},
        }
      },
      async run(commandContext) {
        const runMakeFactory = await resolveGeneratorCommand('runMakeFactory')
        await runMakeFactory(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'migrate',
      description: 'Run registered migrations.',
      usage: 'holo migrate [--step N]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            ...(typeof parseNumberFlag(input.flags, 'step') === 'number' ? { step: parseNumberFlag(input.flags, 'step')! } : {}),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'migrate',
          {
            ...(typeof commandContext.flags.step === 'number' ? { step: commandContext.flags.step } : {}),
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No migrations were executed.')
          },
        )
      },
    },
    {
      name: 'migrate:fresh',
      description: 'Drop all tables and rerun all registered migrations.',
      usage: 'holo migrate:fresh [--seed] [--only a,b,c] [--quietly] [--force]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            seed: resolveBooleanFlag(input.flags, 'seed'),
            ...(collectMultiStringFlag(input.flags, 'only')
              ? { only: collectMultiStringFlag(input.flags, 'only')!.flatMap(entry => splitCsv(entry)) }
              : {}),
            quietly: resolveBooleanFlag(input.flags, 'quietly'),
            force: resolveBooleanFlag(input.flags, 'force'),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'fresh',
          {
            seed: false,
          },
          async (stdout) => {
            for (const line of stdout.split('\n').filter(Boolean)) {
              writeLine(context.stdout, line)
            }
          },
        )

        if (commandContext.flags.seed !== true) {
          return
        }

        await executeRuntime(
          context.projectRoot,
          'seed',
          {
            ...(Array.isArray(commandContext.flags.only) ? { only: commandContext.flags.only } : {}),
            quietly: commandContext.flags.quietly === true,
            force: commandContext.flags.force === true,
            environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No seeders were executed.')
          },
        )
      },
    },
    {
      name: 'migrate:rollback',
      description: 'Rollback registered migrations.',
      usage: 'holo migrate:rollback [--step N] [--batch N]',
      source: 'internal',
      async prepare(input) {
        const step = parseNumberFlag(input.flags, 'step')
        const batch = parseNumberFlag(input.flags, 'batch')
        return {
          args: [],
          flags: {
            ...(typeof step === 'number' ? { step } : {}),
            ...(typeof batch === 'number' ? { batch } : {}),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'rollback',
          {
            ...(typeof commandContext.flags.step === 'number' ? { step: commandContext.flags.step } : {}),
            ...(typeof commandContext.flags.batch === 'number' ? { batch: commandContext.flags.batch } : {}),
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No migrations were executed.')
          },
        )
      },
    },
    {
      name: 'seed',
      description: 'Run registered seeders.',
      usage: 'holo seed [--only a,b,c] [--quietly] [--force]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            ...(collectMultiStringFlag(input.flags, 'only')
              ? { only: collectMultiStringFlag(input.flags, 'only')!.flatMap(entry => splitCsv(entry)) }
              : {}),
            quietly: resolveBooleanFlag(input.flags, 'quietly'),
            force: resolveBooleanFlag(input.flags, 'force'),
          },
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'seed',
          {
            ...(Array.isArray(commandContext.flags.only) ? { only: commandContext.flags.only } : {}),
            quietly: commandContext.flags.quietly === true,
            force: commandContext.flags.force === true,
            environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No seeders were executed.')
          },
        )
      },
    },
    {
      name: 'prune',
      description: 'Prune registered prunable models.',
      usage: 'holo prune [ModelName ...]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [...input.args],
          flags: {},
        }
      },
      async run(commandContext) {
        const executeRuntime = await resolveRuntimeExecutor(runtimeExecutor)
        await executeRuntime(
          context.projectRoot,
          'prune',
          { models: [...commandContext.args] },
          async (stdout) => {
            for (const line of stdout.split('\n').filter(Boolean)) {
              writeLine(context.stdout, line)
            }
          },
        )
      },
    },
  ]
}

export function createAppCommandDefinition(command: DiscoveredAppCommand): CommandDefinition {
  return {
    name: command.name,
    aliases: command.aliases,
    description: command.description,
    usage: command.usage ?? `holo ${command.name}`,
    source: 'app',
    async run(context) {
      await (await command.load()).run(context)
    },
  }
}

export function commandTokens(command: CommandDefinition): string[] {
  return [command.name, ...(command.aliases ?? [])]
}

export function findCommandConflict(
  registry: readonly CommandDefinition[],
  candidate: CommandDefinition,
): { token: string, command: CommandDefinition } | undefined {
  for (const token of commandTokens(candidate)) {
    const conflict = registry.find(command => commandTokens(command).includes(token))
    if (conflict) {
      return {
        token,
        command: conflict,
      }
    }
  }

  return undefined
}

export function findCommand(
  registry: readonly CommandDefinition[],
  name: string,
): CommandDefinition | undefined {
  return registry.find(command => command.name === name || command.aliases?.includes(name))
}

export async function runCli(argv: readonly string[], io: IoStreams): Promise<number> {
  try {
    const requestedCommandName = argv[0]
    const projectRoot = requestedCommandName === 'new'
      ? io.cwd
      : await (await loadProjectRuntimeModule()).findProjectRoot(io.cwd)
    let cachedProject: LoadedProjectConfig | undefined
    const loadProject = async () => {
      cachedProject ??= await (await loadProjectConfigModule()).loadProjectConfig(projectRoot)
      return cachedProject
    }

    const placeholderRegistry: CommandDefinition[] = []
    const internalContext: InternalCommandContext = {
      ...io,
      projectRoot,
      registry: placeholderRegistry,
      loadProject,
    }
    const internalCommands = createInternalCommands(internalContext)
    const registry = [...internalCommands]
    const canSkipAppDiscovery = requestedCommandName === 'config:cache'
      || requestedCommandName === 'config:clear'
      || requestedCommandName === 'new'
      || requestedCommandName === 'install'
      || requestedCommandName === 'prepare'
      || requestedCommandName === 'dev'
      || requestedCommandName === 'build'
      || requestedCommandName === 'cache:table'
      || requestedCommandName === 'cache:clear'
      || requestedCommandName === 'cache:forget'
      || requestedCommandName === 'broadcast:work'
      || requestedCommandName === 'queue:table'
      || requestedCommandName === 'queue:failed-table'
      || requestedCommandName === 'queue:work'
      || requestedCommandName === 'queue:listen'
      || requestedCommandName === 'queue:failed'
      || requestedCommandName === 'queue:retry'
      || requestedCommandName === 'queue:forget'
      || requestedCommandName === 'queue:flush'
      || requestedCommandName === 'queue:restart'
      || requestedCommandName === 'queue:clear'
      || requestedCommandName === 'rate-limit:clear'

    if (!canSkipAppDiscovery) {
      const initialProject = await loadProject()
      const appCommands = (await (await loadProjectDiscoveryModule()).discoverAppCommands(projectRoot, initialProject.config))
        .map(entry => createAppCommandDefinition(entry))

      for (const appCommand of appCommands) {
        const duplicate = findCommandConflict(registry, appCommand)
        if (duplicate) {
          throw new Error(
            `App command "${appCommand.name}" conflicts with ${duplicate.command.source} command `
            + `"${duplicate.command.name}" via "${duplicate.token}".`,
          )
        }

        registry.push(appCommand)
      }
    }

    placeholderRegistry.push(...registry)

    if (!requestedCommandName || requestedCommandName === 'help' || requestedCommandName === '--help' || requestedCommandName === '-h') {
      printCommandList(io, placeholderRegistry)
      return 0
    }

    const command = findCommand(placeholderRegistry, requestedCommandName)
    if (!command) {
      writeLine(io.stderr, `Unknown command "${requestedCommandName}".`)
      printCommandList(io, placeholderRegistry)
      return 1
    }

    const parsed = parseTokens(argv.slice(1))
    if (parsed.flags.help === true || parsed.flags.h === true) {
      printCommandHelp(io, command)
      return 0
    }

    const prepared = command.prepare
      ? await command.prepare(parsed, internalContext)
      : {
          args: parsed.args,
          flags: parsed.flags as Record<string, CommandFlagValue>,
        }

    const commandContext = createCommandContext(io, projectRoot, loadProject, prepared)
    await command.run(commandContext)
    return 0
  } catch (error) {
    writeLine(io.stderr, error instanceof Error ? error.message : String(error))
    return 1
  }
}
