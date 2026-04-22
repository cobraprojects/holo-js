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

function escapeSingleQuotedString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')
}

export function renderCacheTableMigration(
  tableName = DEFAULT_CACHE_DATABASE_TABLE,
  lockTableName = DEFAULT_CACHE_DATABASE_LOCK_TABLE,
): string {
  const escapedTableName = escapeSingleQuotedString(tableName)
  const escapedLockTableName = escapeSingleQuotedString(lockTableName)
  const escapedTableIndexName = escapeSingleQuotedString(`${tableName.replaceAll('.', '_')}_expires_at_index`)
  const escapedLockTableIndexName = escapeSingleQuotedString(`${lockTableName.replaceAll('.', '_')}_expires_at_index`)

  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    `    await schema.createTable('${escapedTableName}', (table) => {`,
    '      table.string(\'key\').primaryKey()',
    '      table.text(\'payload\')',
    '      table.bigInteger(\'expires_at\').nullable()',
    `      table.index(['expires_at'], '${escapedTableIndexName}')`,
    '    })',
    `    await schema.createTable('${escapedLockTableName}', (table) => {`,
    '      table.string(\'name\').primaryKey()',
    '      table.string(\'owner\')',
    '      table.bigInteger(\'expires_at\')',
    `      table.index(['expires_at'], '${escapedLockTableIndexName}')`,
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable('${escapedLockTableName}')`,
    `    await schema.dropTable('${escapedTableName}')`,
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
  const seenTables = new Set<string>()
  const seenLockTables = new Set<string>()
  const seenSlugs = new Map<string, string>()

  for (const { table, lockTable } of resolvedTables) {
    const migrationName = normalizeCacheMigrationName(table)
    const previousTable = seenSlugs.get(migrationName)
    if (seenTables.has(table) || seenLockTables.has(lockTable) || (previousTable && previousTable !== table)) {
      throw new Error(`A migration for cache tables "${table}" and "${lockTable}" already exists.`)
    }

    seenTables.add(table)
    seenLockTables.add(lockTable)
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
