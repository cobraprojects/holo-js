import { assertValidIdentifierSegment, sanitizeIdentifierForGeneratedName } from './identifiers'
import type { TableIndexDefinition } from './types'

function hashIndexColumns(columns: readonly string[]): string {
  const serialized = JSON.stringify(columns)
  let hash = 2_166_136_261

  for (let index = 0; index < serialized.length; index += 1) {
    hash = Math.imul(hash ^ serialized.charCodeAt(index), 16_777_619)
  }

  return (hash >>> 0).toString(36)
}

export function resolveGeneratedIndexName(tableName: string, index: TableIndexDefinition): string {
  const columnsName = index.columns
    .map(column => sanitizeIdentifierForGeneratedName(column))
    .join('_')
  const suffix = index.unique ? 'unique' : 'index'
  const indexName = index.name
    ?? `${sanitizeIdentifierForGeneratedName(tableName)}_${columnsName}_${hashIndexColumns(index.columns)}_${suffix}`
  assertValidIdentifierSegment(indexName, 'Index name')
  return indexName
}

export function resolveGeneratedForeignKeyName(
  tableName: string,
  columnName: string,
  constraintName?: string,
): string {
  const resolvedName = constraintName ?? `${sanitizeIdentifierForGeneratedName(tableName)}_${columnName}_foreign`
  assertValidIdentifierSegment(resolvedName, 'Foreign key name')
  return resolvedName
}
