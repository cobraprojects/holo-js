import { resolve } from 'node:path'
import {
  config as globalConfig,
  configureConfigRuntime,
  createConfigAccessors,
  loadConfigDirectory,
  resetConfigRuntime,
  useConfig as globalUseConfig,
  type DotPath,
  type LoadedHoloConfig,
  type HoloConfigMap,
  type ValueAtPath,
} from '@holo-js/config'
import {
  configureDB,
  resetDB,
} from '@holo-js/db'
import { resolveRuntimeConnectionManagerOptions } from './dbRuntime'
import { loadGeneratedProjectRegistry, type GeneratedProjectRegistry } from './registry'
import { importBundledRuntimeModule } from '../runtimeModule'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime } from '../storageRuntime'

type RuntimeConfigRegistry<TCustom extends HoloConfigMap> = LoadedHoloConfig<TCustom>['all']
type PortableRuntimeConfig<TCustom extends HoloConfigMap> = {
  readonly db: LoadedHoloConfig<TCustom>['database']
  readonly queue: LoadedHoloConfig<TCustom>['queue']
}

export interface HoloQueueRuntimeBinding {
  readonly config: LoadedHoloConfig['queue']
  readonly drivers: ReadonlyMap<string, HoloQueueDriverBinding>
}

export interface HoloQueueDriverBinding {
  readonly name: string
  readonly driver: string
  readonly mode: 'async' | 'sync'
}

type QueueModule = {
  configureQueueRuntime(options: { config: LoadedHoloConfig['queue'] } & Record<string, unknown>): void
  getRegisteredQueueJob(name: string): { sourcePath?: string } | undefined
  getQueueRuntime(): HoloQueueRuntimeBinding
  isQueueJobDefinition(value: unknown): boolean
  normalizeQueueJobDefinition(value: unknown): NormalizedQueueJobDefinition
  registerQueueJob(
    definition: NormalizedQueueJobDefinition,
    options: { name: string, sourcePath?: string, replaceExisting?: boolean },
  ): void
  shutdownQueueRuntime(): Promise<void>
  unregisterQueueJob(name: string): void
}

type QueueDbModule = {
  createQueueDbRuntimeOptions(): Record<string, unknown>
}

type EventsModule = {
  ensureEventsQueueJobRegisteredAsync?(): Promise<void>
  getRegisteredEvent(name: string): { sourcePath?: string } | undefined
  getRegisteredListener(id: string): { sourcePath?: string } | undefined
  isEventDefinition(value: unknown): boolean
  isListenerDefinition(value: unknown): boolean
  normalizeListenerDefinition(value: unknown): NormalizedListenerDefinition
  registerEvent(
    definition: unknown,
    options: { name: string, sourcePath?: string, replaceExisting?: boolean },
  ): void
  registerListener(
    definition: NormalizedListenerDefinition,
    options: { id: string, sourcePath?: string, replaceExisting?: boolean },
  ): void
  unregisterEvent(name: string): void
  unregisterListener(id: string): void
}

type PortableConnectionManager = ReturnType<typeof resolveRuntimeConnectionManagerOptions>

type NormalizedQueueJobDefinition = {
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
}

type NormalizedListenerDefinition = {
  readonly name?: string
  readonly queue?: boolean
  readonly [key: string]: unknown
}

export interface CreateHoloOptions {
  readonly envName?: string
  readonly preferCache?: boolean
  readonly processEnv?: NodeJS.ProcessEnv
  readonly registerProjectQueueJobs?: boolean
}

export interface HoloRuntime<TCustom extends HoloConfigMap = HoloConfigMap> {
  readonly projectRoot: string
  readonly loadedConfig: LoadedHoloConfig<TCustom>
  readonly registry?: GeneratedProjectRegistry
  readonly manager: PortableConnectionManager
  readonly runtimeConfig: PortableRuntimeConfig<TCustom>
  readonly queue: HoloQueueRuntimeBinding
  readonly initialized: boolean
  initialize(): Promise<void>
  shutdown(): Promise<void>
  useConfig<TKey extends Extract<keyof RuntimeConfigRegistry<TCustom>, string>>(
    key: TKey,
  ): RuntimeConfigRegistry<TCustom>[TKey]
  useConfig<TPath extends DotPath<RuntimeConfigRegistry<TCustom>>>(
    path: TPath,
  ): ValueAtPath<RuntimeConfigRegistry<TCustom>, TPath>
  config<TPath extends DotPath<RuntimeConfigRegistry<TCustom>>>(
    path: TPath,
  ): ValueAtPath<RuntimeConfigRegistry<TCustom>, TPath>
}

