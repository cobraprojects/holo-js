import { assertValidIdentifierSegment, sanitizeIdentifierForGeneratedName } from './identifiers'
import type { TableIndexDefinition } from './types'

export function resolveGeneratedIndexName(tableName: string, index: TableIndexDefinition): string {
  const indexName = index.name
    ?? `${sanitizeIdentifierForGeneratedName(tableName)}_${index.columns.join('_')}_${index.unique ? 'unique' : 'index'}`
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
