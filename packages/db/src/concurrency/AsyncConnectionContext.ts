import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseContext } from '../core/DatabaseContext'

export interface ActiveConnectionScope {
  connectionName: string
  connection: DatabaseContext
}

function getAsyncConnectionStorage(): AsyncLocalStorage<ActiveConnectionScope> {
  const runtime = globalThis as typeof globalThis & {
    __holoAsyncConnectionStorage__?: AsyncLocalStorage<ActiveConnectionScope>
  }

  runtime.__holoAsyncConnectionStorage__ ??= new AsyncLocalStorage<ActiveConnectionScope>()
  return runtime.__holoAsyncConnectionStorage__
}

export class AsyncConnectionContext {
  run<T>(scope: ActiveConnectionScope, callback: () => T): T {
    return getAsyncConnectionStorage().run(scope, callback)
  }

  getActive(): ActiveConnectionScope | undefined {
    return getAsyncConnectionStorage().getStore()
  }
}

export const connectionAsyncContext = new AsyncConnectionContext()
