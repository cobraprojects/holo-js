import type { QueueDriverFactory } from '@holo-js/queue'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import type { LoadedHoloConfig } from '@holo-js/config'
import {
  loadHoloPluginBootModules,
  loadHoloPluginDefinitions,
  type HoloPluginRuntimeModule,
  type LoadedHoloPluginDefinition,
} from '@holo-js/kernel'

export type CoreQueueDriverFactory = QueueDriverFactory

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

type HoloPluginBootScope = {
  active: boolean
}

const bootedHoloPluginModules = new Set<string>()
const pendingHoloPluginBoots = new Map<string, Promise<void>>()
const HOLO_PLUGIN_BOOT_SCOPES = Symbol.for('holo.core.pluginBootScope')
let bootGeneration = 0

function holoPluginBootScopes(): AsyncLocalStorage<HoloPluginBootScope> {
  const host = globalThis as typeof globalThis & {
    [HOLO_PLUGIN_BOOT_SCOPES]?: AsyncLocalStorage<HoloPluginBootScope>
  }
  host[HOLO_PLUGIN_BOOT_SCOPES] ??= new AsyncLocalStorage<HoloPluginBootScope>()
  return host[HOLO_PLUGIN_BOOT_SCOPES]
}

function resolveHoloPluginBootKey(projectRoot: string, bootModule: HoloPluginRuntimeModule): string {
  return [resolve(projectRoot), bootModule.plugin.packageName, bootModule.runtime].join('\0')
}

export function resolveLoadedPluginNames(loadedConfig: LoadedHoloConfig): readonly string[] {
  return loadedConfig.app.plugins
}

export async function bootConfiguredHoloPluginModule(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig,
  bootModule: HoloPluginRuntimeModule,
): Promise<void> {
  const bootKey = resolveHoloPluginBootKey(projectRoot, bootModule)
  if (bootedHoloPluginModules.has(bootKey)) return
  const pending = pendingHoloPluginBoots.get(bootKey)
  if (pending) return pending
  const candidate = isRecord(bootModule.module) && typeof bootModule.module.default !== 'undefined'
    ? bootModule.module.default
    : bootModule.module
  if (typeof candidate !== 'function') return
  const generation = bootGeneration
  const scope: HoloPluginBootScope = { active: true }
  const boot = (async () => {
    try {
      await holoPluginBootScopes().run(scope, () => candidate({ projectRoot, config: loadedConfig }))
    } finally {
      scope.active = false
    }
    if (generation === bootGeneration) bootedHoloPluginModules.add(bootKey)
  })()
  pendingHoloPluginBoots.set(bootKey, boot)
  try {
    await boot
  } finally {
    if (pendingHoloPluginBoots.get(bootKey) === boot) pendingHoloPluginBoots.delete(bootKey)
  }
}

export function assertOutsidePluginBoot(action: string): void {
  if (holoPluginBootScopes().getStore()?.active) {
    throw new Error(`[@holo-js/core] ${action} cannot run inside a plugin boot hook. Plugin boot runs once per application lifecycle; move this call out of the hook.`)
  }
}

export function resetBootedHoloPluginModules(): void {
  bootGeneration += 1
  bootedHoloPluginModules.clear()
  pendingHoloPluginBoots.clear()
}

export async function loadConfiguredHoloPluginDefinitions(
  projectRoot: string,
  pluginNames: readonly string[],
): Promise<readonly LoadedHoloPluginDefinition[]> {
  const normalizedNames = [...new Set(pluginNames.map(name => name.trim()).filter(Boolean))]
  return loadHoloPluginDefinitions(projectRoot, normalizedNames, { moduleVersion: String(Date.now()) })
}

export async function loadConfiguredHoloPluginBootModules(
  projectRoot: string,
  plugins: readonly LoadedHoloPluginDefinition[],
): Promise<readonly HoloPluginRuntimeModule[]> {
  return loadHoloPluginBootModules(projectRoot, plugins, { moduleVersion: String(Date.now()) })
}

export function mergeQueueRuntimeDriverFactories(
  ...sources: readonly (readonly CoreQueueDriverFactory[] | undefined)[]
): readonly CoreQueueDriverFactory[] {
  const factories = new Map<string, CoreQueueDriverFactory>()
  for (const source of sources) {
    for (const factory of source ?? []) factories.set(factory.driver, factory)
  }
  return Object.freeze([...factories.values()])
}
import type {} from '@holo-js/cache/config'
