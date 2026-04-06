import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseContext } from '../core/DatabaseContext'

export interface ActiveConnectionScope {
  connectionName: string
  connection: DatabaseContext
}

export class AsyncConnectionContext {
  private readonly storage = new AsyncLocalStorage<ActiveConnectionScope>()

  run<T>(scope: ActiveConnectionScope, callback: () => T): T {
    return this.storage.run(scope, callback)
  }

  getActive(): ActiveConnectionScope | undefined {
    return this.storage.getStore()
  }
}

export const connectionAsyncContext = new AsyncConnectionContext()
