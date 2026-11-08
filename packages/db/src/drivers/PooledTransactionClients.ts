import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseError } from '../core/errors'

class TransactionError extends Error {}

type ReleasableClient = {
  release?(): void
}

type ScopedClient<TClient> = {
  client: TClient
  closed: boolean
  leases: number
  released: boolean
  afterRelease?: Array<() => Promise<void>>
}

export const databaseSessionCacheEligibleKey: unique symbol = Symbol('databaseSessionCacheEligibleKey')
const holders = new AsyncLocalStorage<ReadonlyMap<object, ScopedClient<ReleasableClient> | WeakRef<ScopedClient<ReleasableClient>>>>()

export function capturePooledDatabaseSessions(): <T>(callback: () => T) => T {
  const captured = new Map<object, WeakRef<ScopedClient<ReleasableClient>>>()
  for (const [owner, value] of holders.getStore() ?? []) {
    const holder = value instanceof WeakRef ? value.deref() : value
    if (holder && !holder.closed && !holder.released) captured.set(owner, new WeakRef(holder))
  }
  return callback => {
    for (const reference of captured.values()) {
      if (reference.deref()?.closed !== false) throw new DatabaseError('The database session used by this subscription has ended.', 'SESSION_ENDED')
    }
    return holders.run(captured, callback)
  }
}

export function deferPooledDatabaseSessionRefresh(runWithContext: <T>(callback: () => T) => T, refresh: () => Promise<void>): boolean {
  const blocked = new Map<object, ScopedClient<ReleasableClient>>()
  for (const [owner, value] of holders.getStore() ?? []) {
    const holder = value instanceof WeakRef ? value.deref() : value
    if (holder && !holder.closed && !holder.released) blocked.set(owner, holder)
  }
  if (blocked.size === 0) return false
  runWithContext(() => {
    for (const owner of blocked.keys()) {
      const value = holders.getStore()?.get(owner)
      const holder = value instanceof WeakRef ? value.deref() : value
      if (holder && !holder.closed && !holder.released) blocked.delete(owner)
    }
  })
  if (blocked.size === 0) return false
  let remaining = blocked.size
  const released = async () => {
    remaining -= 1
    if (remaining === 0) await refresh()
  }
  for (const holder of blocked.values()) (holder.afterRelease ??= []).push(released)
  return true
}

export class PooledTransactionClients<TClient extends ReleasableClient> {
  private readonly scope = {
    getStore: (): ScopedClient<TClient> | undefined => {
      const value = holders.getStore()?.get(this)
      const holder = value instanceof WeakRef ? value.deref() : value
      if (value instanceof WeakRef && (!holder || holder.closed || holder.released)) throw new DatabaseError('The database session used by this subscription has ended.', 'SESSION_ENDED')
      return holder as ScopedClient<TClient> | undefined
    },
    run: <T>(holder: ScopedClient<TClient>, callback: () => T): T => {
      const current = new Map(holders.getStore())
      current.set(this, holder)
      return holders.run(current, callback)
    },
  }
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
        await this.releaseWhenIdle(scoped)
      }
    }

    const client = await this.acquireClient()
    const holder: ScopedClient<TClient> = { client, closed: false, leases: 0, released: false }
    return this.scope.run(holder, async () => {
      try {
        return await callback()
      } finally {
        holder.closed = true
        await this.releaseWhenIdle(holder)
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
    if (!scoped || (scoped.closed && scoped.leases === 0)) {
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

  private async releaseWhenIdle(scoped: ScopedClient<TClient>): Promise<void> {
    if (scoped.closed && scoped.leases === 0 && !scoped.released) {
      scoped.released = true
      this.releaseClient(scoped.client)
      const callbacks = scoped.afterRelease ?? []
      scoped.afterRelease = undefined
      await Promise.all(callbacks.map(callback => callback()))
    }
  }

  private releaseClient(client: TClient): void {
    if (client !== this.directClient) {
      client.release?.()
    }
  }
}