type MutableHoloRuntime<TCustom extends HoloConfigMap> = {
  -readonly [TKey in keyof HoloRuntime<TCustom>]: HoloRuntime<TCustom>[TKey]
}

function getRuntimeState(): {
  current?: HoloRuntime
  pending?: Promise<HoloRuntime>
  pendingProjectRoot?: string
} {
  const runtime = globalThis as typeof globalThis & {
    __holoRuntime__?: {
      current?: HoloRuntime
      pending?: Promise<HoloRuntime>
      pendingProjectRoot?: string
    }
  }

  runtime.__holoRuntime__ ??= {}
  return runtime.__holoRuntime__
}

/* v8 ignore next 15 -- optional-package absence is validated in published-package integration, not in this monorepo test graph */
async function importOptionalModule<TModule>(specifier: string): Promise<TModule | undefined> {
  try {
    return await import(specifier) as TModule
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return undefined
    }

    throw error
  }
}

const portableRuntimeModuleInternals = {
  importOptionalModule,
}

function hasLoadedConfigFile<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
  configName: string,
): boolean {
  return loadedConfig.loadedFiles.some((filePath) => {
    const normalizedPath = filePath.replaceAll('\\', '/')
    return normalizedPath.endsWith(`/config/${configName}.ts`)
      || normalizedPath.endsWith(`/config/${configName}.mts`)
      || normalizedPath.endsWith(`/config/${configName}.js`)
      || normalizedPath.endsWith(`/config/${configName}.mjs`)
      || normalizedPath.endsWith(`/config/${configName}.cts`)
      || normalizedPath.endsWith(`/config/${configName}.cjs`)
  })
}

function queueConfigUsesDatabaseDriver<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  return Object.values(loadedConfig.queue.connections).some(connection => connection.driver === 'database')
}

function queueConfigUsesDatabaseBackedFailedStore<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  return loadedConfig.queue.failed !== false
}

function registryHasJobs(registry: GeneratedProjectRegistry | undefined): boolean {
  return (registry?.jobs.length ?? 0) > 0
}

function registryHasEvents(registry: GeneratedProjectRegistry | undefined): boolean {
  return (registry?.events.length ?? 0) > 0 || (registry?.listeners.length ?? 0) > 0
}

