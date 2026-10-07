import { AsyncLocalStorage } from 'node:async_hooks'
import { connectionAsyncContext, DB, ModelRepository, type DatabaseContext } from '@holo-js/db'

export function createAuthRedemptionContext() {
  const repositories = new Map<string, () => object | null>()
  const active = new AsyncLocalStorage<{ readonly provider: string, readonly repository: ModelRepository }>()

  return {
    register(provider: string, repository: () => object | null): void {
      repositories.set(provider, repository)
    },
    repository(provider: string): ModelRepository | undefined {
      const context = active.getStore()
      return context?.provider === provider ? context.repository : undefined
    },
    async redeem<TResult>(
      provider: string,
      claim: (connection: DatabaseContext) => Promise<boolean>,
      operation: () => Promise<TResult>,
    ): Promise<TResult | null> {
      const connection = DB.connection()
      const repository = repositories.get(provider)?.()
      if (repository instanceof ModelRepository && repository.getConnection().getContextId() === connection.getContextId()) {
        return connection.writeTransaction(transaction => connectionAsyncContext.run({
          connectionName: transaction.getConnectionName(),
          connection: transaction,
        }, async () => {
          if (!await claim(transaction)) return null
          return active.run({ provider, repository }, operation)
        }))
      }

      if (!await claim(connection)) return null
      return operation()
    },
  }
}
