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

export const DEFAULT_DATABASE_QUEUE_TABLE = 'jobs'
export const DEFAULT_FAILED_JOBS_TABLE = 'failed_jobs'

export async function loadQueueConfig(projectRoot: string) {
  return (await loadConfigDirectory(projectRoot)).queue
}

export function normalizeQueueMigrationName(tableName: string): string {
  return normalizeMigrationSlug(`create_${tableName.replaceAll('.', '_')}_table`)
}

export function renderQueueTableMigration(tableName: string): string {
  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    `    await schema.createTable('${tableName}', (table) => {`,
    '      table.string(\'id\').primaryKey()',
    '      table.string(\'job\')',
    '      table.string(\'connection\')',
    '      table.string(\'queue\')',
    '      table.text(\'payload\')',
    '      table.integer(\'attempts\').default(0)',
    '      table.integer(\'max_attempts\').default(1)',
    '      table.bigInteger(\'available_at\')',
    '      table.bigInteger(\'reserved_at\').nullable()',
    '      table.string(\'reservation_id\').nullable()',
    '      table.bigInteger(\'created_at\')',
    `      table.index(['queue', 'available_at'], '${tableName.replaceAll('.', '_')}_queue_available_at_index')`,
    `      table.index(['queue', 'reserved_at'], '${tableName.replaceAll('.', '_')}_queue_reserved_at_index')`,
    `      table.index(['reservation_id'], '${tableName.replaceAll('.', '_')}_reservation_id_index')`,
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable('${tableName}')`,
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderFailedJobsTableMigration(tableName: string): string {
  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    `    await schema.createTable('${tableName}', (table) => {`,
    '      table.string(\'id\').primaryKey()',
    '      table.string(\'job_id\')',
    '      table.string(\'job\')',
    '      table.string(\'connection\')',
    '      table.string(\'queue\')',
    '      table.text(\'payload\')',
    '      table.text(\'exception\')',
    '      table.bigInteger(\'failed_at\')',
    `      table.index(['job_id'], '${tableName.replaceAll('.', '_')}_job_id_index')`,
    `      table.index(['failed_at'], '${tableName.replaceAll('.', '_')}_failed_at_index')`,
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable('${tableName}')`,
    '  },',
    '})',
    '',
  ].join('\n')
}

export function resolveDatabaseQueueTables(queueConfig: Awaited<ReturnType<typeof loadQueueConfig>>): readonly string[] {
  const configured = Object.values(queueConfig.connections)
    .filter(connection => connection.driver === 'database')
    .map(connection => connection.table)

  return Object.freeze(configured.length > 0 ? [...new Set(configured)] : [DEFAULT_DATABASE_QUEUE_TABLE])
}

export async function runQueueTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const queueConfig = await loadQueueConfig(projectRoot)
  const migrationsDir = resolve(projectRoot, project.config.paths.migrations)
  const createdFiles: string[] = []

  for (const tableName of resolveDatabaseQueueTables(queueConfig)) {
    const migrationName = normalizeQueueMigrationName(tableName)
    if (hasRegisteredMigrationSlug(registry, migrationName) || hasRegisteredCreateTableMigration(registry, tableName)) {
      throw new Error(`A migration for table "${tableName}" already exists.`)
    }
  }

  for (const tableName of resolveDatabaseQueueTables(queueConfig)) {
    const migrationTemplate = await nextMigrationTemplate(normalizeQueueMigrationName(tableName), migrationsDir)
    const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)
    await writeTextFile(migrationFilePath, renderQueueTableMigration(tableName))
    createdFiles.push(migrationFilePath)
  }

  await runProjectPrepare(projectRoot)

  for (const filePath of createdFiles) {
    writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, filePath)}`)
  }
}

export async function runQueueFailedTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const queueConfig = await loadQueueConfig(projectRoot)
  const tableName = queueConfig.failed === false ? DEFAULT_FAILED_JOBS_TABLE : queueConfig.failed.table
  const migrationName = normalizeQueueMigrationName(tableName)

  if (hasRegisteredMigrationSlug(registry, migrationName) || hasRegisteredCreateTableMigration(registry, tableName)) {
    throw new Error(`A migration for table "${tableName}" already exists.`)
  }

  const migrationTemplate = await nextMigrationTemplate(
    migrationName,
    resolve(projectRoot, project.config.paths.migrations),
  )
  const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)

  await writeTextFile(migrationFilePath, renderFailedJobsTableMigration(tableName))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, migrationFilePath)}`)
}

export const queueMigrationInternals = {
  getRegistryMigrationSlug,
  hasRegisteredMigrationSlug,
  hasRegisteredCreateTableMigration,
  nextMigrationTemplate,
}
