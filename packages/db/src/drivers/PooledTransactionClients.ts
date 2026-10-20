import { AsyncLocalStorage } from 'node:async_hooks'

class TransactionError extends Error {}

type ReleasableClient = {
  release?(): void
}

type ScopedClient<TClient> = {
  client: TClient
  released: boolean
}

export class PooledTransactionClients<TClient extends ReleasableClient> {
  private readonly scope = new AsyncLocalStorage<ScopedClient<TClient>>()
  private transactionClient?: TClient

  constructor(
    private readonly driverName: string,
    private readonly directClient: TClient | undefined,
    private readonly acquireClient: () => Promise<TClient>,
  ) {}

  get current(): TClient | undefined {
    const scoped = this.scope.getStore()
    if (scoped && !scoped.released) return scoped.client
    return this.transactionClient
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    const scoped = this.scope.getStore()
    if (scoped && !scoped.released) {
      return callback()
    }

    const client = await this.acquireClient()
    const holder: ScopedClient<TClient> = { client, released: false }
    return this.scope.run(holder, async () => {
      try {
        return await callback()
      } finally {
        holder.released = true
        this.releaseClient(client)
      }
    })
  }

  async lease(): Promise<TClient> {
    const active = this.current
    if (active) {
      return active
    }

    this.transactionClient = await this.acquireClient()
    return this.transactionClient
  }

  require(): TClient {
    const active = this.current
    if (!active) {
      throw new TransactionError(`No active ${this.driverName} transaction client is available.`)
    }

    return active
  }

  release(): void {
    const scoped = this.scope.getStore()
    if (!scoped || scoped.released) {
      this.disconnect()
    }
  }

  disconnect(): void {
    const client = this.transactionClient
    this.transactionClient = undefined
    if (client) {
      this.releaseClient(client)
    }
  }

  private releaseClient(client: TClient): void {
    if (client !== this.directClient) {
      client.release?.()
    }
  }
}
