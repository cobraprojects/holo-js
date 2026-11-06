import { TableQueryBuilder } from '@holo-js/db'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
  type MutationIndex,
} from './dependencies'
import {
  hasRecordKey,
  matchesPredicates,
  mutationChangesColumns,
} from './predicate-matching'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import { getBackfillDatabaseConnection, readBackfilledRows } from './query-backfill'
import type {
  DatabaseQueryBelongsToManyRelationObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import type { BackfillCache } from './state'
import { isRecord } from './value'

const NO_CHANGED_COLUMNS: ReadonlySet<string> = new Set()

export async function tryPatchBelongsToManyRelation(
  query: DatabaseQueryObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  relation: DatabaseQueryBelongsToManyRelationObservation,
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  if (!Array.isArray(value)) {
    return UNPATCHED_RESULT
  }

  if (!value.every(isRecord)) {
    return UNPATCHED_RESULT
  }

  let rows: readonly Readonly<Record<string, unknown>>[] = value
  let changed = false
  for (const mutation of mutations) {
    if (!mutation.rows) {
      return UNPATCHED_RESULT
    }

    const relatedMutation = isRelatedRelationMutation(mutation, relation)
    if (!relatedMutation && pivotMutationMayMoveRows(mutation, relation)) {
      return UNPATCHED_RESULT
    }

    for (const pivotRow of mutation.rows) {
      if (relatedMutation) {
        const nextRows = patchRelatedBelongsToManyRelationRow(rows, pivotRow, relation, mutation.kind)
        if (!nextRows) {
          return UNPATCHED_RESULT
        }

        if (nextRows !== rows) {
          rows = nextRows
          changed = true
        }
        continue
      }

      const matches = matchesPredicates(pivotRow, query.predicates)
      if (typeof matches === 'undefined') {
        return UNPATCHED_RESULT
      }

      if (!matches) {
        continue
      }

      if (mutation.kind === 'delete') {
        const nextRows = removeBelongsToManyRelationRow(rows, pivotRow, relation, NO_CHANGED_COLUMNS)
        if (!nextRows) {
          return UNPATCHED_RESULT
        }

        if (nextRows !== rows) {
          rows = nextRows
          changed = true
        }
        continue
      }

      if (mutation.kind === 'update') {
        if (mutation.values && (hasRecordKey(mutation.values, relation.foreignPivotKey) || hasRecordKey(mutation.values, relation.relatedPivotKey))) {
          return UNPATCHED_RESULT
        }

        const nextRows = updateBelongsToManyRelationPivot(
          rows,
          pivotRow,
          relation,
          mutation.values ? new Set(Object.keys(mutation.values)) : undefined,
        )
        if (!nextRows) {
          return UNPATCHED_RESULT
        }

        if (nextRows !== rows) {
          rows = nextRows
          changed = true
        }
        continue
      }

      if (mutation.kind !== 'insert') {
        return UNPATCHED_RESULT
      }

      if (relation.pivotOrderBy.length === 0 || holdsRelatedRow(rows, pivotRow, relation)) {
        return UNPATCHED_RESULT
      }

      const relatedRow = await readRelatedRelationRow(relation, pivotRow, backfills.mutations)
      if (!relatedRow) {
        return UNPATCHED_RESULT
      }

      const relationRow = createBelongsToManyRelationRow(relation, relatedRow, pivotRow)
      const nextRows = insertOrderedBelongsToManyRelationRow(rows, relationRow, relation)
      if (!nextRows) {
        return UNPATCHED_RESULT
      }

      if (nextRows !== rows) {
        rows = nextRows
        changed = true
      }
    }
  }

  return changed
    ? Object.freeze({
        patched: true,
        query,
        value: rows,
      })
    : UNCHANGED_QUERY_RESULT
}

function pivotMutationMayMoveRows(
  mutation: DatabaseMutationEvent,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): boolean {
  if (mutation.kind === 'upsert') {
    return true
  }

  return mutation.kind === 'update'
    && (!mutation.values || mutationChangesColumns(mutation, [relation.foreignPivotKey, relation.relatedPivotKey]))
}

function isRelatedRelationMutation(
  mutation: DatabaseMutationEvent,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): boolean {
  return mutation.connectionName === relation.relatedConnectionName
    && mutation.tableName === relation.relatedTableName
}

function patchRelatedBelongsToManyRelationRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
  kind: DatabaseMutationEvent['kind'],
): readonly Readonly<Record<string, unknown>>[] | undefined {
  switch (kind) {
    case 'delete':
      return removeRelatedBelongsToManyRelationRow(rows, row, relation)
    case 'update':
    case 'upsert':
      return updateRelatedBelongsToManyRelationRow(rows, row, relation)
    case 'insert':
      return rows
  }
}

function updateRelatedBelongsToManyRelationRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const matches = findRelatedRelationRowIndexes(rows, row, relation)
  if (!matches) {
    return undefined
  }

  if (matches.size === 0) {
    return rows
  }

  return Object.freeze(rows.map((current, index) => matches.has(index)
    ? Object.freeze({
        ...current,
        ...row,
        [relation.pivotAccessor]: current[relation.pivotAccessor],
      })
    : current))
}

function removeRelatedBelongsToManyRelationRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const matches = findRelatedRelationRowIndexes(rows, row, relation)
  if (!matches) {
    return undefined
  }

  if (matches.size === 0) {
    return rows
  }

  return Object.freeze(rows.filter((_, index) => !matches.has(index)))
}

function findRelatedRelationRowIndexes(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): ReadonlySet<number> | undefined {
  const relatedId = row[relation.relatedKey]
  if (typeof relatedId === 'undefined') {
    return undefined
  }

  const indexes = new Set<number>()
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index]
    if (!current) {
      return undefined
    }

    if (current[relation.relatedKey] === relatedId) {
      indexes.add(index)
    }
  }

  return indexes
}

async function readRelatedRelationRow(
  relation: DatabaseQueryBelongsToManyRelationObservation,
  pivotRow: Readonly<Record<string, unknown>>,
  mutationIndex: MutationIndex,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  return findRelatedMutationRow(relation, pivotRow, mutationIndex)
    ?? await fetchRelatedRelationRow(relation, pivotRow)
}

function findRelatedMutationRow(
  relation: DatabaseQueryBelongsToManyRelationObservation,
  pivotRow: Readonly<Record<string, unknown>>,
  mutationIndex: MutationIndex,
): Readonly<Record<string, unknown>> | undefined {
  const relatedId = pivotRow[relation.relatedPivotKey]
  const relatedMutations = mutationIndex.get(createMutationIndexKey(
    relation.relatedConnectionName,
    relation.relatedTableName,
  ))
  if (!relatedMutations) {
    return undefined
  }

  for (const mutation of relatedMutations) {
    if (!mutation.rows) {
      continue
    }

    for (const row of mutation.rows) {
      if (row[relation.relatedKey] === relatedId) {
        return row
      }
    }
  }

  return undefined
}

async function fetchRelatedRelationRow(
  relation: DatabaseQueryBelongsToManyRelationObservation,
  pivotRow: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const relatedId = pivotRow[relation.relatedPivotKey]
  const connection = getBackfillDatabaseConnection(relation.relatedConnectionName)
  if (!connection) {
    return undefined
  }

  const rows = readBackfilledRows(relation.relatedTable, await new TableQueryBuilder<string, Record<string, unknown>>(
    relation.relatedTableName,
    connection,
  )
    .where(relation.relatedKey, relatedId)
    .limit(1)
    .get())

  return rows[0]
}

function createBelongsToManyRelationRow(
  relation: DatabaseQueryBelongsToManyRelationObservation,
  relatedRow: Readonly<Record<string, unknown>>,
  pivotRow: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...relatedRow,
    [relation.pivotAccessor]: createPivotValue(relation, pivotRow),
  })
}

function createPivotValue(
  relation: DatabaseQueryBelongsToManyRelationObservation,
  pivotRow: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const pivotValue: Record<string, unknown> = {}
  for (const column of [
    relation.foreignPivotKey,
    relation.relatedPivotKey,
    ...relation.pivotColumns,
  ]) {
    if (Object.prototype.hasOwnProperty.call(pivotRow, column)) {
      pivotValue[column] = pivotRow[column]
    }
  }

  return Object.freeze(pivotValue)
}

function insertOrderedBelongsToManyRelationRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const index = findBelongsToManyInsertIndex(rows, row, relation)
  if (typeof index === 'undefined') {
    return undefined
  }

  return Object.freeze([
    ...rows.slice(0, index),
    row,
    ...rows.slice(index),
  ])
}

function holdsRelatedRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  pivotRow: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): boolean {
  return findBelongsToManyRelationCandidates(rows, pivotRow, relation)?.length !== 0
}

