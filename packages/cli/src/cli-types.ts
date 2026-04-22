import type { watch } from 'node:fs'
import type { loadConfigDirectory } from '@holo-js/config'
import type { HoloRuntime } from '@holo-js/core'
import type { QueueWorkerRunOptions } from '@holo-js/queue'
import type { LoadedProjectConfig, CommandFlagValue, CommandExecutionContext } from './types'
import type {
  SupportedScaffoldFramework,
  SupportedScaffoldPackageManager,
  SupportedScaffoldStorageDisk,
  SupportedScaffoldOptionalPackage,
  SupportedCacheInstallerDriver,
  SupportedQueueInstallerDriver,
  ProjectScaffoldOptions,
  DiscoveredAppCommand,
} from './project'

export type {
  SupportedScaffoldFramework,
  SupportedScaffoldPackageManager,
  SupportedScaffoldStorageDisk,
  SupportedScaffoldOptionalPackage,
  SupportedCacheInstallerDriver,
  SupportedQueueInstallerDriver,
  ProjectScaffoldOptions,
  DiscoveredAppCommand,
}

export type IoStreams = {
  readonly cwd: string
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

export type RawParsedInput = {
  readonly args: readonly string[]
  readonly flags: Record<string, string | boolean | readonly string[]>
}

export type PreparedInput = {
  readonly args: readonly string[]
  readonly flags: Record<string, CommandFlagValue>
}

export type CommandDefinition = {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly usage: string
  readonly source: 'internal' | 'app'
  prepare?(input: RawParsedInput, context: InternalCommandContext): Promise<PreparedInput>
  run(context: CommandExecutionContext): Promise<void>
}

export type InternalCommandContext = IoStreams & {
  readonly projectRoot: string
  readonly registry: readonly CommandDefinition[]
  loadProject(): Promise<LoadedProjectConfig>
}

export type RuntimeEnvironment = {
  readonly project: LoadedProjectConfig
  readonly bundledModels: readonly string[]
  readonly bundledMigrations: readonly string[]
  readonly bundledSeeders: readonly string[]
  readonly bundledGeneratedSchema?: string
  cleanup(): Promise<void>
}

export type QueueRuntimeEnvironment = {
  readonly runtime: HoloRuntime
  readonly project: LoadedProjectConfig
  readonly bundledJobs: readonly string[]
  cleanup(): Promise<void>
}

export type QueueMaintenanceEnvironment = {
  cleanup(): Promise<void>
}

export type ProjectRuntimeInitializationOptions = {
  readonly registerProjectQueueJobs?: boolean
}

export type RuntimeSpawnResult = {
  readonly status: number | null
  readonly error?: Error | ({ code?: string } & Record<string, unknown>) | null
  readonly stdout?: string
  readonly stderr?: string
}

export type NewProjectInput = {
  readonly projectName: string
  readonly framework: SupportedScaffoldFramework
  readonly databaseDriver: ProjectScaffoldOptions['databaseDriver']
  readonly packageManager: SupportedScaffoldPackageManager
  readonly storageDefaultDisk: SupportedScaffoldStorageDisk
  readonly optionalPackages: readonly SupportedScaffoldOptionalPackage[]
}

export type QueueCliModule = {
  clearQueueConnection(
    connectionName?: string,
    options?: { queueNames?: readonly string[] },
  ): Promise<number>
  configureQueueRuntime(options: {
    config: Awaited<ReturnType<typeof loadConfigDirectory>>['queue']
    redisConfig?: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
  } & Record<string, unknown>): void
  flushFailedQueueJobs(): Promise<number>
  forgetFailedQueueJob(identifier: string): Promise<boolean>
  getRegisteredQueueJob(name: string): { sourcePath?: string } | undefined
  isQueueJobDefinition(value: unknown): boolean
  listFailedQueueJobs(): Promise<readonly {
    id: string
    failedAt: number
    job: {
      name: string
      connection: string
      queue: string
    }
  }[]>
  normalizeQueueJobDefinition(value: unknown): {
    connection?: string
    queue?: string
    tries?: number
    backoff?: number | readonly number[]
    timeout?: number
  }
  registerQueueJob(
    definition: unknown,
    options: { name: string, sourcePath?: string },
  ): void
  retryFailedQueueJobs(identifier: string): Promise<number>
  runQueueWorker(options: QueueWorkerRunOptions): Promise<{
    stoppedBecause: string
    processed: number
    released: number
    failed: number
  }>
  shutdownQueueRuntime(): Promise<void>
}

export type RuntimeMigrationCandidate = {
  readonly name?: unknown
  up(...args: unknown[]): unknown
}

export type PackageManagerCommand = {
  readonly command: string
  readonly args: readonly string[]
}

export type SpawnProcessLike = {
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
  stdin?: NodeJS.WritableStream | null
  kill?(signal?: NodeJS.Signals | number): boolean
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type WatchFactory = typeof watch
export type WatchHandle = ReturnType<WatchFactory>
