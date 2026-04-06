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
import {
  configureQueueRuntime,
  getRegisteredQueueJob,
  getQueueRuntime,
  isQueueJobDefinition,
  normalizeQueueJobDefinition,
  registerQueueJob,
  shutdownQueueRuntime,
  unregisterQueueJob,
  type QueueRuntimeBinding,
} from '@holo-js/queue'
import {
  ensureEventsQueueJobRegistered,
  type EventDefinition,
  getRegisteredEvent,
  getRegisteredListener,
  isEventDefinition,
  isListenerDefinition,
  type ListenerDefinition,
  normalizeListenerDefinition,
  registerEvent,
  registerListener,
  unregisterEvent,
  unregisterListener,
} from '@holo-js/events'
import { createQueueDbRuntimeOptions } from '@holo-js/queue-db'
import { resetStorageRuntime } from '@holo-js/storage/runtime'
import { resolveRuntimeConnectionManagerOptions } from './dbRuntime'
import { loadGeneratedProjectRegistry, type GeneratedProjectRegistry } from './registry'
import { importBundledRuntimeModule } from '../runtimeModule'
import { configurePlainNodeStorageRuntime } from '../storageRuntime'

type RuntimeConfigRegistry<TCustom extends HoloConfigMap> = LoadedHoloConfig<TCustom>['all']
type PortableRuntimeConfig<TCustom extends HoloConfigMap> = {
  readonly db: LoadedHoloConfig<TCustom>['database']
  readonly queue: LoadedHoloConfig<TCustom>['queue']
}
type PortableConnectionManager = ReturnType<typeof resolveRuntimeConnectionManagerOptions>

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
  readonly queue: QueueRuntimeBinding
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

function resolveQueueJobExport(moduleValue: unknown) {
  const exports = moduleValue as Record<string, unknown>
  if (isQueueJobDefinition(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => isQueueJobDefinition(value))
}

const HOLO_EVENT_DEFINITION_MARKER = Symbol.for('holo-js.events.definition')
const HOLO_LISTENER_DEFINITION_MARKER = Symbol.for('holo-js.events.listener')

function hasEventDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_EVENT_DEFINITION_MARKER in value
}

function hasListenerDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_LISTENER_DEFINITION_MARKER in value
}

