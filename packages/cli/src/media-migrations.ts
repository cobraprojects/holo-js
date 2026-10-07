import { normalizeMigrationSlug } from '@holo-js/db'
import { createMigrationFiles } from './migration-creation'
import type { IoStreams } from './cli-types'

export const DEFAULT_MEDIA_TABLE = 'media'

export function normalizeMediaMigrationName(tableName = DEFAULT_MEDIA_TABLE): string {
  return normalizeMigrationSlug(`create_${tableName.replaceAll('.', '_')}_table`)
}

export function renderMediaTableMigration(tableName = DEFAULT_MEDIA_TABLE): string {
  const tableNameLiteral = JSON.stringify(tableName)

  return [
    'import { defineMigration } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }) {',
    `    await schema.createTable(${tableNameLiteral}, (table) => {`,
    '      table.id()',
    '      table.uuid(\'uuid\').unique()',
    '      table.string(\'model_type\')',
    '      table.string(\'model_id\')',
    '      table.string(\'collection_name\').default(\'default\')',
    '      table.string(\'name\')',
    '      table.string(\'file_name\')',
    '      table.string(\'disk\')',
    '      table.string(\'conversions_disk\').nullable()',
    '      table.string(\'mime_type\').nullable()',
    '      table.string(\'extension\').nullable()',
    '      table.bigInteger(\'size\')',
    '      table.string(\'path\')',
    '      table.json(\'generated_conversions\')',
    '      table.integer(\'order_column\').default(1)',
    '      table.timestamps()',
    '      table.index([\'path\'])',
    '      table.index([\'file_name\', \'mime_type\'])',
    '      table.index([\'model_type\', \'model_id\'])',
    '      table.index([\'model_type\', \'model_id\', \'collection_name\'])',
    '    })',
    '  },',
    '  async down({ schema }) {',
    `    await schema.dropTable(${tableNameLiteral})`,
    '  },',
    '})',
    '',
  ].join('\n')
}

export function createMediaTableMigration(
  projectRoot: string,
  options?: {
    readonly skipIfExists?: false
  },
): Promise<string>

export function createMediaTableMigration(
  projectRoot: string,
  options: {
    readonly skipIfExists: true
  },
): Promise<string | undefined>

export async function createMediaTableMigration(
  projectRoot: string,
  options: {
    readonly skipIfExists?: boolean
  } = {},
): Promise<string | undefined> {
  const [path] = await createMigrationFiles(projectRoot, () => [mediaMigration(options.skipIfExists)])
  return path
}

export async function runMediaTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  await createMigrationFiles(projectRoot, () => [mediaMigration()], { io, prepare: true })
}

function mediaMigration(skipIfExists = false) {
  return {
    name: normalizeMediaMigrationName(),
    tableNames: [DEFAULT_MEDIA_TABLE],
    contents: renderMediaTableMigration(),
    skipIfExists,
  }
}
