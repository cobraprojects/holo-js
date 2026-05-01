import { defineTable } from './defineTable'
import type { ColumnInput } from './columns'
import type { BoundTableDefinition } from './defineTable'
import type { TableColumnsShape, TableDefinition, TableIndexDefinition } from './types'
import { column } from './columns'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GeneratedSchemaTables {}

export type GeneratedSchemaTableName = Extract<keyof GeneratedSchemaTables, string>
export type GeneratedSchemaTable<TName extends string>
  = TName extends GeneratedSchemaTableName
    ? GeneratedSchemaTables[TName]
    : TableDefinition<TName, TableColumnsShape>

const generatedTables = (() => {
  const runtime = globalThis as typeof globalThis & {
    __holoGeneratedTables__?: Map<string, TableDefinition>
  }

  runtime.__holoGeneratedTables__ ??= new Map<string, TableDefinition>()
  return runtime.__holoGeneratedTables__
})()

export function registerGeneratedTables<TTables extends Record<string, TableDefinition>>(tables: TTables): TTables {
  for (const table of Object.values(tables)) {
    generatedTables.set(table.tableName, table)
  }

  return tables
}

export function defineGeneratedTable<
  TName extends string,
  TColumns extends Record<string, ColumnInput>,
>(
  tableName: TName,
  columns: TColumns,
  options: { indexes?: readonly TableIndexDefinition[] } = {},
): BoundTableDefinition<TName, TColumns> {
  return defineTable(tableName, columns, options)
}

export function clearGeneratedTables(): void {
  generatedTables.clear()
}

export function getGeneratedTableDefinition<TName extends string>(tableName: TName): GeneratedSchemaTable<TName> | undefined {
  return generatedTables.get(tableName) as GeneratedSchemaTable<TName> | undefined
}

export function resolveGeneratedTableDefinition<
  TTables extends Record<string, TableDefinition>,
  TName extends Extract<keyof TTables, string>,
>(
  tableName: TName,
  tables: TTables,
): TTables[TName]
export function resolveGeneratedTableDefinition<TName extends string>(
  tableName: TName,
  tables: Partial<Record<string, TableDefinition>>,
): GeneratedSchemaTable<TName>
export function resolveGeneratedTableDefinition(
  tableName: string,
  tables: Partial<Record<string, TableDefinition>>,
): TableDefinition {
  return (tables[tableName] ?? defineTable(tableName, {
    id: column.id(),
  })) as TableDefinition
}

export function listGeneratedTableDefinitions(): readonly TableDefinition[] {
  return [...generatedTables.values()].sort((left, right) => left.tableName.localeCompare(right.tableName))
}

