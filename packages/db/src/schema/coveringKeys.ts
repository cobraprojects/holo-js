import { SchemaError } from '../core/errors'
import { sameIdentifiers } from './introspection/sqliteTokens'
import type { DatabaseForeignKeyStructure, DatabaseIndexStructure, DatabaseTableStructure } from './introspection'

type CoveringKeyKind = 'unique index' | 'index' | 'foreign key'

export function resolveCoveringIndex(
  tableName: string,
  structure: DatabaseTableStructure | undefined,
  columns: readonly string[],
  unique: boolean,
): DatabaseIndexStructure {
  const candidates = (structure?.indexes ?? []).filter(index => !index.primary
    && index.unique === unique
    && sameColumns(structure, index.columns, columns))
  return selectOnlyCandidate(tableName, unique ? 'unique index' : 'index', columns, candidates)
}

export function resolveCoveringForeignKey(
  tableName: string,
  structure: DatabaseTableStructure | undefined,
  columns: readonly string[],
): DatabaseForeignKeyStructure {
  const candidates = (structure?.foreignKeys ?? []).filter(foreignKey => foreignKey.from === foreignKey.columns[0]
    && sameColumns(structure, foreignKey.columns, columns))
  return selectOnlyCandidate(tableName, 'foreign key', columns, candidates)
}

function sameColumns(structure: DatabaseTableStructure | undefined, actual: readonly string[], requested: readonly string[]): boolean {
  return structure?.dialect === 'postgres'
    ? actual.length === requested.length && actual.every((column, index) => column === requested[index])
    : sameIdentifiers(actual, requested)
}

function selectOnlyCandidate<TCandidate extends { readonly name?: string }>(
  tableName: string,
  kind: CoveringKeyKind,
  columns: readonly string[],
  candidates: readonly TCandidate[],
): TCandidate {
  const [candidate, ...otherCandidates] = candidates
  const columnList = `"${columns.join('", "')}"`
  if (!candidate) {
    throw new SchemaError(`Table "${tableName}" has no ${kind} on columns ${columnList}.`)
  }
  if (otherCandidates.length > 0) {
    const names = candidates.map(match => match.name === undefined ? 'an unnamed key' : `"${match.name}"`).sort().join(', ')
    throw new SchemaError(`Table "${tableName}" has more than one ${kind} on columns ${columnList}: ${names}. Drop one by name.`)
  }
  return candidate
}
