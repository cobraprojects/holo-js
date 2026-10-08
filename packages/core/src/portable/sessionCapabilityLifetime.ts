import { resolve } from 'node:path'
import type { LoadedHoloConfig } from '@holo-js/config'
import { releaseSessionAdapters } from './capabilityLifetimes'

type SessionRedisResource = {
  connect?(): Promise<void>
  disconnect?(): void | Promise<void>
  close?(): void | Promise<void>
}

type SessionRedisConfig = Extract<LoadedHoloConfig['session']['stores'][string], { readonly driver: 'redis' }>

export async function acquireSessionStores<TStore, TAdapter extends SessionRedisResource>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig,
  factories: {
    createFileStore(root: string): TStore
    createDatabaseStore(table: string, connection: string | undefined): TStore
    createRedisStore(adapter: TAdapter): TStore
    createRedisAdapter(config: SessionRedisConfig): Promise<TAdapter>
  },
): Promise<{
  readonly stores: Readonly<Record<string, TStore>>
  readonly redisAdapters: readonly TAdapter[]
}> {
  const stores: Record<string, TStore> = {}
  const redisAdapters: TAdapter[] = []
  try {
    for (const [name, config] of Object.entries(loadedConfig.session.stores)) {
      if (config.driver === 'file') {
        stores[name] = factories.createFileStore(resolve(projectRoot, config.path))
        continue
      }
      if (config.driver === 'database') {
        const connection = config.connection === 'default' && !(config.connection in loadedConfig.database.connections)
          ? loadedConfig.database.defaultConnection
          : config.connection
        stores[name] = factories.createDatabaseStore(config.table, connection)
        continue
      }
      if (config.driver === 'redis') {
        const adapter = await factories.createRedisAdapter(config)
        redisAdapters.push(adapter)
        await adapter.connect?.()
        stores[name] = factories.createRedisStore(adapter)
      }
    }
    if (!(loadedConfig.session.driver in stores)) {
      throw new Error(`[@holo-js/core] Session driver "${loadedConfig.session.driver}" is configured but the runtime cannot boot it automatically.`)
    }
  } catch (error) {
    try {
      await releaseSessionAdapters(redisAdapters)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Session acquisition and cleanup failed.')
    }
    throw error
  }
  return Object.freeze({ stores: Object.freeze(stores), redisAdapters: Object.freeze(redisAdapters) })
}
