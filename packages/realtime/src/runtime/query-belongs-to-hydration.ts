import { TableQueryBuilder } from '@holo-js/db'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
  type MutationIndex,
} from './dependencies'
import {
  getBackfillDatabaseConnection,
} from './query-backfill'
import type {
  BackfillCache,
  DatabaseQueryBelongsToHydrationObservation,
} from './query-state'
import { stableStringify } from './stable-stringify'

type BelongsToHydrationTarget = {
  readonly foreignKey: string
  readonly ownerKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
}

export async function hydrateBelongsToMutationRows(
  mutation: DatabaseMutationEvent,
  hydrations: readonly DatabaseQueryBelongsToHydrationObservation[] | undefined,
  backfills: BackfillCache,
): Promise<DatabaseMutationEvent | undefined> {
  if (!hydrations || hydrations.length === 0 || !mutation.rows || mutation.kind === 'delete') {
    return mutation
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  for (let index = 0; index < mutation.rows.length; index += 1) {
    const row = mutation.rows[index]
    if (!row) {
      return undefined
    }

    const hydrated = await hydrateBelongsToRow(row, hydrations, backfills, mutation)
    if (hydrated !== row) {
      nextRows ??= [...mutation.rows.slice(0, index)]
    }

    nextRows?.push(hydrated)
  }

  if (!nextRows) {
    return mutation
  }

  return Object.freeze({
    ...mutation,
    rows: Object.freeze(nextRows),
  })
}

export async function hydrateBelongsToRow(
  row: Readonly<Record<string, unknown>>,
  hydrations: readonly DatabaseQueryBelongsToHydrationObservation[],
  backfills: BackfillCache,
  sourceMutation?: DatabaseMutationEvent,
): Promise<Readonly<Record<string, unknown>>> {
  let nextRow = row
  for (const hydration of hydrations) {
    const relatedValue = await readBelongsToHydratedValue(
      hydration,
      row[hydration.foreignKey],
      backfills,
      sourceMutation,
    )

    if (nextRow[hydration.relationKey] === relatedValue) {
      continue
    }

    nextRow = Object.freeze({
      ...nextRow,
      [hydration.relationKey]: relatedValue,
    })
  }

  return nextRow
}

export async function readBelongsToHydratedValue(
  target: BelongsToHydrationTarget,
  foreignKey: unknown,
  backfills: BackfillCache,
  sourceMutation?: DatabaseMutationEvent,
): Promise<Readonly<Record<string, unknown>> | null> {
  if (foreignKey === null || typeof foreignKey === 'undefined') {
    return null
  }

  return findBelongsToRelatedMutationValue(target, foreignKey, backfills.mutations)
    ?? await fetchBelongsToRelatedValue(target, foreignKey, backfills, sourceMutation)
}

function findBelongsToRelatedMutationValue(
  target: BelongsToHydrationTarget,
  foreignKey: unknown,
  mutationIndex: MutationIndex,
): Readonly<Record<string, unknown>> | null | undefined {
  const relatedMutations = mutationIndex.get(createMutationIndexKey(
    target.relatedConnectionName,
    target.relatedTableName,
  ))
  if (!relatedMutations) {
    return undefined
  }

  for (const mutation of relatedMutations) {
    const rows = mutation.rows
    if (!rows) {
      continue
    }

    for (const row of rows) {
      if (row[target.ownerKey] === foreignKey) {
        return mutation.kind === 'delete' ? null : row
      }
    }
  }

  return undefined
}

async function fetchBelongsToRelatedValue(
  target: BelongsToHydrationTarget,
  foreignKey: unknown,
  backfills: BackfillCache,
  sourceMutation: DatabaseMutationEvent | undefined,
): Promise<Readonly<Record<string, unknown>> | null> {
  const groupedValue = await fetchGroupedBelongsToRelatedValue(target, foreignKey, backfills, sourceMutation)
  if (typeof groupedValue !== 'undefined') {
    return groupedValue
  }

  const backfillKey = createBelongsToRelatedBackfillKey(target, foreignKey)
  const pendingBackfill = backfills.rows.get(backfillKey) ?? fetchBelongsToRelatedRow(target, foreignKey)
  backfills.rows.set(backfillKey, pendingBackfill)

  const rows = await pendingBackfill
  return rows?.[0] ?? null
}

async function fetchGroupedBelongsToRelatedValue(
  target: BelongsToHydrationTarget,
  foreignKey: unknown,
  backfills: BackfillCache,
  sourceMutation: DatabaseMutationEvent | undefined,
): Promise<Readonly<Record<string, unknown>> | null | undefined> {
  if (!sourceMutation || !backfills.rowGroups) {
    return undefined
  }

  const values = collectBelongsToForeignKeys(target, sourceMutation, backfills.mutations)
  if (values.length < 2) {
    return undefined
  }

  const backfillKey = createGroupedBelongsToRelatedBackfillKey(target, values)
  const pendingBackfill = backfills.rowGroups.get(backfillKey) ?? fetchGroupedBelongsToRelatedRows(target, values)
  backfills.rowGroups.set(backfillKey, pendingBackfill)

  const rowsByForeignKey = await pendingBackfill
  if (!rowsByForeignKey) {
    return undefined
  }

  return rowsByForeignKey.get(foreignKey)?.[0] ?? null
}

function collectBelongsToForeignKeys(
  target: BelongsToHydrationTarget,
  sourceMutation: DatabaseMutationEvent,
  mutationIndex: MutationIndex,
): readonly unknown[] {
  const sourceMutations = mutationIndex.get(createMutationIndexKey(sourceMutation.connectionName, sourceMutation.tableName))
  if (!sourceMutations) {
    return Object.freeze([])
  }

  const values: unknown[] = []
  for (const mutation of sourceMutations) {
    if (!mutation.rows || mutation.kind === 'delete') {
      continue
    }

    for (const row of mutation.rows) {
      const foreignKey = row[target.foreignKey]
      if (
        foreignKey === null
        || typeof foreignKey === 'undefined'
        || values.some(value => Object.is(value, foreignKey))
      ) {
        continue
      }

      values.push(foreignKey)
    }
  }

  return Object.freeze(values)
}

async function fetchGroupedBelongsToRelatedRows(
  target: BelongsToHydrationTarget,
  values: readonly unknown[],
): Promise<ReadonlyMap<unknown, readonly Readonly<Record<string, unknown>>[]> | undefined> {
  const connection = getBackfillDatabaseConnection(target.relatedConnectionName)
  if (!connection) {
    return undefined
  }

  const rows = await new TableQueryBuilder<string, Record<string, unknown>>(
    target.relatedTableName,
    connection,
  )
    .where(target.ownerKey, 'in', values)
    .get()

  const rowsByForeignKey = new Map<unknown, Readonly<Record<string, unknown>>[]>()
  for (const row of rows) {
    const ownerKey = row[target.ownerKey]
    if (typeof ownerKey === 'undefined') {
      return undefined
    }

    const group = rowsByForeignKey.get(ownerKey) ?? []
    group.push(row)
    rowsByForeignKey.set(ownerKey, group)
  }

  const result = new Map<unknown, readonly Readonly<Record<string, unknown>>[]>()
  for (const value of values) {
    result.set(value, Object.freeze(rowsByForeignKey.get(value) ?? []))
  }

  return result
}

async function fetchBelongsToRelatedRow(
  target: BelongsToHydrationTarget,
  foreignKey: unknown,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const connection = getBackfillDatabaseConnection(target.relatedConnectionName)
  if (!connection) {
    return undefined
  }

  return await new TableQueryBuilder<string, Record<string, unknown>>(
    target.relatedTableName,
    connection,
  )
    .where(target.ownerKey, foreignKey)
    .limit(1)
    .get()
}

function createBelongsToRelatedBackfillKey(
  target: BelongsToHydrationTarget,
  foreignKey: unknown,
): string {
  return `belongs-to:${target.relatedConnectionName}:${target.relatedTableName}:${target.ownerKey}:${stableStringify(foreignKey)}`
}

function createGroupedBelongsToRelatedBackfillKey(
  target: BelongsToHydrationTarget,
  values: readonly unknown[],
): string {
  return `belongs-to-group:${target.relatedConnectionName}:${target.relatedTableName}:${target.ownerKey}:${stableStringify(values)}`
}
