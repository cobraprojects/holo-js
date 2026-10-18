import { AsyncLocalStorage } from 'node:async_hooks'
import { queryCacheInternals, type DatabaseContext } from '@holo-js/db'

export type RealtimeContextRunner = <TValue>(callback: () => TValue) => TValue

const databases = new AsyncLocalStorage<DatabaseContext>()

export function getExecutionDatabase(): DatabaseContext | undefined {
  return databases.getStore()
}

export function createExecutionContext(database: DatabaseContext, auth?: RealtimeContextRunner): RealtimeContextRunner {
  const root = queryCacheInternals.getRootDatabaseContext(database)
  return callback => databases.run(root, () => auth ? auth(callback) : callback())
}