function updateBelongsToManyRelationPivot(
  rows: readonly Readonly<Record<string, unknown>>[],
  pivotRow: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
  changedColumns: ReadonlySet<string> | undefined,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const match = findBelongsToManyRelationRow(rows, pivotRow, relation, changedColumns)
  if (typeof match === 'undefined') {
    return undefined
  }

  if (match === null) {
    return rows
  }

  const row = Object.freeze({
    ...match.row,
    [relation.pivotAccessor]: createPivotValue(relation, pivotRow),
  })
  const remainingRows = Object.freeze([
    ...rows.slice(0, match.index),
    ...rows.slice(match.index + 1),
  ])
  const nextIndex = relation.pivotOrderBy.length === 0
    ? match.index
    : findBelongsToManyInsertIndex(remainingRows, row, relation)
  if (typeof nextIndex === 'undefined') {
    return undefined
  }

  return Object.freeze([
    ...remainingRows.slice(0, nextIndex),
    row,
    ...remainingRows.slice(nextIndex),
  ])
}

function removeBelongsToManyRelationRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  pivotRow: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
  changedColumns: ReadonlySet<string>,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const match = findBelongsToManyRelationRow(rows, pivotRow, relation, changedColumns)
  if (typeof match === 'undefined') {
    return undefined
  }

  if (match === null) {
    return rows
  }

  return Object.freeze([
    ...rows.slice(0, match.index),
    ...rows.slice(match.index + 1),
  ])
}

type BelongsToManyRelationRowMatch = { readonly index: number, readonly row: Readonly<Record<string, unknown>> }

function findBelongsToManyRelationRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  pivotRow: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
  changedColumns: ReadonlySet<string> | undefined,
): BelongsToManyRelationRowMatch | null | undefined {
  const candidates = findBelongsToManyRelationCandidates(rows, pivotRow, relation)
  if (!candidates) {
    return undefined
  }

  if (candidates.length === 0) {
    return null
  }

  const [candidate, ...others] = candidates
  if (others.length === 0) {
    return candidate
  }

  if (!changedColumns) {
    return undefined
  }

  const matches = candidates.filter(match => pivotIdentityMatches(match.row, pivotRow, relation, changedColumns))
  return matches.length === 1 ? matches[0] : undefined
}

function findBelongsToManyRelationCandidates(
  rows: readonly Readonly<Record<string, unknown>>[],
  pivotRow: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): readonly BelongsToManyRelationRowMatch[] | undefined {
  const relatedId = pivotRow[relation.relatedPivotKey]
  if (typeof relatedId === 'undefined') {
    return undefined
  }

  const candidates: BelongsToManyRelationRowMatch[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      return undefined
    }

    if (row[relation.relatedKey] === relatedId) {
      candidates.push(Object.freeze({ index, row }))
    }
  }

  return candidates
}

function pivotIdentityMatches(
  row: Readonly<Record<string, unknown>>,
  pivotRow: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
  changedColumns: ReadonlySet<string>,
): boolean {
  const pivot = row[relation.pivotAccessor]
  if (!isRecord(pivot)) {
    return false
  }

  return relation.pivotColumns.every(column => changedColumns.has(column)
    || (hasRecordKey(pivot, column) && hasRecordKey(pivotRow, column) && pivot[column] === pivotRow[column]))
}

function findBelongsToManyInsertIndex(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): number | undefined {
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index]
    if (!current) {
      return undefined
    }

    const comparison = compareBelongsToManyRelationRows(row, current, relation)
    if (typeof comparison === 'undefined') {
      return undefined
    }

    if (comparison < 0) {
      return index
    }
  }

  return rows.length
}

function compareBelongsToManyRelationRows(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
): number | undefined {
  for (const order of relation.pivotOrderBy) {
    const leftValue = readPivotOrderValue(left, relation, order.column)
    const rightValue = readPivotOrderValue(right, relation, order.column)
    if (!isComparableValue(leftValue) || !isComparableValue(rightValue)) {
      return undefined
    }

    if (leftValue === rightValue) {
      continue
    }

    const comparison = leftValue < rightValue ? -1 : 1
    return order.direction === 'desc' ? -comparison : comparison
  }

  return 0
}

function readPivotOrderValue(
  row: Readonly<Record<string, unknown>>,
  relation: DatabaseQueryBelongsToManyRelationObservation,
  column: string,
): unknown {
  const pivot = row[relation.pivotAccessor]
  return isRecord(pivot) ? pivot[column] : undefined
}

function isComparableValue(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string'
}
