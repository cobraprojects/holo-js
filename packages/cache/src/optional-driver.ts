import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CacheOptionalPackageError,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheLockContract,
} from './contracts'

export const CACHE_DRIVER_DISPOSE_SYMBOL = Symbol.for('holo.cache.driver.dispose')

export type DisposableCacheDriver = CacheDriverContract & {
  readonly [CACHE_DRIVER_DISPOSE_SYMBOL]?: () => void
}

export type OptionalDriverModuleLoader<TModule> = () => Promise<TModule>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isOptionalDriverModuleNotFoundError(error: unknown, expectedSpecifier: string): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const message = 'message' in error && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : ''
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  const escapedSpecifier = escapeRegExp(expectedSpecifier)

  if (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
    && [
      new RegExp(`Cannot find package ['"]${escapedSpecifier}['"]`),
      new RegExp(`Cannot find module ['"]${escapedSpecifier}['"]`),
      new RegExp(`Could not resolve ['"]${escapedSpecifier}['"]`),
      new RegExp(`Failed to load url\\s+(?:['"\`]${escapedSpecifier}['"\`]|${escapedSpecifier}(?=[\\s(]|$))`),
    ].some(pattern => pattern.test(message))
  ) {
    return true
  }

  if ('cause' in error) {
    return isOptionalDriverModuleNotFoundError((error as { cause?: unknown }).cause, expectedSpecifier)
  }

  return false
}

export function normalizeOptionalDriverModuleLoadError(
  error: unknown,
  expectedSpecifier: string,
  message: string,
): CacheOptionalPackageError | unknown {
  if (isOptionalDriverModuleNotFoundError(error, expectedSpecifier)) {
    return new CacheOptionalPackageError(message, { cause: error })
  }

  return error
}

async function importOptionalDriverModuleFromProject<TModule>(specifier: string): Promise<TModule> {
  const projectRequire = createRequire(join(process.cwd(), 'package.json'))
  return await import(pathToFileURL(projectRequire.resolve(specifier)).href) as TModule
}

export function createOptionalDriverModuleLoader<TModule>(
  specifier: string,
  missingPackageMessage: string,
): OptionalDriverModuleLoader<TModule> {
  return async () => {
    try {
      return await import(/* webpackIgnore: true */ specifier) as TModule
    } catch (error) {
      if (!isOptionalDriverModuleNotFoundError(error, specifier)) {
        throw normalizeOptionalDriverModuleLoadError(error, specifier, missingPackageMessage)
      }

      try {
        return await importOptionalDriverModuleFromProject<TModule>(specifier)
      } catch (fallbackError) {
        throw normalizeOptionalDriverModuleLoadError(fallbackError, specifier, missingPackageMessage)
      }
    }
  }
}

type LazyCacheDriverOptions<TModule, TOptions> = {
  readonly name: string
  readonly driver: CacheDriverContract['driver']
  readonly options: TOptions
  readonly loadModule: OptionalDriverModuleLoader<TModule>
  readonly createDriver: (module: TModule, options: TOptions) => CacheDriverContract
  readonly disposeDriver?: boolean
}

class LazyOptionalCacheDriver<TModule, TOptions> implements CacheDriverContract {
  private driverInstance?: CacheDriverContract
  private pending?: Promise<CacheDriverContract>
  private disposalGeneration = 0

  constructor(private readonly lazyOptions: LazyCacheDriverOptions<TModule, TOptions>) {}

  get name(): string {
    return this.lazyOptions.name
  }

  get driver(): CacheDriverContract['driver'] {
    return this.lazyOptions.driver
  }

  private async resolveDriver(): Promise<CacheDriverContract> {
    if (this.driverInstance) return this.driverInstance

    const pendingGeneration = this.disposalGeneration
    this.pending ??= this.lazyOptions.loadModule().then((module) => {
      const driver = this.lazyOptions.createDriver(module, this.lazyOptions.options)
      if (this.disposalGeneration === pendingGeneration) {
        this.driverInstance = driver
      }
      return driver
    }).finally(() => {
      this.pending = undefined
    })

    return this.pending
  }

  private async withDriver<TValue>(
    callback: (driver: CacheDriverContract) => Promise<TValue> | TValue,
  ): Promise<TValue> {
    return callback(await this.resolveDriver())
  }

  [CACHE_DRIVER_DISPOSE_SYMBOL](): void {
    if (this.lazyOptions.disposeDriver !== true) {
      return
    }

    const pending = this.pending
    const driverInstance = this.driverInstance

    this.disposalGeneration += 1
    this.driverInstance = undefined
    this.pending = undefined

    if (driverInstance) {
      const disposable = driverInstance as DisposableCacheDriver
      disposable[CACHE_DRIVER_DISPOSE_SYMBOL]?.()
      return
    }

    pending?.then((driver) => {
      const disposable = driver as DisposableCacheDriver
      disposable[CACHE_DRIVER_DISPOSE_SYMBOL]?.()
    }).catch(() => {})
  }

  private createLockProxy(name: string, seconds: number): CacheLockContract {
    let lockPromise: Promise<CacheLockContract> | undefined

    const resolveLock = async (): Promise<CacheLockContract> => {
      lockPromise ??= this.withDriver((driver) => driver.lock(name, seconds))
      return lockPromise
    }

    return {
      name,
      async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
        return (await resolveLock()).get(callback)
      },
      async release(): Promise<boolean> {
        return (await resolveLock()).release()
      },
      async block<TValue>(waitSeconds: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
        return (await resolveLock()).block(waitSeconds, callback)
      },
    }
  }

  async get(key: string): Promise<CacheDriverGetResult> {
    return this.withDriver((driver) => driver.get(key))
  }

  async put(input: Parameters<CacheDriverContract['put']>[0]): Promise<boolean> {
    return this.withDriver((driver) => driver.put(input))
  }

  async add(input: Parameters<CacheDriverContract['add']>[0]): Promise<boolean> {
    return this.withDriver((driver) => driver.add(input))
  }

  async forget(key: string): Promise<boolean> {
    return this.withDriver((driver) => driver.forget(key))
  }

  async flush(): Promise<void> {
    await this.withDriver((driver) => driver.flush())
  }

  async increment(key: string, amount: number): Promise<number> {
    return this.withDriver((driver) => driver.increment(key, amount))
  }

  async decrement(key: string, amount: number): Promise<number> {
    return this.withDriver((driver) => driver.decrement(key, amount))
  }

  lock(name: string, seconds: number): CacheLockContract {
    return this.createLockProxy(name, seconds)
  }
}

export function createLazyOptionalCacheDriver<TModule, TOptions>(
  options: LazyCacheDriverOptions<TModule, TOptions>,
): CacheDriverContract {
  return new LazyOptionalCacheDriver(options)
}
