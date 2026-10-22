import { captureErrorReporter, type HoloErrorReporter } from '@holo-js/kernel/error-reporting'
import { createManagedResources, type ManagedResources, type ResourceLease } from '@holo-js/kernel/managed-resources'
import {
  CacheError,
  CacheOptionalPackageError,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheLockContract,
} from './contracts'

export const CACHE_DRIVER_DISPOSE_SYMBOL = Symbol.for('holo.cache.driver.dispose')

export type DisposableCacheDriver = CacheDriverContract & {
  readonly [CACHE_DRIVER_DISPOSE_SYMBOL]?: () => void | Promise<void>
}

export function disposeCacheDriver(driver: CacheDriverContract, report: HoloErrorReporter): void {
  const reportFailure = (error: unknown): void => report(error, { capability: 'cache', operation: 'driver.dispose' })
  try {
    void Promise.resolve((driver as DisposableCacheDriver)[CACHE_DRIVER_DISPOSE_SYMBOL]?.()).catch(reportFailure)
  } catch (error) {
    reportFailure(error)
  }
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

type LazyCacheDriverOptions<TModule, TOptions> = {
  readonly name: string
  readonly driver: CacheDriverContract['driver']
  readonly options: TOptions
  readonly loadModule: OptionalDriverModuleLoader<TModule>
  readonly createDriver: (module: TModule, options: TOptions) => CacheDriverContract
  readonly disposeDriver?: boolean
}

type LeasedCacheDriver = {
  readonly driver: CacheDriverContract
  close(): void | Promise<void>
}

type LazyCacheDriverInstance<TOptions> = {
  readonly generation: number
  readonly resources: ManagedResources<TOptions, LeasedCacheDriver>
  readonly lease: ResourceLease<LeasedCacheDriver>
}

function leaseCacheDriver(driver: CacheDriverContract): LeasedCacheDriver {
  return {
    driver,
    close: () => (driver as DisposableCacheDriver)[CACHE_DRIVER_DISPOSE_SYMBOL]?.(),
  }
}

class LazyOptionalCacheDriver<TModule, TOptions> implements CacheDriverContract {
  private instance?: LazyCacheDriverInstance<TOptions>
  private pending?: Promise<LazyCacheDriverInstance<TOptions>>
  private disposalGeneration = 0

  constructor(private readonly lazyOptions: LazyCacheDriverOptions<TModule, TOptions>) {}

  get name(): string {
    return this.lazyOptions.name
  }

  get driver(): CacheDriverContract['driver'] {
    return this.lazyOptions.driver
  }

  private createInstance(): Promise<LazyCacheDriverInstance<TOptions>> {
    const generation = this.disposalGeneration
    const resources = createManagedResources<TOptions, LeasedCacheDriver>()
    const pending: Promise<LazyCacheDriverInstance<TOptions>> = this.lazyOptions.loadModule().then(async (module) => {
      const lease = await resources.acquire(
        this.lazyOptions.options,
        () => leaseCacheDriver(this.lazyOptions.createDriver(module, this.lazyOptions.options)),
      )
      return { generation, resources, lease }
    })
    pending.catch(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  private async withInstance<TValue>(
    callback: (instance: LazyCacheDriverInstance<TOptions>) => Promise<TValue> | TValue,
  ): Promise<TValue> {
    const instance = this.instance ?? await (this.pending ?? this.createInstance())
    if (this.instance === undefined && instance.generation === this.disposalGeneration) {
      this.instance = instance
    }
    return instance.lease.hold(() => callback(instance))
  }

  private async withDriver<TValue>(
    callback: (driver: CacheDriverContract) => Promise<TValue> | TValue,
  ): Promise<TValue> {
    return this.withInstance(instance => callback(instance.lease.value.driver))
  }

  [CACHE_DRIVER_DISPOSE_SYMBOL](): void {
    if (this.lazyOptions.disposeDriver !== true) {
      return
    }

    const pending = this.pending

    this.disposalGeneration += 1
    this.instance = undefined
    this.pending = undefined

    if (!pending) {
      return
    }

    const report = captureErrorReporter()
    void pending.then(
      retired => retired.resources.dispose().catch(error => report(error, { capability: 'cache', operation: 'driver.dispose' })),
      () => undefined,
    )
  }

  private createLockProxy(name: string, seconds: number): CacheLockContract {
    const createdGeneration = this.disposalGeneration
    let bound: {
      readonly generation: number
      readonly lease: ResourceLease<LeasedCacheDriver>
      readonly lock: CacheLockContract
    } | undefined

    const replacedError = (): CacheError => new CacheError(
      'CACHE_DRIVER_RESOLUTION_FAILED',
      `[@holo-js/cache] Cache lock "${name}" belongs to a cache store that was replaced by reconfiguration; take a new lock from cache.lock().`,
    )

    const holdLock = async <TValue>(operation: (lock: CacheLockContract) => Promise<TValue> | TValue): Promise<TValue> => {
      const current = bound
      if (this.disposalGeneration !== (current?.generation ?? createdGeneration)) throw replacedError()
      if (current) {
        return current.lease.hold(() => operation(current.lock))
      }

      return this.withInstance((instance) => {
        bound ??= {
          generation: instance.generation,
          lease: instance.lease,
          lock: instance.lease.value.driver.lock(name, seconds),
        }
        if (bound.lease !== instance.lease) throw replacedError()
        return operation(bound.lock)
      })
    }

    return {
      name,
      async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
        return holdLock(current => current.get(callback))
      },
      async release(): Promise<boolean> {
        return holdLock(current => current.release())
      },
      async block<TValue>(waitSeconds: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
        return holdLock(current => current.block(waitSeconds, callback))
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
