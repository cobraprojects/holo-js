import type * as AgentSkillsModule from './agent-skills'
import type * as BroadcastModule from './broadcast'
import type * as CacheModule from './cache'
import type * as CacheMigrationsModule from './cache-migrations'
import type * as DevModule from './dev'
import type * as GeneratorsModule from './generators'
import type * as MediaMigrationsModule from './media-migrations'
import type * as ProjectConfigModule from './project/config'
import type * as ProjectDiscoveryModule from './project/discovery'
import type * as ProjectPluginsModule from './project/plugins'
import type * as ProjectRuntimeModule from './project/runtime'
import type * as ProjectScaffoldModule from './project/scaffold'
import type * as QueueModule from './queue'
import type * as QueueMigrationsModule from './queue-migrations'
import type * as RuntimeModule from './runtime'
import type * as SecurityModule from './security'

export type RuntimeExecutor = typeof RuntimeModule.withRuntimeEnvironment
export type ProjectCommandExecutors = {
  runProjectPrepare?: typeof DevModule.runProjectPrepare
  runProjectDevServer?: typeof DevModule.runProjectDevServer
  runProjectBuild?: typeof DevModule.runProjectBuild
  runProjectStartServer?: typeof DevModule.runProjectStartServer
  runProjectDependencyInstall?: typeof DevModule.runProjectDependencyInstall
}
export type QueueCommandExecutors = {
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
export type CacheCommandExecutors = {
  runCacheTableCommand?: typeof CacheMigrationsModule.runCacheTableCommand
  runCacheClearCommand?: typeof CacheModule.runCacheClearCommand
  runCacheForgetCommand?: typeof CacheModule.runCacheForgetCommand
}
export type MediaCommandExecutors = {
  runMediaTableCommand?: typeof MediaMigrationsModule.runMediaTableCommand
}
export type BroadcastCommandExecutors = {
  runBroadcastWorkCommand?: typeof BroadcastModule.runBroadcastWorkCommand
}
export type SecurityCommandExecutors = {
  runRateLimitClearCommand?: typeof SecurityModule.runRateLimitClearCommand
}

let runtimeModulePromise: Promise<typeof RuntimeModule> | undefined
let queueModulePromise: Promise<typeof QueueModule> | undefined
let cacheModulePromise: Promise<typeof CacheModule> | undefined
let queueMigrationsModulePromise: Promise<typeof QueueMigrationsModule> | undefined
let cacheMigrationsModulePromise: Promise<typeof CacheMigrationsModule> | undefined
let mediaMigrationsModulePromise: Promise<typeof MediaMigrationsModule> | undefined
let generatorsModulePromise: Promise<typeof GeneratorsModule> | undefined
let broadcastModulePromise: Promise<typeof BroadcastModule> | undefined
let securityModulePromise: Promise<typeof SecurityModule> | undefined
let devModulePromise: Promise<typeof DevModule> | undefined
let projectConfigModulePromise: Promise<typeof ProjectConfigModule> | undefined
let projectDiscoveryModulePromise: Promise<typeof ProjectDiscoveryModule> | undefined
let projectPluginsModulePromise: Promise<typeof ProjectPluginsModule> | undefined
let projectRuntimeModulePromise: Promise<typeof ProjectRuntimeModule> | undefined
let projectScaffoldModulePromise: Promise<typeof ProjectScaffoldModule> | undefined
let agentSkillsModulePromise: Promise<typeof AgentSkillsModule> | undefined

export function loadRuntimeModule(): Promise<typeof RuntimeModule> {
  runtimeModulePromise ??= import('./runtime')
  return runtimeModulePromise
}

export function loadSecurityModule(): Promise<typeof SecurityModule> {
  securityModulePromise ??= import('./security')
  return securityModulePromise
}

export function loadProjectConfigModule(): Promise<typeof ProjectConfigModule> {
  projectConfigModulePromise ??= import('./project/config')
  return projectConfigModulePromise
}

export function loadProjectDiscoveryModule(): Promise<typeof ProjectDiscoveryModule> {
  projectDiscoveryModulePromise ??= import('./project/discovery')
  return projectDiscoveryModulePromise
}

export function loadProjectPluginsModule(): Promise<typeof ProjectPluginsModule> {
  projectPluginsModulePromise ??= import('./project/plugins')
  return projectPluginsModulePromise
}

export function loadProjectRuntimeModule(): Promise<typeof ProjectRuntimeModule> {
  projectRuntimeModulePromise ??= import('./project/runtime')
  return projectRuntimeModulePromise
}

export function loadProjectScaffoldModule(): Promise<typeof ProjectScaffoldModule> {
  projectScaffoldModulePromise ??= import('./project/scaffold')
  return projectScaffoldModulePromise
}

export function loadAgentSkillsModule(): Promise<typeof AgentSkillsModule> {
  agentSkillsModulePromise ??= import('./agent-skills')
  return agentSkillsModulePromise
}

export async function resolveRuntimeExecutor(runtimeExecutor?: RuntimeExecutor): Promise<RuntimeExecutor> {
  runtimeModulePromise ??= import('./runtime')
  return runtimeExecutor ?? (await runtimeModulePromise).withRuntimeEnvironment
}

async function resolveExecutor<
  TExecutors extends Readonly<Record<string, unknown>>,
  TKey extends keyof TExecutors & string,
>(
  executors: TExecutors,
  loader: () => Promise<NonNullable<TExecutors[TKey]>>,
  key: TKey,
): Promise<NonNullable<TExecutors[TKey]>> {
  const existing = executors[key]
  return existing ? existing as NonNullable<TExecutors[TKey]> : await loader()
}

export async function resolveProjectExecutor<TKey extends keyof ProjectCommandExecutors>(
  executors: ProjectCommandExecutors,
  key: TKey,
): Promise<NonNullable<ProjectCommandExecutors[TKey]>> {
  devModulePromise ??= import('./dev')
  return resolveExecutor(executors, async () => (await devModulePromise!)[key], key)
}

export async function resolveQueueExecutor<TKey extends keyof QueueCommandExecutors>(
  executors: QueueCommandExecutors,
  key: TKey,
): Promise<NonNullable<QueueCommandExecutors[TKey]>> {
  return resolveExecutor(executors, async () => {
    if (key === 'runQueueFailedTableCommand' || key === 'runQueueTableCommand') {
      queueMigrationsModulePromise ??= import('./queue-migrations')
      const migrations = await queueMigrationsModulePromise
      return (key === 'runQueueFailedTableCommand'
        ? migrations.runQueueFailedTableCommand
        : migrations.runQueueTableCommand) as NonNullable<QueueCommandExecutors[TKey]>
    }

    queueModulePromise ??= import('./queue')
    const queue = await queueModulePromise
    const resolved = {
      runQueueFailedCommand: queue.runQueueFailedCommand,
      runQueueFlushCommand: queue.runQueueFlushCommand,
      runQueueWorkCommand: queue.runQueueWorkCommand,
      runQueueForgetCommand: queue.runQueueForgetCommand,
      runQueueListen: queue.runQueueListen,
      runQueueRestartCommand: queue.runQueueRestartCommand,
      runQueueRetryCommand: queue.runQueueRetryCommand,
      runQueueClearCommand: queue.runQueueClearCommand,
    }
    return resolved[key as keyof typeof resolved] as NonNullable<QueueCommandExecutors[TKey]>
  }, key)
}

export async function resolveCacheExecutor<TKey extends keyof CacheCommandExecutors>(
  executors: CacheCommandExecutors,
  key: TKey,
): Promise<NonNullable<CacheCommandExecutors[TKey]>> {
  return resolveExecutor(executors, async () => {
    if (key === 'runCacheTableCommand') {
      cacheMigrationsModulePromise ??= import('./cache-migrations')
      return (await cacheMigrationsModulePromise).runCacheTableCommand as NonNullable<CacheCommandExecutors[TKey]>
    }
    cacheModulePromise ??= import('./cache')
    const cache = await cacheModulePromise
    const resolved = {
      runCacheClearCommand: cache.runCacheClearCommand,
      runCacheForgetCommand: cache.runCacheForgetCommand,
    }
    return resolved[key as keyof typeof resolved] as NonNullable<CacheCommandExecutors[TKey]>
  }, key)
}

export async function resolveMediaExecutor<TKey extends keyof MediaCommandExecutors>(
  executors: MediaCommandExecutors,
  key: TKey,
): Promise<NonNullable<MediaCommandExecutors[TKey]>> {
  mediaMigrationsModulePromise ??= import('./media-migrations')
  return resolveExecutor(executors, async () => (await mediaMigrationsModulePromise!)[key], key)
}

export async function resolveBroadcastExecutor<TKey extends keyof BroadcastCommandExecutors>(
  executors: BroadcastCommandExecutors,
  key: TKey,
): Promise<NonNullable<BroadcastCommandExecutors[TKey]>> {
  broadcastModulePromise ??= import('./broadcast')
  return resolveExecutor(executors, async () => (await broadcastModulePromise!)[key], key)
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

export async function resolveGeneratorCommand<TKey extends GeneratorCommandKey>(
  key: TKey,
): Promise<typeof GeneratorsModule[TKey]> {
  generatorsModulePromise ??= import('./generators')
  return (await generatorsModulePromise)[key]
}
