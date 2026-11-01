import { createHash } from 'node:crypto'
import { SchemaError } from '../core/errors'
import { assertValidIdentifierSegment, sanitizeIdentifierForGeneratedName } from './identifiers'
import type { TableIndexDefinition } from './types'

export interface IndexNameLengthPolicy {
  readonly maxBytes: number
  readonly label: string
}

export const DEFAULT_INDEX_NAME_LENGTH_POLICY: IndexNameLengthPolicy = Object.freeze({
  maxBytes: 63,
  label: 'portable PostgreSQL-compatible (NAMEDATALEN-1)',
})

export function assertValidIndexName(
  indexName: string,
  policy = DEFAULT_INDEX_NAME_LENGTH_POLICY,
): void {
  assertValidIdentifierSegment(indexName, 'Index name')
  assertNameLength(indexName, 'Index', policy)
}

function assertNameLength(indexName: string, kind: string, policy: IndexNameLengthPolicy): void {
  const byteLength = new TextEncoder().encode(indexName).length
  if (byteLength > policy.maxBytes) {
    throw new SchemaError(
      `${kind} name "${indexName}" is ${byteLength} bytes long; ${policy.label} ${kind.toLowerCase()} names must be ${policy.maxBytes} bytes or fewer. Provide a shorter explicit ${kind.toLowerCase()} name.`,
    )
  }
}

export function assertUniqueResolvedIndexNames(
  tableName: string,
  indexes: readonly TableIndexDefinition[],
): void {
  const names = new Set<string>()
  for (const index of indexes) {
    const indexName = resolveGeneratedIndexName(tableName, index)
    if (names.has(indexName)) {
      throw new SchemaError(
        `Index name "${indexName}" is used by multiple indexes on table "${tableName}". Provide explicit unique index names.`,
      )
    }

    names.add(indexName)
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
  assertNameLength(resolvedName, 'Foreign key', DEFAULT_INDEX_NAME_LENGTH_POLICY)
  return resolvedName
}

export function resolveGeneratedCheckName(tableName: string, columnName: string): string {
  const unqualifiedTableName = tableName.split('.').at(-1)!
  const checkName = `${unqualifiedTableName}_${columnName}_check`
  if (checkName.length <= DEFAULT_INDEX_NAME_LENGTH_POLICY.maxBytes) {
    return checkName
  }

  const hash = createHash('sha256').update(checkName).digest('hex').slice(0, 8)
  const prefixLength = DEFAULT_INDEX_NAME_LENGTH_POLICY.maxBytes - `_${hash}_check`.length
  return `${checkName.slice(0, prefixLength)}_${hash}_check`
}
