import { isDeepStrictEqual } from 'node:util'
import { releaseRedisAdapters } from './capabilityLifetimes'

interface ManagedRedisAdapter {
  connect?(): unknown
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
  options: { readonly connect?: (adapter: TAdapter) => unknown } = {},
): ManagedRedisConnections<TConfig, TAdapter> {
  let committed: ManagedRedisConnection<TConfig, TAdapter>[] = []
  let acquired: ManagedRedisConnection<TConfig, TAdapter>[] = []
  let opened: TAdapter[] = []
  let retired: TAdapter[] = []

  return {
    async acquire(config, createAdapter) {
      const reusable = [...acquired, ...committed].find(connection => isDeepStrictEqual(connection.config, config))
      if (reusable) {
        if (!acquired.includes(reusable)) acquired.push(reusable)
        return reusable.adapter
      }

      const adapter = createAdapter(config)
      opened.push(adapter)
      await options.connect?.(adapter)
      acquired.push({ config, adapter })
      return adapter
    },
    commit() {
      retired = [...retired, ...committed.filter(connection => !acquired.includes(connection)).map(connection => connection.adapter)]
      committed = acquired
      acquired = []
      opened = []
    },
    async discard() {
      const adapters = opened
      acquired = []
      opened = []
      await releaseRedisAdapters(adapters)
    },
    async dispose() {
      const adapters = [...committed.map(connection => connection.adapter), ...retired]
      committed = []
      acquired = []
      opened = []
      retired = []
      await releaseRedisAdapters(adapters)
    },
  }
}