async function loadQueueModule(required = false): Promise<QueueModule | undefined> {
  const queueModule = await portableRuntimeModuleInternals.importOptionalModule<QueueModule>('@holo-js/queue')
  /* v8 ignore next 3 -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!queueModule && required) {
    throw new Error('[@holo-js/core] Queue support requires @holo-js/queue to be installed.')
  }

  return queueModule
}

async function loadQueueDbModule(): Promise<QueueDbModule | undefined> {
  return portableRuntimeModuleInternals.importOptionalModule<QueueDbModule>('@holo-js/queue-db')
}

async function loadEventsModule(required = false): Promise<EventsModule | undefined> {
  const eventsModule = await portableRuntimeModuleInternals.importOptionalModule<EventsModule>('@holo-js/events')
  /* v8 ignore next 3 -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!eventsModule && required) {
    throw new Error('[@holo-js/core] Events support requires @holo-js/events to be installed.')
  }

  return eventsModule
}

function resolveQueueJobExport(
  queueModule: QueueModule,
  moduleValue: unknown,
): unknown {
  const exports = moduleValue as Record<string, unknown>
  if (queueModule.isQueueJobDefinition(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => queueModule.isQueueJobDefinition(value))
}

const HOLO_EVENT_DEFINITION_MARKER = Symbol.for('holo-js.events.definition')
const HOLO_LISTENER_DEFINITION_MARKER = Symbol.for('holo-js.events.listener')

function hasEventDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_EVENT_DEFINITION_MARKER in value
}

function hasListenerDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_LISTENER_DEFINITION_MARKER in value
}

function resolveEventExport(moduleValue: unknown): unknown {
  const exports = moduleValue as Record<string, unknown>
  if (hasEventDefinitionMarker(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => hasEventDefinitionMarker(value))
}

function resolveListenerExport(
  eventsModule: EventsModule,
  moduleValue: unknown,
): unknown {
  const exports = moduleValue as Record<string, unknown>
  if (hasListenerDefinitionMarker(exports.default) || eventsModule.isListenerDefinition(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => hasListenerDefinitionMarker(value) || eventsModule.isListenerDefinition(value))
}

async function importRuntimeModule(projectRoot: string, filePath: string): Promise<unknown> {
  return importBundledRuntimeModule(projectRoot, filePath)
}

async function registerProjectQueueJobs(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
  queueModule: QueueModule,
): Promise<readonly string[]> {
  /* v8 ignore next 4 -- initialization short-circuits before calling this helper when no jobs are present */
  if (!registry || registry.jobs.length === 0) {
    return Object.freeze([])
  }

  const registeredJobNames: string[] = []
  try {
    for (const entry of registry.jobs) {
      const existing = queueModule.getRegisteredQueueJob(entry.name)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const job = resolveQueueJobExport(queueModule, moduleValue)
      if (!job) {
        throw new Error(`Discovered job "${entry.sourcePath}" does not export a Holo job.`)
      }

      queueModule.registerQueueJob(queueModule.normalizeQueueJobDefinition(job), {
        name: entry.name,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredJobNames.push(entry.name)
    }
  } catch (error) {
    unregisterProjectQueueJobs(queueModule, registeredJobNames)
    throw error
  }

  return Object.freeze(registeredJobNames)
}

function unregisterProjectQueueJobs(
  queueModule: QueueModule | undefined,
  jobNames: readonly string[],
): void {
  if (!queueModule) {
    return
  }

  for (const jobName of jobNames) {
    queueModule.unregisterQueueJob(jobName)
  }
}

async function registerProjectEventsAndListeners(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
  eventsModule: EventsModule,
  queueModule: QueueModule | undefined,
): Promise<{ readonly eventNames: readonly string[], readonly listenerIds: readonly string[] }> {
  /* v8 ignore next 6 -- initialization short-circuits before calling this helper when no events or listeners are present */
  if (!registry || (registry.events.length === 0 && registry.listeners.length === 0)) {
    return Object.freeze({
      eventNames: Object.freeze([]),
      listenerIds: Object.freeze([]),
    })
  }

  const registeredEventNames: string[] = []
  const registeredListenerIds: string[] = []
  let requiresQueuedListeners = false

  try {
    for (const entry of registry.events) {
      const existing = eventsModule.getRegisteredEvent(entry.name)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const event = resolveEventExport(moduleValue)
      if (!event || !eventsModule.isEventDefinition(event)) {
        throw new Error(`Discovered event "${entry.sourcePath}" does not export a Holo event.`)
      }

      eventsModule.registerEvent(event, {
        name: entry.name,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredEventNames.push(entry.name)
    }

    for (const entry of registry.listeners) {
      const existing = eventsModule.getRegisteredListener(entry.id)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const listener = resolveListenerExport(eventsModule, moduleValue)
      if (!listener) {
        throw new Error(`Discovered listener "${entry.sourcePath}" does not export a Holo listener.`)
      }

      const normalizedListener = eventsModule.normalizeListenerDefinition(listener)
      if (normalizedListener.queue === true) {
        requiresQueuedListeners = true
        /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
        if (!queueModule) {
          throw new Error('[@holo-js/core] Queued listeners require @holo-js/queue to be installed.')
        }
        /* v8 ignore stop */
      }

      eventsModule.registerListener({
        ...normalizedListener,
        listensTo: entry.eventNames,
      }, {
        id: entry.id,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredListenerIds.push(entry.id)
    }

    if (requiresQueuedListeners) {
      await eventsModule.ensureEventsQueueJobRegisteredAsync?.()
    }
  } catch (error) {
    unregisterProjectEventsAndListeners(eventsModule, registeredEventNames, registeredListenerIds)
    throw error
  }

  return Object.freeze({
    eventNames: Object.freeze(registeredEventNames),
    listenerIds: Object.freeze(registeredListenerIds),
  })
}

function unregisterProjectEventsAndListeners(
  eventsModule: EventsModule | undefined,
  eventNames: readonly string[],
  listenerIds: readonly string[],
): void {
  if (!eventsModule) {
    return
  }

  for (const listenerId of listenerIds) {
    eventsModule.unregisterListener(listenerId)
  }

  for (const eventName of eventNames) {
    eventsModule.unregisterEvent(eventName)
  }
}

export async function reconfigureOptionalHoloSubsystems<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
): Promise<{ readonly queueModule?: QueueModule }> {
  const queueConfigured = hasLoadedConfigFile(loadedConfig, 'queue')
  const queueModule = await loadQueueModule(queueConfigured)
  if (queueModule) {
    const queueUsesExplicitDatabaseFeatures = queueConfigured
      && (
        queueConfigUsesDatabaseDriver(loadedConfig)
        || queueConfigUsesDatabaseBackedFailedStore(loadedConfig)
      )
    const queueUsesImplicitDefaultFailedStore = !queueConfigured
      && queueConfigUsesDatabaseBackedFailedStore(loadedConfig)
    const queueDbModule = (queueUsesExplicitDatabaseFeatures || queueUsesImplicitDefaultFailedStore)
      ? await loadQueueDbModule()
      : undefined

    /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
    if (queueUsesExplicitDatabaseFeatures && !queueDbModule) {
      throw new Error('[@holo-js/core] Database-backed queue features require @holo-js/queue-db to be installed.')
    }
    /* v8 ignore stop */

    queueModule.configureQueueRuntime({
      config: loadedConfig.queue,
      ...(queueDbModule?.createQueueDbRuntimeOptions() ?? {}),
    })
  }

  const storageConfigured = hasLoadedConfigFile(loadedConfig, 'storage')
  const storageInstalled = !!await portableRuntimeModuleInternals.importOptionalModule<Record<string, unknown>>('@holo-js/storage')
  /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!storageInstalled && storageConfigured) {
    throw new Error('[@holo-js/core] Storage support requires @holo-js/storage to be installed.')
  }
  /* v8 ignore stop */

  if (storageInstalled) {
    await configurePlainNodeStorageRuntime(projectRoot, loadedConfig)
  }

  return Object.freeze({
    /* v8 ignore next -- only toggles shape when queue support is absent */
    ...(queueModule ? { queueModule } : {}),
  })
}

export async function resetOptionalHoloSubsystems(): Promise<void> {
  await resetOptionalStorageRuntime()
  const queueModule = await loadQueueModule()
  await queueModule?.shutdownQueueRuntime()
}

export async function createHolo<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloRuntime<TCustom>> {
  const loadedConfig = await loadConfigDirectory<TCustom>(projectRoot, {
    envName: options.envName,
    preferCache: options.preferCache,
    processEnv: options.processEnv,
  })
  const runtimeConfig: PortableRuntimeConfig<TCustom> = {
    db: loadedConfig.database,
    queue: loadedConfig.queue,
  }
  const manager = resolveRuntimeConnectionManagerOptions(runtimeConfig)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
  const accessors = createConfigAccessors(loadedConfig.all)
  const runtimeOwnedQueueJobNames: string[] = []
  const runtimeOwnedEventNames: string[] = []
  const runtimeOwnedListenerIds: string[] = []
  let activeQueueModule: QueueModule | undefined
  let activeEventsModule: EventsModule | undefined
  const fallbackQueueRuntime = Object.freeze({
    config: loadedConfig.queue,
    drivers: new Map<string, HoloQueueDriverBinding>(),
  }) as HoloQueueRuntimeBinding

  const runtime: MutableHoloRuntime<TCustom> = {
    projectRoot,
    loadedConfig,
    registry,
    manager,
    runtimeConfig,
    get queue() {
      return activeQueueModule?.getQueueRuntime() ?? fallbackQueueRuntime
    },
    initialized: false,
    useConfig: accessors.useConfig,
    config: accessors.config,
    async initialize() {
      if (runtime.initialized) {
        throw new Error('Holo runtime is already initialized.')
      }

      if (getRuntimeState().current) {
        throw new Error('A Holo runtime is already initialized for this process.')
      }

      configureConfigRuntime(loadedConfig.all)
      configureDB(manager)

      try {
        await manager.initializeAll()

        const optionalSubsystems = await reconfigureOptionalHoloSubsystems(projectRoot, loadedConfig)
        activeQueueModule = optionalSubsystems.queueModule
        /* v8 ignore start -- exercised only when optional packages are absent outside the monorepo test graph */
        const optionalEventsModule = activeQueueModule
          ? await loadEventsModule()
          : undefined
        if (activeQueueModule && optionalEventsModule) {
          await optionalEventsModule.ensureEventsQueueJobRegisteredAsync?.()
        }
        /* v8 ignore stop */

        if (registryHasEvents(registry)) {
          const eventsModule = await loadEventsModule(true)
          /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
          if (!eventsModule) {
            throw new Error('[@holo-js/core] Events support requires @holo-js/events to be installed.')
          }
          /* v8 ignore stop */
          activeEventsModule = eventsModule
          const eventRegistration = await registerProjectEventsAndListeners(
            projectRoot,
            registry,
            eventsModule,
            activeQueueModule,
          )
          runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length, ...eventRegistration.eventNames)
          runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length, ...eventRegistration.listenerIds)
        }

        if (options.registerProjectQueueJobs === true && registryHasJobs(registry)) {
          /* v8 ignore start -- exercised only when the optional package is absent outside the monorepo test graph */
          if (!activeQueueModule) {
            throw new Error('[@holo-js/core] Project jobs require @holo-js/queue to be installed.')
          }
          /* v8 ignore stop */

          runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
          runtimeOwnedQueueJobNames.push(...await registerProjectQueueJobs(projectRoot, registry, activeQueueModule))
        }

        runtime.initialized = true
        getRuntimeState().current = runtime
      } catch (error) {
        unregisterProjectEventsAndListeners(activeEventsModule, runtimeOwnedEventNames, runtimeOwnedListenerIds)
        runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length)
        runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length)
        unregisterProjectQueueJobs(activeQueueModule, runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        activeEventsModule = undefined
        activeQueueModule = undefined
        await manager.disconnectAll().catch(() => {})
        resetDB()
        await resetOptionalHoloSubsystems()
        resetConfigRuntime()
        getRuntimeState().current = undefined
        throw error
      }
    },
    async shutdown() {
      try {
        if (runtime.initialized) {
          await manager.disconnectAll()
        }
      } finally {
        runtime.initialized = false
        if (getRuntimeState().current === runtime) {
          getRuntimeState().current = undefined
        }
        unregisterProjectEventsAndListeners(activeEventsModule, runtimeOwnedEventNames, runtimeOwnedListenerIds)
        runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length)
        runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length)
        unregisterProjectQueueJobs(activeQueueModule, runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        activeEventsModule = undefined
        resetDB()
        await resetOptionalHoloSubsystems()
        resetConfigRuntime()
      }
    },
  }

  return runtime
}

