import { AsyncLocalStorage } from 'node:async_hooks'
import { queryCacheInternals, type DatabaseContext } from '@holo-js/db'

export type RealtimeContextRunner = <TValue>(callback: () => TValue) => TValue

const databases = new AsyncLocalStorage<DatabaseContext>()

export function getExecutionDatabase(): DatabaseContext | undefined {
  return databases.getStore()
}

export function createExecutionContext(database: DatabaseContext, auth?: RealtimeContextRunner): RealtimeContextRunner & { runWithAuth: RealtimeContextRunner } {
  const root = queryCacheInternals.getRootDatabaseContext(database)
  const session = queryCacheInternals.capturePooledDatabaseSessions()
  const runWithAuth: RealtimeContextRunner = auth ?? (callback => callback())
  return Object.assign(<TValue>(callback: () => TValue) => session(() => databases.run(root, () => runWithAuth(callback))), { runWithAuth })
}
