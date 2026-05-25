import { assertValidIdentifierSegment, sanitizeIdentifierForGeneratedName } from './identifiers'
import type { TableIndexDefinition } from './types'

const MAX_GENERATED_IDENTIFIER_LENGTH = 63

function hashIndexColumns(columns: readonly string[]): string {
  const serialized = JSON.stringify(columns)
  let hash = 2_166_136_261

  for (let index = 0; index < serialized.length; index += 1) {
    hash = Math.imul(hash ^ serialized.charCodeAt(index), 16_777_619)
  }

  return (hash >>> 0).toString(36)
}

function buildGeneratedIndexName(tableName: string, columnsName: string, columnsHash: string, suffix: string): string {
  const baseName = `${sanitizeIdentifierForGeneratedName(tableName)}_${columnsName}`
  const fullName = `${baseName}_${columnsHash}_${suffix}`
  if (fullName.length <= MAX_GENERATED_IDENTIFIER_LENGTH) {
    return fullName
  }

  const suffixLength = columnsHash.length + suffix.length + 2
  const truncatedBaseName = baseName
    .slice(0, MAX_GENERATED_IDENTIFIER_LENGTH - suffixLength)
    .replace(/_+$/g, '')
  return `${truncatedBaseName}_${columnsHash}_${suffix}`
}

export function resolveGeneratedIndexName(tableName: string, index: TableIndexDefinition): string {
  const columnsName = index.columns
    .map(column => sanitizeIdentifierForGeneratedName(column))
    .join('_')
  const suffix = index.unique ? 'unique' : 'index'
  const indexName = index.name
    ?? buildGeneratedIndexName(tableName, columnsName, hashIndexColumns(index.columns), suffix)
  assertValidIdentifierSegment(indexName, 'Index name')
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
