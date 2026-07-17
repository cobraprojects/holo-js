import { resolve } from 'node:path'
import type { LoadedHoloConfig } from '@holo-js/config'
import {
  loadHoloPluginBootModules,
  loadHoloPluginDefinitions,
  type HoloPluginRuntimeModule,
  type LoadedHoloPluginDefinition,
} from '@holo-js/kernel'

export type CoreQueueDriverFactory = {
  readonly driver: string
  create(...parameters: readonly unknown[]): unknown
}

export type CoreCachePluginDriverRegistry = {
  readonly size: number
  get(name: string): unknown
  has(name: string): boolean
  entries(): IterableIterator<[string, unknown]>
  [Symbol.iterator](): IterableIterator<[string, unknown]>
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const bootedHoloPluginModules = new Set<string>()

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
  const candidate = isRecord(bootModule.module) && typeof bootModule.module.default !== 'undefined'
    ? bootModule.module.default
    : bootModule.module
  if (typeof candidate !== 'function') return
  await candidate({ projectRoot, config: loadedConfig })
  bootedHoloPluginModules.add(bootKey)
}

export function resetBootedHoloPluginModules(): void {
  bootedHoloPluginModules.clear()
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
