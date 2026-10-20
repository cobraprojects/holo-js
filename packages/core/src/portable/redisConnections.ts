import { isDeepStrictEqual } from 'node:util'
import { releaseRedisAdapters } from './capabilityLifetimes'

interface ManagedRedisAdapter {
  connect?(): void | Promise<void>
  close?(): void | Promise<void>
  disconnect?(): void | Promise<void>
}

interface ManagedRedisConnection<TConfig, TAdapter> {
  readonly config: TConfig
  readonly adapter: TAdapter
}

export interface ManagedRedisConnections<TConfig, TAdapter extends ManagedRedisAdapter> {
  acquire(config: TConfig, createAdapter: (config: TConfig) => TAdapter): Promise<TAdapter>
  commit(): void
  discard(): Promise<void>
  dispose(): Promise<void>
}

export function createManagedRedisConnections<TConfig, TAdapter extends ManagedRedisAdapter>(
  options: { readonly connect?: (adapter: TAdapter) => void | Promise<void> } = {},
): ManagedRedisConnections<TConfig, TAdapter> {
  let active: ManagedRedisConnection<TConfig, TAdapter>[] = []
  let retained: ManagedRedisConnection<TConfig, TAdapter>[] = []
  let claimed: ManagedRedisConnection<TConfig, TAdapter>[] = []
  let opened: TAdapter[] = []

  const findSameConfig = (connections: readonly ManagedRedisConnection<TConfig, TAdapter>[], config: TConfig) =>
    connections.find(connection => isDeepStrictEqual(connection.config, config))

  return {
    async acquire(config, createAdapter) {
      const reusable = findSameConfig(claimed, config)
        ?? findSameConfig(active, config)
        ?? findSameConfig(retained, config)
      if (reusable) {
        if (!claimed.includes(reusable)) claimed.push(reusable)
        return reusable.adapter
      }

      const adapter = createAdapter(config)
      opened.push(adapter)
      await options.connect?.(adapter)
      claimed.push({ config, adapter })
      return adapter
    },
    commit() {
      const previouslyOpen = [...active, ...retained]
      active = claimed
      retained = previouslyOpen.filter(connection => !active.includes(connection))
      claimed = []
      opened = []
    },
    async discard() {
      const adapters = opened
      claimed = []
      opened = []
      await releaseRedisAdapters(adapters)
    },
    async dispose() {
      const adapters = [...active, ...retained].map(connection => connection.adapter)
      active = []
      retained = []
      claimed = []
      opened = []
      await releaseRedisAdapters(adapters)
    },
  }
}
