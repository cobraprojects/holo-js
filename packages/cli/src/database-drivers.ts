import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDatabaseDriverFactory, type DatabaseDriverFactory, type RuntimeDatabaseConfig } from '@holo-js/db'

export async function loadProjectDatabaseDrivers(projectRoot: string, config: RuntimeDatabaseConfig | undefined): Promise<readonly DatabaseDriverFactory[]> {
  const packageByDriver = {
    sqlite: { packageName: '@holo-js/db-sqlite', factoryExport: 'sqliteDatabaseDriverFactory' },
    postgres: { packageName: '@holo-js/db-postgres', factoryExport: 'postgresDatabaseDriverFactory' },
    mysql: { packageName: '@holo-js/db-mysql', factoryExport: 'mysqlDatabaseDriverFactory' },
  } as const
  const connections = Object.values(config?.connections ?? { default: './data/database.sqlite' })
  const drivers = new Set<keyof typeof packageByDriver>()
  for (const connection of connections) {
    const driver = (() => {
    if (typeof connection === 'string') {
      if (connection.startsWith('postgres://') || connection.startsWith('postgresql://')) return 'postgres'
      if (connection.startsWith('mysql://') || connection.startsWith('mysql2://')) return 'mysql'
      return 'sqlite'
    }
    return connection.driver ?? 'sqlite'
    })()
    if (!(driver in packageByDriver)) throw new Error(`Unsupported Holo database driver "${driver}".`)
    drivers.add(driver as keyof typeof packageByDriver)
  }
  const require = createRequire(join(projectRoot, 'package.json'))
  const factories: DatabaseDriverFactory[] = []
  for (const driver of drivers) {
    const { packageName, factoryExport } = packageByDriver[driver]
    const module = await import(pathToFileURL(require.resolve(packageName)).href) as Record<string, unknown>
    const factory = module[factoryExport] as DatabaseDriverFactory | undefined
    if (!factory) throw new Error(`Database driver package ${packageName} does not export ${factoryExport}.`)
    registerDatabaseDriverFactory(factory)
    factories.push(factory)
  }
  return factories
}
