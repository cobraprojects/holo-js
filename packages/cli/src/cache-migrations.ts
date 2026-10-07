import { createMigrationFiles } from './migration-creation'
import {
  CACHE_DATABASE_TABLE_DEFINITIONS,
  DEFAULT_CACHE_DATABASE_LOCK_TABLE as CACHE_DB_DEFAULT_LOCK_TABLE,
  DEFAULT_CACHE_DATABASE_TABLE as CACHE_DB_DEFAULT_TABLE,
  type CacheDatabaseTableColumnDefinition,
  type CacheDatabaseTableDefinition,
} from '@holo-js/cache-db'
import { loadConfigDirectory } from '@holo-js/config'
import { normalizeMigrationSlug } from '@holo-js/db'
import {
  getRegistryMigrationSlug,
  hasRegisteredCreateTableMigration,
  hasRegisteredMigrationSlug,
  nextMigrationTemplate,
} from './migrations'
import type { IoStreams } from './cli-types'

export const DEFAULT_CACHE_DATABASE_TABLE = CACHE_DB_DEFAULT_TABLE
export const DEFAULT_CACHE_DATABASE_LOCK_TABLE = CACHE_DB_DEFAULT_LOCK_TABLE

type DatabaseCacheMigrationTables = {
  readonly table: string
  readonly lockTable: string
}

type CacheConfigDriverShape =
  | {
      readonly driver: 'database'
      readonly table: string
      readonly lockTable: string
    }
  | {
      readonly driver: string
    }

type CacheConfigShape = {
  readonly drivers: Record<string, CacheConfigDriverShape>
}

export async function loadCacheConfig(projectRoot: string) {
  const loadedConfig = await loadConfigDirectory(projectRoot)
  if (
    !loadedConfig
    || typeof loadedConfig !== 'object'
    || !('cache' in loadedConfig)
    || !loadedConfig.cache
    || typeof loadedConfig.cache !== 'object'
    || !('drivers' in loadedConfig.cache)
    || typeof loadedConfig.cache.drivers !== 'object'
    || loadedConfig.cache.drivers === null
    || Array.isArray(loadedConfig.cache.drivers)
  ) {
    throw new Error('Cache config is missing or malformed. Expected a cache config object with a drivers property.')
  }

  const cacheConfig = loadedConfig.cache as CacheConfigShape

  for (const [driverName, driverConfig] of Object.entries(cacheConfig.drivers)) {
    if (driverConfig.driver !== 'database') {
      continue
    }

    const databaseDriver = driverConfig as Extract<CacheConfigDriverShape, { driver: 'database' }>
    if (
      typeof databaseDriver.table !== 'string'
      || !databaseDriver.table.trim()
      || typeof databaseDriver.lockTable !== 'string'
      || !databaseDriver.lockTable.trim()
    ) {
      throw new Error(`Database cache driver "${driverName}" must define non-empty "table" and "lockTable" strings.`)
    }
  }

  return cacheConfig
}

export function normalizeCacheMigrationName(tableName: string): string {
  return normalizeMigrationSlug(`create_${tableName.replaceAll('.', '_')}_cache_table`)
}

function escapeSingleQuotedString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')
}

function renderCacheTableColumn(columnDefinition: CacheDatabaseTableColumnDefinition): string {
  const calls = [
    `table.${columnDefinition.kind}('${escapeSingleQuotedString(columnDefinition.name)}')`,
  ]

  if (columnDefinition.primaryKey) {
    calls.push('primaryKey()')
  }

  if (columnDefinition.nullable) {
    calls.push('nullable()')
  }

  return `      ${calls.join('.')}`
}

function renderCacheTableCreateStatement(
  tableName: string,
  tableDefinition: CacheDatabaseTableDefinition,
): readonly string[] {
  return [
    `    await schema.createTable('${escapeSingleQuotedString(tableName)}', (table) => {`,
    ...tableDefinition.columns.map(renderCacheTableColumn),
    `      table.index(['${escapeSingleQuotedString(tableDefinition.indexColumn)}'], '${escapeSingleQuotedString(tableDefinition.indexName(tableName))}')`,
    '    })',
  ]
}

function resolveCacheDatabaseTableDefinition(role: CacheDatabaseTableDefinition['role']): CacheDatabaseTableDefinition {
  const tableDefinition = CACHE_DATABASE_TABLE_DEFINITIONS.find(definition => definition.role === role)
  if (!tableDefinition) {
    throw new Error(`Missing cache database table definition for "${role}".`)
  }

  return tableDefinition
}

export function renderCacheTableMigration(
  tableName = DEFAULT_CACHE_DATABASE_TABLE,
  lockTableName = DEFAULT_CACHE_DATABASE_LOCK_TABLE,
): string {
  const entryTableDefinition = resolveCacheDatabaseTableDefinition('entries')
  const lockTableDefinition = resolveCacheDatabaseTableDefinition('locks')

  return [
    'import { defineMigration } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }) {',
    ...renderCacheTableCreateStatement(tableName, entryTableDefinition),
    ...renderCacheTableCreateStatement(lockTableName, lockTableDefinition),
    '  },',
    '  async down({ schema }) {',
    `    await schema.dropTable('${escapeSingleQuotedString(lockTableName)}')`,
    `    await schema.dropTable('${escapeSingleQuotedString(tableName)}')`,
    '  },',
    '})',
    '',
  ].join('\n')
}

export function resolveDatabaseCacheTables(
  cacheConfig: Awaited<ReturnType<typeof loadCacheConfig>>,
): readonly DatabaseCacheMigrationTables[] {
  const configured = Object.values(cacheConfig.drivers)
    .filter((driver): driver is Extract<CacheConfigDriverShape, { driver: 'database' }> => driver.driver === 'database')
    .map(driver => ({
      table: driver.table,
      lockTable: driver.lockTable,
    }))

  if (configured.length === 0) {
    throw new Error('The configured cache drivers do not use the database driver.')
  }

  return Object.freeze(configured)
}

export async function runCacheTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  await createMigrationFiles(projectRoot, async () => {
    const cacheConfig = await loadCacheConfig(projectRoot)
    return resolveDatabaseCacheTables(cacheConfig).map(({ table, lockTable }) => ({
      name: normalizeCacheMigrationName(table),
      tableNames: [table, lockTable],
      contents: renderCacheTableMigration(table, lockTable),
      conflictMessage: `A migration for cache tables "${table}" and "${lockTable}" already exists.`,
    }))
  }, { io, prepare: true })
}

export const cacheMigrationInternals = {
  getRegistryMigrationSlug,
  hasRegisteredMigrationSlug,
  hasRegisteredCreateTableMigration,
  nextMigrationTemplate,
}
