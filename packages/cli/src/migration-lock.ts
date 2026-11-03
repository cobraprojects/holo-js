import {
  CachePackageMissingError,
  CacheStoreUnavailableError,
  initializeCacheMaintenanceEnvironment,
  type CacheStoreDescriptor,
} from './cache'
import { errorMessage } from './error-message'

const MIGRATION_LOCK_NAME = 'migrations'
const MIGRATION_LOCK_SECONDS = 60 * 60
const MIGRATION_LOCK_SOURCE = '[Holo CLI] migrate --isolated takes its lock from the default cache store, but'
const SHARED_STORE_EXAMPLES = 'that every server shares, such as database or redis.'
const CACHE_DRIVER_RESOLUTION_FAILED = 'CACHE_DRIVER_RESOLUTION_FAILED'

export type IsolatedMigrationRun<TResult>
  = { readonly kind: 'skipped' }
  | { readonly kind: 'ran', readonly result: TResult }

function describeStore(store: CacheStoreDescriptor): string {
  return store.driver ? `cache store "${store.name}" (driver "${store.driver}")` : `cache store "${store.name}"`
}

function cacheNotInstalledRequirement(): string {
  return `${MIGRATION_LOCK_SOURCE} @holo-js/cache isn't installed. Install @holo-js/cache and use a default cache store ${SHARED_STORE_EXAMPLES}`
}

function storeUnavailableRequirement(store: CacheStoreDescriptor): string {
  return `${MIGRATION_LOCK_SOURCE} ${describeStore(store)} can't be resolved. `
    + `Configure the store, install its driver package, and use a default cache store ${SHARED_STORE_EXAMPLES}`
}

function lockUnsupportedRequirement(store: CacheStoreDescriptor): string {
  return `${MIGRATION_LOCK_SOURCE} ${describeStore(store)} can't provide a lock. `
    + `Use a default cache store that supports locks and ${SHARED_STORE_EXAMPLES}`
}

function migrationLockError(requirement: string, cause: unknown): Error {
  return new Error(`${requirement} ${errorMessage(cause)}`, { cause })
}

function isDriverResolutionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === CACHE_DRIVER_RESOLUTION_FAILED
}

function describeCacheSetupFailure(error: unknown): unknown {
  if (error instanceof CachePackageMissingError) return new Error(cacheNotInstalledRequirement(), { cause: error })
  if (error instanceof CacheStoreUnavailableError) return migrationLockError(storeUnavailableRequirement(error.store), error)
  return error
}

function describeLockFailure(store: CacheStoreDescriptor, error: unknown): Error {
  return isDriverResolutionError(error)
    ? migrationLockError(storeUnavailableRequirement(store), error)
    : migrationLockError(lockUnsupportedRequirement(store), error)
}

async function openMigrationLock(projectRoot: string) {
  const environment = await initializeCacheMaintenanceEnvironment(projectRoot).catch((error: unknown) => {
    throw describeCacheSetupFailure(error)
  })
  try {
    const lock = environment.cache.lock(MIGRATION_LOCK_NAME, MIGRATION_LOCK_SECONDS)
    return { lock, store: environment.store, close: environment.cleanup }
  } catch (error) {
    await environment.cleanup()
    throw describeLockFailure(environment.store, error)
  }
}

export async function runWithMigrationLock<TResult>(
  projectRoot: string,
  migrate: () => Promise<TResult>,
): Promise<IsolatedMigrationRun<TResult>> {
  const { lock, store, close } = await openMigrationLock(projectRoot)
  try {
    const acquired = await lock.get().catch((error: unknown) => {
      throw describeLockFailure(store, error)
    })
    if (!acquired) {
      return { kind: 'skipped' }
    }

    try {
      return { kind: 'ran', result: await migrate() }
    } finally {
      await lock.release()
    }
  } finally {
    await close()
  }
}
