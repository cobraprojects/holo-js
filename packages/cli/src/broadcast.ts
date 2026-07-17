import { basename, extname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { loadConfigDirectory } from '@holo-js/config'
import type {} from '@holo-js/broadcast/config'
import {
  loadGeneratedProjectRegistry,
  loadProjectConfig,
  prepareProjectDiscovery,
  resolveProjectPackageImportSpecifier,
} from './project'
import { importProjectModule } from './project/runtime'
import { initializeProjectRuntime } from './runtime'
import { writeLine } from './io'
import type { IoStreams } from './cli-types'
import type { HoloRuntime } from '@holo-js/core'

type BroadcastCliModule = {
  startBroadcastWorker(bindings: {
    config: Awaited<ReturnType<typeof loadConfigDirectory>>['broadcast']
    queue?: Awaited<ReturnType<typeof loadConfigDirectory>>['queue']
    redis?: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
    channelAuth?: {
      registry?: {
        projectRoot: string
        channels: readonly {
          sourcePath: string
          pattern: string
          exportName?: string
          type: 'private' | 'presence'
          params: readonly string[]
          whispers: readonly string[]
        }[]
      }
      importModule?: (absolutePath: string) => Promise<unknown>
    }
    realtime?: BroadcastRealtimeRuntimeBindings
  }): Promise<{
    host: string
    port: number
    stop(): Promise<void>
  }>
}

type BroadcastRealtimeExecutionContext = {
  readonly headers: Headers
  readonly socketId: string
  readonly appId: string
  readonly connection: string
}

type BroadcastRealtimeExecutionResult = {
  readonly name: string
  readonly data: unknown
  readonly dependencies: readonly string[]
}

type BroadcastRealtimeSubscriptionSnapshot = BroadcastRealtimeExecutionResult & {
  readonly version: number
}

type RealtimeReplacePatchOperation = {
  readonly op: 'replace'
  readonly path: readonly (string | number)[]
  readonly value: unknown
}

type RealtimeMergePatchOperation = {
  readonly op: 'merge'
  readonly path: readonly (string | number)[]
  readonly fields: Readonly<Record<string, unknown>>
}

type RealtimeSplicePatchOperation = {
  readonly op: 'splice'
  readonly path: readonly (string | number)[]
  readonly index: number
  readonly deleteCount: number
  readonly values: readonly unknown[]
}

type RealtimeMovePatchOperation = {
  readonly op: 'move'
  readonly path: readonly (string | number)[]
  readonly from: number
  readonly to: number
}

type RealtimePatchOperation =
  | RealtimeReplacePatchOperation
  | RealtimeMergePatchOperation
  | RealtimeSplicePatchOperation
  | RealtimeMovePatchOperation

type RealtimeSubscriptionPatch = {
  readonly dependencies?: readonly string[]
  readonly operations: readonly RealtimePatchOperation[]
  readonly version: number
}

type BroadcastRealtimeSubscription = {
  readonly id: string
  readonly current: BroadcastRealtimeSubscriptionSnapshot
  unsubscribe(): void
}

type BroadcastRealtimeRuntimeBindings = {
  query(
    name: string,
    args: Record<string, unknown>,
    context: BroadcastRealtimeExecutionContext,
  ): Promise<BroadcastRealtimeExecutionResult>
  mutate(
    name: string,
    args: Record<string, unknown>,
    context: BroadcastRealtimeExecutionContext,
  ): Promise<BroadcastRealtimeExecutionResult>
  subscribe(
    name: string,
    args: Record<string, unknown>,
    options: {
      readonly context: BroadcastRealtimeExecutionContext
      readonly onData: (snapshot: BroadcastRealtimeSubscriptionSnapshot) => void | Promise<void>
      readonly onPatch?: (patch: RealtimeSubscriptionPatch) => void | Promise<void>
      readonly onError: (error: unknown) => void | Promise<void>
    },
  ): Promise<BroadcastRealtimeSubscription>
}

type RealtimeAuthRequestAccessors = {
  getCookie(name: string): Promise<string | undefined>
  getHeader(name: string): Promise<string | undefined>
  appendResponseCookie(cookie: string): Promise<void>
  redirectResponse(url: string, status?: 301 | 302 | 303 | 307 | 308): Promise<void>
}

type RealtimeServerModule = {
  configureRealtimeRuntime?(bindings?: {
    runWithAuthRequestAccessors<TValue>(
      accessors: RealtimeAuthRequestAccessors,
      callback: () => Promise<TValue>,
    ): Promise<TValue>
  }): void
  resolveRealtimeDefinition(
    name: string,
    options: {
      readonly projectRoot: string
      readonly importModule?: (absolutePath: string) => Promise<unknown>
    },
  ): Promise<unknown>
  executeRealtimeQuery(
    definition: unknown,
    args: Record<string, unknown>,
    options?: { readonly authRequest?: RealtimeAuthRequestAccessors },
  ): Promise<BroadcastRealtimeExecutionResult>
  executeRealtimeMutation(
    definition: unknown,
    args: Record<string, unknown>,
    options?: { readonly authRequest?: RealtimeAuthRequestAccessors },
  ): Promise<BroadcastRealtimeExecutionResult>
  subscribeRealtimeQuery(
    definition: unknown,
    args: Record<string, unknown>,
    options: {
      readonly onData?: (snapshot: BroadcastRealtimeSubscriptionSnapshot) => void | Promise<void>
      readonly onPatch?: (patch: RealtimeSubscriptionPatch) => void | Promise<void>
      readonly onError?: (error: unknown) => void | Promise<void>
    },
    executionOptions?: { readonly authRequest?: RealtimeAuthRequestAccessors },
  ): Promise<BroadcastRealtimeSubscription>
}

type RequestAwareHoloRuntime = HoloRuntime & {
  setAuthRequestAccessors?(accessors?: RealtimeAuthRequestAccessors): void
  runWithAuthRequestAccessors?<TValue>(
    accessors: RealtimeAuthRequestAccessors,
    callback: () => Promise<TValue>,
  ): Promise<TValue>
}

type ProjectPackageManifest = {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

function hasLoadedRedisConfigSection(loadedFiles: readonly string[] | undefined): boolean {
  return Array.isArray(loadedFiles) && loadedFiles.some((filePath) => {
    return basename(filePath, extname(filePath)) === 'redis'
  })
}

async function hasProjectPackageDependency(projectRoot: string, packageName: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8')) as ProjectPackageManifest
    return Boolean(
      manifest.dependencies?.[packageName]
      || manifest.devDependencies?.[packageName]
      || manifest.optionalDependencies?.[packageName]
      || manifest.peerDependencies?.[packageName],
    )
  } catch {
    return false
  }
}

export async function loadBroadcastCliModule(projectRoot: string): Promise<BroadcastCliModule> {
  try {
    return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/broadcast')) as BroadcastCliModule
  } catch (error) {
    /* v8 ignore next -- defensive String(error) fallback for non-Error throws */
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to load @holo-js/broadcast from ${projectRoot}. Install it with "holo install broadcast". ${details}`,
    )
  }
}

async function loadRealtimeServerModule(projectRoot: string): Promise<RealtimeServerModule | null> {
  const specifier = resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/realtime/server')
  try {
    return await import(specifier) as RealtimeServerModule
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i.test(details) && details.includes(specifier)) {
      return null
    }

    throw error
  }
}

function safeDecodeCookieSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function readCookieFromHeader(header: string | null, name: string): string | undefined {
  for (const segment of header?.split(';') ?? []) {
    const separator = segment.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const cookieName = safeDecodeCookieSegment(segment.slice(0, separator).trim())
    if (cookieName === name) {
      return safeDecodeCookieSegment(segment.slice(separator + 1).trim())
    }
  }

  return undefined
}

function createRealtimeAuthRequestAccessors(headers: Headers): RealtimeAuthRequestAccessors {
  return {
    async getCookie(name: string) {
      return readCookieFromHeader(headers.get('cookie'), name)
    },
    async getHeader(name: string) {
      return headers.get(name) ?? undefined
    },
    async appendResponseCookie(_cookie: string) {},
    async redirectResponse(url: string) {
      throw new Error(`Realtime auth attempted to redirect to "${url}". Realtime requests cannot redirect.`)
    },
  }
}

async function createRealtimeWorkerBindings(projectRoot: string): Promise<BroadcastRealtimeRuntimeBindings | undefined> {
  if (!(await hasProjectPackageDependency(projectRoot, '@holo-js/realtime'))) {
    return undefined
  }

  const realtime = await loadRealtimeServerModule(projectRoot)
  if (!realtime) {
    return undefined
  }

  const runtime = await initializeProjectRuntime(projectRoot) as RequestAwareHoloRuntime
  realtime.configureRealtimeRuntime?.({
    async runWithAuthRequestAccessors(accessors, callback) {
      const runner = runtime.runWithAuthRequestAccessors
      return runner ? await runner(accessors, callback) : await callback()
    },
  })
  const definitions = new Map<string, Promise<unknown>>()
  const resolveDefinition = async (name: string): Promise<unknown> => {
    const cached = definitions.get(name)
    if (cached) {
      return await cached
    }

    const resolved = realtime.resolveRealtimeDefinition(name, {
      projectRoot,
      importModule: async (absolutePath: string) => await importProjectModule(projectRoot, absolutePath),
    }).catch((error) => {
      definitions.delete(name)
      throw error
    })
    definitions.set(name, resolved)
    return await resolved
  }
  const withRealtimeRequest = async <TValue>(
    context: BroadcastRealtimeExecutionContext,
    callback: (authRequest: RealtimeAuthRequestAccessors) => Promise<TValue>,
  ): Promise<TValue> => {
    return await callback(createRealtimeAuthRequestAccessors(context.headers))
  }

  return {
    async query(name, args, context) {
      return await withRealtimeRequest(context, async (authRequest) => {
        return await realtime.executeRealtimeQuery(await resolveDefinition(name), args, { authRequest })
      })
    },
    async mutate(name, args, context) {
      return await withRealtimeRequest(context, async (authRequest) => {
        return await realtime.executeRealtimeMutation(await resolveDefinition(name), args, { authRequest })
      })
    },
    async subscribe(name, args, options) {
      return await withRealtimeRequest(options.context, async (authRequest) => {
        return await realtime.subscribeRealtimeQuery(await resolveDefinition(name), args, {
          onData: options.onData,
          onPatch: options.onPatch,
          onError: options.onError,
        }, { authRequest })
      })
    },
  }
}

export async function runBroadcastWorkCommand(
  io: IoStreams,
  projectRoot: string,
  dependencies: {
    loadConfig?: typeof loadConfigDirectory
    loadModule?: typeof loadBroadcastCliModule
    loadRegistry?: typeof loadGeneratedProjectRegistry
  } = {},
): Promise<void> {
  const loadConfig = dependencies.loadConfig ?? loadConfigDirectory
  const loadModule = dependencies.loadModule ?? loadBroadcastCliModule
  const config = await loadConfig(projectRoot)
  const project = await loadProjectConfig(projectRoot)
  const loadRegistry = dependencies.loadRegistry ?? loadGeneratedProjectRegistry
  await loadRegistry(projectRoot).catch(() => undefined)
  const registry = await prepareProjectDiscovery(projectRoot, project.config)
  const broadcastModule = await loadModule(projectRoot)
  const realtime = await createRealtimeWorkerBindings(projectRoot)
  const worker = await broadcastModule.startBroadcastWorker({
    config: config.broadcast,
    queue: config.queue,
    ...(hasLoadedRedisConfigSection(config.loadedFiles)
      ? { redis: config.redis }
      : {}),
    ...(registry
      ? {
        channelAuth: {
          registry: {
            projectRoot,
            channels: registry.channels,
          },
          importModule: async (absolutePath: string) => await importProjectModule(projectRoot, absolutePath),
        },
      }
      : {}),
    ...(realtime ? { realtime } : {}),
  })

  writeLine(io.stdout, `[broadcast] Worker listening on ${worker.host}:${worker.port}`)

  await new Promise<void>((resolvePromise) => {
    let stopped = false
    const stop = async () => {
      if (stopped) {
        return
      }

      stopped = true
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      await worker.stop()
      resolvePromise()
    }

    const onSignal = () => {
      void stop()
    }

    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}