function toIdentifier(value: string): string {
  const normalized = value
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .map((segment, index) => {
      if (segment.length === 0) {
        return ''
      }

      const lower = segment.toLowerCase()
      if (index === 0) {
        return lower
      }

      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')

  if (normalized.length === 0) {
    return 'table'
  }

  if (/^\d/.test(normalized)) {
    return `table${normalized}`
  }

  return normalized
}

function serializeValue(value: unknown): string {
  if (value instanceof Date) {
    return `new Date(${JSON.stringify(value.toISOString())})`
  }

  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return JSON.stringify(value)
  }

  return 'undefined'
}

function renderReference(tableName: string, columnName: string): string {
  if (columnName === 'id') {
    return `.constrained(${JSON.stringify(tableName)})`
  }

  return `.constrained(${JSON.stringify(tableName)}, ${JSON.stringify(columnName)})`
}

function renderColumnBuilder(table: TableDefinition, columnDefinition: TableDefinition['columns'][string]): string {
  const builder = (() => {
    switch (columnDefinition.kind) {
      case 'id':
        return 'column.id()'
      case 'integer':
        return 'column.integer()'
      case 'bigInteger':
        return columnDefinition.references ? 'column.foreignId()' : 'column.bigInteger()'
      case 'string':
        return 'column.string()'
      case 'text':
        return 'column.text()'
      case 'boolean':
        return 'column.boolean()'
      case 'real':
        return 'column.real()'
      case 'decimal':
        return 'column.decimal()'
      case 'date':
        return 'column.date()'
      case 'datetime':
        return 'column.datetime()'
      case 'timestamp':
        return 'column.timestamp()'
      case 'json':
        return 'column.json()'
      case 'blob':
        return 'column.blob()'
      case 'uuid':
        return columnDefinition.references ? 'column.foreignUuid()' : 'column.uuid()'
      case 'ulid':
        return columnDefinition.references ? 'column.foreignUlid()' : 'column.ulid()'
      case 'snowflake':
        return columnDefinition.references ? 'column.foreignSnowflake()' : 'column.snowflake()'
      case 'vector':
        return `column.vector({ dimensions: ${columnDefinition.vectorDimensions ?? 0} })`
      case 'enum':
        return `column.enum(${JSON.stringify(columnDefinition.enumValues ?? [])})`
    }
  })()

  const chains: string[] = []

  if (columnDefinition.kind !== 'id' && columnDefinition.primaryKey) {
    chains.push('.primaryKey()')
  }

  if (columnDefinition.nullable) {
    chains.push('.nullable()')
  }

  if (columnDefinition.hasDefault) {
    if (columnDefinition.defaultKind === 'now') {
      chains.push('.defaultNow()')
    } else if (typeof columnDefinition.defaultValue !== 'undefined') {
      chains.push(`.default(${serializeValue(columnDefinition.defaultValue)})`)
    }
  }

  if (columnDefinition.generated && columnDefinition.kind !== 'id') {
    chains.push('.generated()')
  }

  if (columnDefinition.unique && !columnDefinition.primaryKey) {
    chains.push('.unique()')
  }

  if (columnDefinition.references) {
    chains.push(renderReference(
      columnDefinition.references.table,
      columnDefinition.references.column,
    ))

    if (columnDefinition.references.constraintName) {
      chains.push(`.constraintName(${JSON.stringify(columnDefinition.references.constraintName)})`)
    }

    if (columnDefinition.references.onDelete) {
      chains.push(`.onDelete(${JSON.stringify(columnDefinition.references.onDelete)})`)
    }

    if (columnDefinition.references.onUpdate) {
      chains.push(`.onUpdate(${JSON.stringify(columnDefinition.references.onUpdate)})`)
    }
  }

  return `${builder}${chains.join('')}`
}

function renderIndex(index: TableIndexDefinition): string {
  return `{ columns: ${JSON.stringify([...index.columns])}, unique: ${index.unique}${index.name ? `, name: ${JSON.stringify(index.name)}` : ''} }`
}

function buildGeneratedSchemaModuleLines(
  tables: readonly TableDefinition[],
  options: { withTypeAugmentation: boolean },
): string[] {
  const renderedTables = [...tables].sort((left, right) => left.tableName.localeCompare(right.tableName))
  const declarations: string[] = [
    'import { column, defineGeneratedTable, registerGeneratedTables } from \'@holo-js/db\'',
    '',
  ]
  const exportedTableEntries: string[] = []
  const interfaceLines: string[] = []

  for (const table of renderedTables) {
    const identifier = toIdentifier(table.tableName)
    exportedTableEntries.push(`${JSON.stringify(table.tableName)}: ${identifier}`)
    interfaceLines.push(`    ${JSON.stringify(table.tableName)}: typeof ${identifier}`)
    declarations.push(`export const ${identifier} = defineGeneratedTable(${JSON.stringify(table.tableName)}, {`)
    for (const columnDefinition of Object.values(table.columns)) {
      declarations.push(`  ${JSON.stringify(columnDefinition.name)}: ${renderColumnBuilder(table, columnDefinition)},`)
    }
    declarations.push(`}${table.indexes.length > 0 ? `, { indexes: [${table.indexes.map(renderIndex).join(', ')}] }` : ''})`)
    declarations.push('')
  }

  if (options.withTypeAugmentation) {
    declarations.push('declare module \'@holo-js/db\' {')
    declarations.push('  interface GeneratedSchemaTables {')
    declarations.push(...interfaceLines)
    declarations.push('  }')
    declarations.push('}')
    declarations.push('')
  }

  declarations.push(
    options.withTypeAugmentation
      ? `export const tables = { ${exportedTableEntries.join(', ')} } as const`
      : `export const tables = Object.freeze({ ${exportedTableEntries.join(', ')} })`,
  )
  declarations.push('')
  declarations.push('registerGeneratedTables(tables)')
  declarations.push('')

  return declarations
}

export function renderGeneratedSchemaPlaceholder(): string {
  return [
    '/* eslint-disable @typescript-eslint/no-empty-object-type */',
    'import { registerGeneratedTables } from \'@holo-js/db\'',
    '',
    'declare module \'@holo-js/db\' {',
    '  interface GeneratedSchemaTables {}',
    '}',
    '',
    'export const tables = {} as const',
    '',
    'registerGeneratedTables(tables)',
    '',
  ].join('\n')
}

export function renderGeneratedSchemaModule(tables: readonly TableDefinition[]): string {
  return buildGeneratedSchemaModuleLines(tables, { withTypeAugmentation: true }).join('\n')
}

export function renderGeneratedSchemaRuntimeModule(tables: readonly TableDefinition[]): string {
  return buildGeneratedSchemaModuleLines(tables, { withTypeAugmentation: false }).join('\n')
}
