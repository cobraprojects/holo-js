import { resolve } from 'node:path'
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

export const DEFAULT_CACHE_DATABASE_TABLE = 'cache'
export const DEFAULT_CACHE_DATABASE_LOCK_TABLE = 'cache_locks'

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
  return (loadedConfig as unknown as { readonly cache: CacheConfigShape }).cache
}

export function normalizeCacheMigrationName(tableName: string): string {
  return normalizeMigrationSlug(`create_${tableName.replaceAll('.', '_')}_cache_table`)
}

export function renderCacheTableMigration(
  tableName = DEFAULT_CACHE_DATABASE_TABLE,
  lockTableName = DEFAULT_CACHE_DATABASE_LOCK_TABLE,
): string {
  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    `    await schema.createTable('${tableName}', (table) => {`,
    '      table.string(\'key\').primaryKey()',
    '      table.text(\'payload\')',
    '      table.bigInteger(\'expires_at\').nullable()',
    `      table.index(['expires_at'], '${tableName.replaceAll('.', '_')}_expires_at_index')`,
    '    })',
    `    await schema.createTable('${lockTableName}', (table) => {`,
    '      table.string(\'name\').primaryKey()',
    '      table.string(\'owner\')',
    '      table.bigInteger(\'expires_at\')',
    `      table.index(['expires_at'], '${lockTableName.replaceAll('.', '_')}_expires_at_index')`,
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable('${lockTableName}')`,
    `    await schema.dropTable('${tableName}')`,
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

  const uniqueTables = new Map<string, DatabaseCacheMigrationTables>()
  for (const entry of configured) {
    uniqueTables.set(`${entry.table}::${entry.lockTable}`, entry)
  }

  return Object.freeze([...uniqueTables.values()])
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

  for (const { table, lockTable } of resolveDatabaseCacheTables(cacheConfig)) {
    const migrationName = normalizeCacheMigrationName(table)
    if (
      hasRegisteredMigrationSlug(registry, migrationName)
      || hasRegisteredCreateTableMigration(registry, table)
      || hasRegisteredCreateTableMigration(registry, lockTable)
    ) {
      throw new Error(`A migration for cache tables "${table}" and "${lockTable}" already exists.`)
    }
  }

  for (const { table, lockTable } of resolveDatabaseCacheTables(cacheConfig)) {
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