export async function initializeHolo<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloRuntime<TCustom>> {
  const state = getRuntimeState()
  const resolvedProjectRoot = resolve(projectRoot)
  const current = state.current as HoloRuntime<TCustom> | undefined

  if (current) {
    if (resolve(current.projectRoot) !== resolvedProjectRoot) {
      throw new Error(`A Holo runtime is already initialized for "${current.projectRoot}".`)
    }

    return current
  }

  if (state.pending) {
    if (state.pendingProjectRoot && resolve(state.pendingProjectRoot) !== resolvedProjectRoot) {
      throw new Error(`A Holo runtime is already initializing for "${state.pendingProjectRoot}".`)
    }

    return state.pending as Promise<HoloRuntime<TCustom>>
  }

  const pending = (async () => {
    const runtime = await createHolo<TCustom>(projectRoot, options)
    await runtime.initialize()
    return runtime
  })()

  state.pending = pending as Promise<HoloRuntime>
  state.pendingProjectRoot = resolvedProjectRoot

  try {
    return await pending
  } finally {
    if (state.pending === pending) {
      state.pending = undefined
      state.pendingProjectRoot = undefined
    }
  }
}

export function peekHolo<TCustom extends HoloConfigMap = HoloConfigMap>(): HoloRuntime<TCustom> | undefined {
  return getRuntimeState().current as HoloRuntime<TCustom> | undefined
}