function resolveEventExport(moduleValue: unknown) {
  const exports = moduleValue as Record<string, unknown>
  if (hasEventDefinitionMarker(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => hasEventDefinitionMarker(value))
}

function resolveListenerExport(moduleValue: unknown) {
  const exports = moduleValue as Record<string, unknown>
  if (hasListenerDefinitionMarker(exports.default) || isListenerDefinition(exports.default)) {
    return exports.default
  }

  return Object.values(exports).find(value => hasListenerDefinitionMarker(value) || isListenerDefinition(value))
}

async function importRuntimeModule(projectRoot: string, filePath: string): Promise<unknown> {
  return importBundledRuntimeModule(projectRoot, filePath)
}

async function registerProjectQueueJobs(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
): Promise<readonly string[]> {
  if (!registry || registry.jobs.length === 0) {
    return Object.freeze([])
  }

  const registeredJobNames: string[] = []
  try {
    for (const entry of registry.jobs) {
      const existing = getRegisteredQueueJob(entry.name)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const job = resolveQueueJobExport(moduleValue)
      if (!job) {
        throw new Error(`Discovered job "${entry.sourcePath}" does not export a Holo job.`)
      }

      registerQueueJob(normalizeQueueJobDefinition(job), {
        name: entry.name,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredJobNames.push(entry.name)
    }
  } catch (error) {
    unregisterProjectQueueJobs(registeredJobNames)
    throw error
  }

  return Object.freeze(registeredJobNames)
}

function unregisterProjectQueueJobs(jobNames: readonly string[]): void {
  for (const jobName of jobNames) {
    unregisterQueueJob(jobName)
  }
}

async function registerProjectEventsAndListeners(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
): Promise<{ readonly eventNames: readonly string[], readonly listenerIds: readonly string[] }> {
  if (!registry || (registry.events.length === 0 && registry.listeners.length === 0)) {
    return Object.freeze({
      eventNames: Object.freeze([]),
      listenerIds: Object.freeze([]),
    })
  }

  const registeredEventNames: string[] = []
  const registeredListenerIds: string[] = []

  try {
    for (const entry of registry.events) {
      const existing = getRegisteredEvent(entry.name)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const event = resolveEventExport(moduleValue)
      if (!event || !isEventDefinition(event)) {
        throw new Error(`Discovered event "${entry.sourcePath}" does not export a Holo event.`)
      }

      registerEvent(event as EventDefinition<unknown, string>, {
        name: entry.name,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredEventNames.push(entry.name)
    }

    for (const entry of registry.listeners) {
      const existing = getRegisteredListener(entry.id)
      if (existing && !existing.sourcePath) {
        continue
      }

      const moduleValue = await importRuntimeModule(projectRoot, resolve(projectRoot, entry.sourcePath))
      const listener = resolveListenerExport(moduleValue)
      if (!listener) {
        throw new Error(`Discovered listener "${entry.sourcePath}" does not export a Holo listener.`)
      }

      const normalizedListener = normalizeListenerDefinition(listener as ListenerDefinition)
      registerListener({
        ...normalizedListener,
        listensTo: entry.eventNames,
      }, {
        id: entry.id,
        sourcePath: entry.sourcePath,
        replaceExisting: !!existing?.sourcePath,
      })
      registeredListenerIds.push(entry.id)
    }
  } catch (error) {
    unregisterProjectEventsAndListeners(registeredEventNames, registeredListenerIds)
    throw error
  }

  return Object.freeze({
    eventNames: Object.freeze(registeredEventNames),
    listenerIds: Object.freeze(registeredListenerIds),
  })
}

function unregisterProjectEventsAndListeners(
  eventNames: readonly string[],
  listenerIds: readonly string[],
): void {
  for (const listenerId of listenerIds) {
    unregisterListener(listenerId)
  }

  for (const eventName of eventNames) {
    unregisterEvent(eventName)
  }
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

  const runtime: MutableHoloRuntime<TCustom> = {
    projectRoot,
    loadedConfig,
    registry,
    manager,
    runtimeConfig,
    get queue() {
      return getQueueRuntime()
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
        configureQueueRuntime({
          config: loadedConfig.queue,
          ...createQueueDbRuntimeOptions(),
        })
        ensureEventsQueueJobRegistered()
        configurePlainNodeStorageRuntime(projectRoot, loadedConfig)
        const eventRegistration = await registerProjectEventsAndListeners(projectRoot, registry)
        runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length, ...eventRegistration.eventNames)
        runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length, ...eventRegistration.listenerIds)
        if (options.registerProjectQueueJobs === true) {
          runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
          runtimeOwnedQueueJobNames.push(...await registerProjectQueueJobs(projectRoot, registry))
        }
        runtime.initialized = true
        getRuntimeState().current = runtime
      } catch (error) {
        unregisterProjectEventsAndListeners(runtimeOwnedEventNames, runtimeOwnedListenerIds)
        runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length)
        runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length)
        unregisterProjectQueueJobs(runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        await manager.disconnectAll().catch(() => {})
        resetDB()
        resetStorageRuntime()
        await shutdownQueueRuntime()
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
        unregisterProjectEventsAndListeners(runtimeOwnedEventNames, runtimeOwnedListenerIds)
        runtimeOwnedEventNames.splice(0, runtimeOwnedEventNames.length)
        runtimeOwnedListenerIds.splice(0, runtimeOwnedListenerIds.length)
        unregisterProjectQueueJobs(runtimeOwnedQueueJobNames)
        runtimeOwnedQueueJobNames.splice(0, runtimeOwnedQueueJobNames.length)
        resetDB()
        resetStorageRuntime()
        await shutdownQueueRuntime()
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
    resetStorageRuntime()
    await shutdownQueueRuntime()
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
}
