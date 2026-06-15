import { resolve } from 'node:path'
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
  ensureProjectConfig,
  loadGeneratedProjectRegistry,
  makeProjectRelativePath,
  prepareProjectDiscovery,
  resolveDefaultArtifactPath,
  writeTextFile,
} from './project'
import { runProjectPrepare } from './dev'
import {
  getRegistryMigrationSlug,
  hasRegisteredCreateTableMigration,
  hasRegisteredMigrationSlug,
  nextMigrationTemplate,
} from './migrations'
import { writeLine } from './io'
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
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    ...renderCacheTableCreateStatement(tableName, entryTableDefinition),
    ...renderCacheTableCreateStatement(lockTableName, lockTableDefinition),
    '  },',
    '  async down({ schema }: MigrationContext) {',
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
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const cacheConfig = await loadCacheConfig(projectRoot)
  const migrationsDir = resolve(projectRoot, project.config.paths.migrations)
  const createdFiles: string[] = []
  const resolvedTables = resolveDatabaseCacheTables(cacheConfig)
  const seenPhysicalTables = new Set<string>()
  const seenSlugs = new Map<string, string>()

  for (const { table, lockTable } of resolvedTables) {
    const migrationName = normalizeCacheMigrationName(table)
    const previousTable = seenSlugs.get(migrationName)
    if (
      table === lockTable
      || seenPhysicalTables.has(table)
      || seenPhysicalTables.has(lockTable)
      || (previousTable && previousTable !== table)
    ) {
      throw new Error(`A migration for cache tables "${table}" and "${lockTable}" already exists.`)
    }

    seenPhysicalTables.add(table)
    seenPhysicalTables.add(lockTable)
    seenSlugs.set(migrationName, table)
  }

  for (const { table, lockTable } of resolvedTables) {
    const migrationName = normalizeCacheMigrationName(table)
    if (
      hasRegisteredMigrationSlug(registry, migrationName)
      || hasRegisteredCreateTableMigration(registry, table)
      || hasRegisteredCreateTableMigration(registry, lockTable)
    ) {
      throw new Error(`A migration for cache tables "${table}" and "${lockTable}" already exists.`)
    }
  }

  for (const { table, lockTable } of resolvedTables) {
    const migrationTemplate = await nextMigrationTemplate(normalizeCacheMigrationName(table), migrationsDir)
    const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)
    await writeTextFile(migrationFilePath, renderCacheTableMigration(table, lockTable))
    createdFiles.push(migrationFilePath)
  }

  await runProjectPrepare(projectRoot)

  for (const filePath of createdFiles) {
    writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, filePath)}`)
  }
}

export const cacheMigrationInternals = {
  getRegistryMigrationSlug,
  hasRegisteredMigrationSlug,
  hasRegisteredCreateTableMigration,
  nextMigrationTemplate,
}
