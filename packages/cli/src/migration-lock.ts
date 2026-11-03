import { initializeCacheMaintenanceEnvironment } from './cache'
import { errorMessage } from './error-message'

const MIGRATION_LOCK_NAME = 'migrations'
const MIGRATION_LOCK_SECONDS = 60 * 60
const MIGRATION_LOCK_REQUIREMENT = '[Holo CLI] migrate --isolated takes its lock from the default cache store. '
  + 'Install @holo-js/cache and set a default cache store that supports locks and is shared by every server, such as database or redis.'

export type IsolatedMigrationRun<TResult>
  = { readonly kind: 'skipped' }
  | { readonly kind: 'ran', readonly result: TResult }

function failWithMigrationLockRequirement(error: unknown): never {
  throw new Error(`${MIGRATION_LOCK_REQUIREMENT} ${errorMessage(error)}`, { cause: error })
}

async function openMigrationLock(projectRoot: string) {
  const environment = await initializeCacheMaintenanceEnvironment(projectRoot).catch(failWithMigrationLockRequirement)
  try {
    return { lock: environment.cache.lock(MIGRATION_LOCK_NAME, MIGRATION_LOCK_SECONDS), close: environment.cleanup }
  } catch (error) {
    await environment.cleanup()
    return failWithMigrationLockRequirement(error)
  }
}

export async function runWithMigrationLock<TResult>(
  projectRoot: string,
  migrate: () => Promise<TResult>,
): Promise<IsolatedMigrationRun<TResult>> {
  const { lock, close } = await openMigrationLock(projectRoot)
  try {
    if (!await lock.get()) {
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
