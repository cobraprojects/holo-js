import {
  CachePackageMissingError,
  CacheStoreUnavailableError,
  initializeCacheMaintenanceEnvironment,
  type CacheStoreDescriptor,
} from './cache'
import { migrationExists } from './migration-creation'
import { normalizeCacheMigrationName } from './migrations'
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

type MissingCacheTables = {
  readonly tableName: string
  readonly lockTableName: string
}

function isMissingCacheTablesError(error: unknown): error is Error & MissingCacheTables {
  return error instanceof Error
    && error.name === 'DatabaseCacheTablesMissingError'
    && 'tableName' in error && typeof error.tableName === 'string'
    && 'lockTableName' in error && typeof error.lockTableName === 'string'
}

function unmigratedCacheTablesRequirement(store: CacheStoreDescriptor, tables: MissingCacheTables): string {
  return `${MIGRATION_LOCK_SOURCE} the "${tables.tableName}" and "${tables.lockTableName}" tables of ${describeStore(store)} haven't been migrated. `
    + 'Run "holo migrate" to create them.'
}

function missingCacheTableMigrationRequirement(store: CacheStoreDescriptor, tables: MissingCacheTables): string {
  return `${MIGRATION_LOCK_SOURCE} ${describeStore(store)} has no "${tables.tableName}" and "${tables.lockTableName}" tables and no migration creates them. `
    + 'Run "holo cache:table", then "holo migrate".'
}

async function describeMissingCacheTables(projectRoot: string, store: CacheStoreDescriptor, error: Error & MissingCacheTables): Promise<Error> {
  const cacheTableMigration = { name: normalizeCacheMigrationName(error.tableName), tableNames: [error.tableName, error.lockTableName] }
  const requirement = await migrationExists(projectRoot, cacheTableMigration)
    ? unmigratedCacheTablesRequirement(store, error)
    : missingCacheTableMigrationRequirement(store, error)
  return new Error(requirement, { cause: error })
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
    const acquired = await lock.get().catch(async (error: unknown) => {
      throw isMissingCacheTablesError(error)
        ? await describeMissingCacheTables(projectRoot, store, error)
        : describeLockFailure(store, error)
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