export async function ensureHolo<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: CreateHoloOptions = {},
): Promise<HoloRuntime<TCustom>> {
  const current = peekHolo<TCustom>()
  if (!current) {
    return initializeHolo<TCustom>(projectRoot, options)
  }

  if (resolve(current.projectRoot) !== resolve(projectRoot)) {
    throw new Error(`A Holo runtime is already initialized for "${current.projectRoot}".`)
  }

  return current
}

export function getHolo<TCustom extends HoloConfigMap = HoloConfigMap>(): HoloRuntime<TCustom> {
  const current = getRuntimeState().current as HoloRuntime<TCustom> | undefined
  if (!current) {
    throw new Error('Holo runtime is not initialized.')
  }

  return current
}

export async function resetHoloRuntime(): Promise<void> {
  const current = getRuntimeState().current
  getRuntimeState().pending = undefined
  getRuntimeState().pendingProjectRoot = undefined
  if (!current) {
    resetDB()
    await resetOptionalHoloSubsystems()
    resetConfigRuntime()
    return
  }

  await current.shutdown()
}

function getConfigValue(path: string): unknown {
  return globalConfig(path as never)
}

function getConfigSection(key: string): unknown {
  return globalUseConfig(key as never)
}

export const holoRuntimeInternals = {
  getConfigSection,
  getConfigValue,
  moduleInternals: portableRuntimeModuleInternals,
}
