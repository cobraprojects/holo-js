import type { HoloConfigMap, LoadedHoloConfig } from '@holo-js/config'
import type { GeneratedProjectRegistry } from './registry'

export function hasLoadedConfigFile<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
  configName: string,
): boolean {
  return loadedConfig.loadedFiles.some((filePath) => {
    const normalizedPath = filePath.replaceAll('\\', '/')
    return ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'].some(extension => (
      normalizedPath.endsWith(`/config/${configName}.${extension}`)
    ))
  })
}

export function queueConfigUsesDatabaseDriver<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  if (!loadedConfig.queue) return false
  return Object.values(loadedConfig.queue.connections).some(connection => connection.driver === 'database')
}

export function queueConfigUsesRedisDriver<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  if (!loadedConfig.queue) return false
  return Object.values(loadedConfig.queue.connections).some(connection => connection.driver === 'redis')
}

export function queueConfigUsesDatabaseBackedFailedStore<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  if (!loadedConfig.queue) return false
  return loadedConfig.queue.failed !== false
}

export function registryHasJobs(registry: GeneratedProjectRegistry | undefined): boolean {
  return (registry?.jobs.length ?? 0) > 0
}

export function registryHasEvents(registry: GeneratedProjectRegistry | undefined): boolean {
  return (registry?.events.length ?? 0) > 0 || (registry?.listeners.length ?? 0) > 0
}

export function authConfigUsesSocialProviders<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  if (!loadedConfig.auth) return false
  return Object.keys(loadedConfig.auth.social).length > 0
}

export function authConfigUsesWorkosProviders<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  if (!loadedConfig.auth) return false
  return Object.entries(loadedConfig.auth.workos).some(([name, provider]) => (
    name !== 'provider' && name !== 'identityStore' && typeof provider === 'object' && provider !== null
  ))
}

export function authConfigUsesClerkProviders<TCustom extends HoloConfigMap>(
  loadedConfig: LoadedHoloConfig<TCustom>,
): boolean {
  if (!loadedConfig.auth) return false
  return Object.entries(loadedConfig.auth.clerk).some(([name, provider]) => (
    name !== 'provider' && name !== 'identityStore' && typeof provider === 'object' && provider !== null
  ))
}
