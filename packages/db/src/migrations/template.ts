import { ConfigurationError } from '../core/errors'
import type {
  GeneratedMigrationTemplate,
  MigrationTemplateKind,
  MigrationTemplateOptions,
} from './types'

const CREATE_TABLE_PATTERN = /^create_(.+?)(?:_table)?$/
const ALTER_TABLE_PATTERN = /^(?:add_.+_to_|remove_.+_from_|rename_.+_on_|alter_)(.+?)(?:_table)?$/
const DROP_TABLE_PATTERN = /^drop_(.+?)(?:_table)?$/

export function normalizeMigrationSlug(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!normalized) {
    throw new ConfigurationError('Migration names must contain at least one alphanumeric character.')
  }

  return normalized
}

export function createMigrationTimestamp(date = new Date()): string {
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')

  return `${year}_${month}_${day}_${hours}${minutes}${seconds}`
}

export function createMigrationFileName(name: string, date = new Date()): string {
  return `${createMigrationTimestamp(date)}_${normalizeMigrationSlug(name)}.ts`
}

export function inferMigrationTemplateKind(slug: string): MigrationTemplateKind {
  if (CREATE_TABLE_PATTERN.test(slug)) {
    return 'create_table'
  }

  if (ALTER_TABLE_PATTERN.test(slug)) {
    return 'alter_table'
  }

  if (DROP_TABLE_PATTERN.test(slug)) {
    return 'drop_table'
  }

  return 'blank'
}

export function inferMigrationTableName(slug: string, kind: MigrationTemplateKind): string | undefined {
  if (kind === 'create_table') {
    return slug.match(CREATE_TABLE_PATTERN)?.[1]
  }

  if (kind === 'alter_table') {
    return slug.match(ALTER_TABLE_PATTERN)?.[1]
  }

  if (kind === 'drop_table') {
    return slug.match(DROP_TABLE_PATTERN)?.[1]
  }

  return undefined
}

export function generateMigrationTemplate(
  name: string,
  options: MigrationTemplateOptions = {},
): GeneratedMigrationTemplate {
  const slug = normalizeMigrationSlug(name)
  const kind = options.kind ?? inferMigrationTemplateKind(slug)
  const tableName = options.tableName ?? inferMigrationTableName(slug, kind)
  const fileName = createMigrationFileName(slug, options.date)
  const migrationName = fileName.replace(/\.ts$/, '')

  if ((kind === 'create_table' || kind === 'alter_table' || kind === 'drop_table') && !tableName) {
    throw new ConfigurationError(`Migration kind "${kind}" requires a table name.`)
  }

  return {
    fileName,
    migrationName,
    kind,
    tableName,
    contents: renderMigrationTemplate({
      migrationName,
      kind,
      tableName,
    }),
  }
}

function renderMigrationTemplate(options: {
  migrationName: string
  kind: MigrationTemplateKind
  tableName?: string
}): string {
  switch (options.kind) {
    case 'create_table':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        `    await schema.createTable('${options.tableName}', (table) => {`,
        '      table.id()',
        '      table.timestamps()',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        `    await schema.dropTable('${options.tableName}')`,
        '  },',
        '})',
        '',
      ].join('\n')
    case 'alter_table':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        `    await schema.table('${options.tableName}', (table) => {`,
        '      void table',
        '    })',
        '  },',
        '  async down({ schema }: MigrationContext) {',
        `    await schema.table('${options.tableName}', (table) => {`,
        '      void table',
        '    })',
        '  },',
        '})',
        '',
      ].join('\n')
    case 'drop_table':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema }: MigrationContext) {',
        `    await schema.dropTable('${options.tableName}')`,
        '  },',
        '  async down() {',
        `    throw new Error('Recreate "${options.tableName}" manually in this migration if rollback support is required.')`,
        '  },',
        '})',
        '',
      ].join('\n')
    case 'blank':
      return [
        'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
        '',
        'export default defineMigration({',
        '  async up({ schema, db }: MigrationContext) {',
        '    void schema',
        '    void db',
        '  },',
        '  async down({ schema, db }: MigrationContext) {',
        '    void schema',
        '    void db',
        '  },',
        '})',
        '',
      ].join('\n')
  }
}
