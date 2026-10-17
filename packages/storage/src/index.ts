import { inspectFileMimeType, inspectMimeType } from './mimeType'
import { isTemporaryLocalStorageRequest, resolveTemporaryLocalStorageRequest } from './temporaryLocalStorage'
import type { ModuleOptions } from './config'

function defineConfig<TConfig extends object>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

export function defineStorageConfig<TConfig extends ModuleOptions>(config: TConfig): Readonly<TConfig> {
  return defineConfig(config)
}

export * from './config'
export { createPublicStorageResponse } from './publicStorage'
export const storageRuntimeInternals = Object.freeze({
  inspectMimeType,
  inspectFileMimeType,
  isTemporaryLocalStorageRequest,
  resolveTemporaryLocalStorageRequest,
})
