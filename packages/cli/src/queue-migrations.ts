import { createMigrationFiles } from './migration-creation'
import { loadConfigDirectory } from '@holo-js/config'
import type { NormalizedQueueDatabaseConnectionConfig } from '@holo-js/queue'
import { normalizeMigrationSlug } from '@holo-js/db'
import {
  getRegistryMigrationSlug,
  hasRegisteredCreateTableMigration,
  hasRegisteredMigrationSlug,
  nextMigrationTemplate,
} from './migrations'
import type { IoStreams } from './cli-types'

export const DEFAULT_DATABASE_QUEUE_TABLE = 'jobs'
export const DEFAULT_FAILED_JOBS_TABLE = 'failed_jobs'

export async function loadQueueConfig(projectRoot: string) {
  await import('@holo-js/queue/config')
  return (await loadConfigDirectory(projectRoot)).queue
}

function isDatabaseQueueConnection(
  connection: Awaited<ReturnType<typeof loadQueueConfig>>['connections'][string],
): connection is NormalizedQueueDatabaseConnectionConfig {
  return connection.driver === 'database'
}

export function normalizeQueueMigrationName(tableName: string): string {
  return normalizeMigrationSlug(`create_${tableName.replaceAll('.', '_')}_table`)
}

function renderStringLiteral(value: string): string {
  return JSON.stringify(value)
}

export function renderQueueTableMigration(tableName: string): string {
  const indexPrefix = tableName.replaceAll('.', '_')

  return [
    'import { defineMigration } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }) {',
    `    await schema.createTable(${renderStringLiteral(tableName)}, (table) => {`,
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
    `      table.index(['queue', 'available_at'], ${renderStringLiteral(`${indexPrefix}_queue_available_at_index`)})`,
    `      table.index(['queue', 'reserved_at'], ${renderStringLiteral(`${indexPrefix}_queue_reserved_at_index`)})`,
    `      table.index(['reservation_id'], ${renderStringLiteral(`${indexPrefix}_reservation_id_index`)})`,
    '    })',
    '  },',
    '  async down({ schema }) {',
    `    await schema.dropTable(${renderStringLiteral(tableName)})`,
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderFailedJobsTableMigration(tableName: string): string {
  const indexPrefix = tableName.replaceAll('.', '_')

  return [
    'import { defineMigration } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }) {',
    `    await schema.createTable(${renderStringLiteral(tableName)}, (table) => {`,
    '      table.string(\'id\').primaryKey()',
    '      table.string(\'job_id\')',
    '      table.string(\'job\')',
    '      table.string(\'connection\')',
    '      table.string(\'queue\')',
    '      table.text(\'payload\')',
    '      table.text(\'exception\')',
    '      table.bigInteger(\'failed_at\')',
    `      table.index(['job_id'], ${renderStringLiteral(`${indexPrefix}_job_id_index`)})`,
    `      table.index(['failed_at'], ${renderStringLiteral(`${indexPrefix}_failed_at_index`)})`,
    '    })',
    '  },',
    '  async down({ schema }) {',
    `    await schema.dropTable(${renderStringLiteral(tableName)})`,
    '  },',
    '})',
    '',
  ].join('\n')
}

export function resolveDatabaseQueueTables(queueConfig: Awaited<ReturnType<typeof loadQueueConfig>>): readonly string[] {
  const configured = Object.values(queueConfig.connections)
    .filter(isDatabaseQueueConnection)
    .map(connection => connection.table)

  return Object.freeze(configured.length > 0 ? [...new Set(configured)] : [DEFAULT_DATABASE_QUEUE_TABLE])
}

export async function runQueueTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  await createMigrationFiles(projectRoot, async () => {
    const queueConfig = await loadQueueConfig(projectRoot)
    return resolveDatabaseQueueTables(queueConfig).map(tableName => ({
      name: normalizeQueueMigrationName(tableName),
      tableNames: [tableName],
      contents: renderQueueTableMigration(tableName),
    }))
  }, { io, prepare: true })
}

export async function runQueueFailedTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  await createMigrationFiles(projectRoot, async () => {
    const queueConfig = await loadQueueConfig(projectRoot)
    const tableName = queueConfig.failed === false ? DEFAULT_FAILED_JOBS_TABLE : queueConfig.failed.table
    return [{
      name: normalizeQueueMigrationName(tableName),
      tableNames: [tableName],
      contents: renderFailedJobsTableMigration(tableName),
    }]
  }, { io, prepare: true })
}

export const queueMigrationInternals = {
  getRegistryMigrationSlug,
  hasRegisteredMigrationSlug,
  hasRegisteredCreateTableMigration,
  nextMigrationTemplate,
}
