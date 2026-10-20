import { resolve } from 'node:path'
import type { LoadedHoloConfig } from '@holo-js/config'

type SessionRedisConfig = Extract<LoadedHoloConfig['session']['stores'][string], { readonly driver: 'redis' }>

export async function acquireSessionStores<TStore, TAdapter>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig,
  factories: {
    createFileStore(root: string): TStore
    createDatabaseStore(table: string, connection: string | undefined): TStore
    createRedisStore(adapter: TAdapter): TStore
    acquireRedisAdapter(config: SessionRedisConfig): Promise<TAdapter>
  },
): Promise<Readonly<Record<string, TStore>>> {
  const stores: Record<string, TStore> = {}
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
      stores[name] = factories.createRedisStore(await factories.acquireRedisAdapter(config))
    }
  }
  if (!(loadedConfig.session.driver in stores)) {
    throw new Error(`[@holo-js/core] Session driver "${loadedConfig.session.driver}" is configured but the runtime cannot boot it automatically.`)
  }
  return Object.freeze(stores)
}
