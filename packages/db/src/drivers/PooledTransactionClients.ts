import { AsyncLocalStorage } from 'node:async_hooks'

class TransactionError extends Error {}

type ReleasableClient = {
  release?(): void
}

export class PooledTransactionClients<TClient extends ReleasableClient> {
  private readonly scope = new AsyncLocalStorage<TClient>()
  private transactionClient?: TClient

  constructor(
    private readonly driverName: string,
    private readonly directClient: TClient | undefined,
    private readonly acquireClient: () => Promise<TClient>,
  ) {}

  get current(): TClient | undefined {
    return this.scope.getStore() ?? this.transactionClient
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) {
      return callback()
    }

    const client = await this.acquireClient()
    return this.scope.run(client, async () => {
      try {
        return await callback()
      } finally {
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
    if (!this.scope.getStore()) {
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
