import { CacheOptionalPackageError, type CacheDriverContract } from './contracts'

export interface CacheDriverFactory<TOptions> {
  readonly driver: string
  readonly registrationKey?: string
  create(options: TOptions): CacheDriverContract
}

const cacheDriverRuntime = globalThis as typeof globalThis & {
  __holoCacheDriverFactories__?: Map<string, CacheDriverFactory<object>>
}
cacheDriverRuntime.__holoCacheDriverFactories__ ??= new Map()
const factories = cacheDriverRuntime.__holoCacheDriverFactories__

export function registerCacheDriverFactory<TOptions extends object>(factory: CacheDriverFactory<TOptions>): void {
  const driver = factory.driver.trim()
  if (!driver) throw new TypeError('Cache driver factories require a non-empty driver name.')
  const existing = factories.get(driver)
  if (
    existing
    && existing !== factory
    && (!factory.registrationKey || existing.registrationKey !== factory.registrationKey)
  ) {
    throw new Error(`Cache driver factory "${driver}" is already registered.`)
  }
  factories.set(driver, factory as CacheDriverFactory<object>)
}

export function unregisterCacheDriverFactory<TOptions extends object>(factory: CacheDriverFactory<TOptions>): void {
  if (factories.get(factory.driver.trim()) === factory) factories.delete(factory.driver.trim())
}

export function requireCacheDriverFactory<TOptions extends object>(driver: string, message: string): CacheDriverFactory<TOptions> {
  const factory = factories.get(driver)
  if (!factory) throw new CacheOptionalPackageError(message)
  return factory as CacheDriverFactory<TOptions>
}
