import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalizeMigrationSlug } from '@holo-js/db'
import {
  getRegistryMigrationSlug,
  hasRegisteredCreateTableMigration,
  hasRegisteredMigrationSlug,
  nextMigrationTemplate,
} from './migrations'
import { ensureProjectConfig } from './project/config'
import { prepareProjectDiscovery } from './project/discovery'
import { loadGeneratedProjectRegistry } from './project/registry'
import {
  makeProjectRelativePath,
  resolveDefaultArtifactPath,
} from './project/shared'
import { writeTextFile } from './project/runtime'
import { writeLine } from './io'
import type { IoStreams } from './cli-types'

export const DEFAULT_MEDIA_TABLE = 'media'

export function normalizeMediaMigrationName(tableName = DEFAULT_MEDIA_TABLE): string {
  return normalizeMigrationSlug(`create_${tableName.replaceAll('.', '_')}_table`)
}

export function renderMediaTableMigration(tableName = DEFAULT_MEDIA_TABLE): string {
  const tableNameLiteral = JSON.stringify(tableName)

  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
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
    '      table.json(\'generated_conversions\').default({})',
    '      table.integer(\'order_column\').default(1)',
    '      table.timestamps()',
    '      table.index([\'model_type\', \'model_id\'])',
    '      table.index([\'model_type\', \'model_id\', \'collection_name\'])',
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable(${tableNameLiteral})`,
    '  },',
    '})',
    '',
  ].join('\n')
}

async function hasMigrationFile(migrationsDir: string, migrationName: string): Promise<boolean> {
  const entries = await readdir(migrationsDir).catch(() => [] as string[])

  return entries.some(entry => (
    entry.endsWith(`_${migrationName}.ts`)
    || entry.endsWith(`_${migrationName}.mts`)
    || entry.endsWith(`_${migrationName}.js`)
    || entry.endsWith(`_${migrationName}.mjs`)
    || entry.endsWith(`_${migrationName}.cts`)
    || entry.endsWith(`_${migrationName}.cjs`)
  ))
}

export async function createMediaTableMigration(
  projectRoot: string,
  options: {
    readonly skipIfExists?: boolean
  } = {},
): Promise<string | undefined> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const tableName = DEFAULT_MEDIA_TABLE
  const migrationName = normalizeMediaMigrationName(tableName)
  const migrationsDir = resolve(projectRoot, project.config.paths.migrations)

  if (
    hasRegisteredMigrationSlug(registry, migrationName)
    || hasRegisteredCreateTableMigration(registry, tableName)
    || await hasMigrationFile(migrationsDir, migrationName)
  ) {
    if (options.skipIfExists === true) {
      return undefined
    }

    throw new Error(`A migration for table "${tableName}" already exists.`)
  }

  const migrationTemplate = await nextMigrationTemplate(
    migrationName,
    migrationsDir,
  )
  const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)

  await writeTextFile(migrationFilePath, renderMediaTableMigration(tableName))
  return migrationFilePath
}

export async function runMediaTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  const migrationFilePath = await createMediaTableMigration(projectRoot)
  const { runProjectPrepare } = await import('./dev')

  if (!migrationFilePath) {
    throw new Error(`A migration for table "${DEFAULT_MEDIA_TABLE}" already exists.`)
  }

  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, migrationFilePath)}`)
}

export const mediaMigrationInternals = {
  getRegistryMigrationSlug,
  hasRegisteredMigrationSlug,
  hasRegisteredCreateTableMigration,
  nextMigrationTemplate,
}
