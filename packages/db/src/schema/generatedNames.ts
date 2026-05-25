import { SchemaError } from '../core/errors'
import { assertValidIdentifierSegment, sanitizeIdentifierForGeneratedName } from './identifiers'
import type { TableIndexDefinition } from './types'

export interface IndexNameLengthPolicy {
  readonly maxLength: number
  readonly label: string
}

export const DEFAULT_INDEX_NAME_LENGTH_POLICY: IndexNameLengthPolicy = Object.freeze({
  maxLength: 63,
  label: 'portable PostgreSQL-compatible',
})

export function assertValidIndexName(
  indexName: string,
  policy = DEFAULT_INDEX_NAME_LENGTH_POLICY,
): void {
  assertValidIdentifierSegment(indexName, 'Index name')
  if (indexName.length > policy.maxLength) {
    throw new SchemaError(
      `Index name "${indexName}" is ${indexName.length} characters long; ${policy.label} index names must be ${policy.maxLength} characters or fewer. Provide a shorter explicit index name.`,
    )
  }
}

export function resolveGeneratedIndexName(tableName: string, index: TableIndexDefinition): string {
  const suffix = index.unique ? 'unique' : 'index'
  const indexName = index.name
    ?? createConventionalIndexName(tableName, index.columns, suffix)
  assertValidIndexName(indexName)
  return indexName
}

export function createConventionalIndexName(
  tableName: string,
  columns: readonly string[],
  suffix: string,
): string {
  const columnsName = columns
    .map(column => sanitizeIdentifierForGeneratedName(column))
    .join('_')
  return `${sanitizeIdentifierForGeneratedName(tableName)}_${columnsName}_${suffix}`
}

export function resolveConventionalIndexName(
  tableName: string,
  columns: readonly string[],
  suffix = 'index',
): string {
  const indexName = createConventionalIndexName(tableName, columns, suffix)
  assertValidIndexName(indexName)
  return indexName
}

export function resolveGeneratedForeignKeyName(
  tableName: string,
  columnName: string,
  constraintName?: string,
): string {
  const resolvedName = constraintName
    ?? `${sanitizeIdentifierForGeneratedName(tableName)}_${sanitizeIdentifierForGeneratedName(columnName)}_foreign`
  assertValidIdentifierSegment(resolvedName, 'Foreign key name')
  return resolvedName
}
