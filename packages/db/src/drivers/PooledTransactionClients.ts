import { AsyncLocalStorage } from 'node:async_hooks'

class TransactionError extends Error {}

type ReleasableClient = {
  release?(): void
}

type ScopedClient<TClient> = {
  client: TClient
  closed: boolean
  leases: number
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
    if (scoped && (!scoped.closed || scoped.leases > 0)) return scoped.client
    return this.transactionClient
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    const scoped = this.scope.getStore()
    if (scoped && !scoped.closed) {
      scoped.leases += 1
      try {
        return await callback()
      } finally {
        scoped.leases -= 1
        this.releaseWhenIdle(scoped)
      }
    }

    const client = await this.acquireClient()
    const holder: ScopedClient<TClient> = { client, closed: false, leases: 0, released: false }
    return this.scope.run(holder, async () => {
      try {
        return await callback()
      } finally {
        holder.closed = true
        this.releaseWhenIdle(holder)
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
    if (!scoped || scoped.closed) {
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

  private releaseWhenIdle(scoped: ScopedClient<TClient>): void {
    if (scoped.closed && scoped.leases === 0 && !scoped.released) {
      scoped.released = true
      this.releaseClient(scoped.client)
    }
  }

  private releaseClient(client: TClient): void {
    if (client !== this.directClient) {
      client.release?.()
    }
  }
}
