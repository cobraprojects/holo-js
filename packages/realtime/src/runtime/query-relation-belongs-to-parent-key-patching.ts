import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  matchesPredicates,
} from './predicate-matching'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import { readBelongsToHydratedValue } from './query-belongs-to-hydration'
import type {
  DatabaseQueryBelongsToParentKeyRelationObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import type { BackfillCache } from './state'
import { isRecord } from './value'

export async function tryPatchBelongsToParentKeyRelation(
  query: DatabaseQueryObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  relation: DatabaseQueryBelongsToParentKeyRelationObservation,
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  if (!isRecord(value)) {
    return UNPATCHED_RESULT
  }

  let nextValue = value
  let changed = false

  for (const mutation of mutations) {
    if (mutation.kind === 'delete') {
      continue
    }

    const matchedRows = readMatchingBelongsToParentMutationRows(query, mutation, relation.foreignKey)
    if (!matchedRows) {
      return UNPATCHED_RESULT
    }

    for (const row of matchedRows) {
      const foreignKey = row[relation.foreignKey]
      const relatedValue = await readBelongsToHydratedValue(relation, foreignKey, backfills, mutation)

      if (nextValue[relation.foreignKey] !== foreignKey || nextValue[relation.relationKey] !== relatedValue) {
        nextValue = Object.freeze({
          ...nextValue,
          [relation.foreignKey]: foreignKey,
          [relation.relationKey]: relatedValue,
        })
        changed = true
      }
    }
  }

  return changed
    ? Object.freeze({
        patched: true,
        query,
        value: nextValue,
      })
    : UNCHANGED_QUERY_RESULT
}

function readMatchingBelongsToParentMutationRows(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  foreignKey: string,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const values = mutation.values
  if (values) {
    if (!Object.prototype.hasOwnProperty.call(values, foreignKey)) {
      return Object.freeze([])
    }

    const matches = mutationPredicatesContainQueryPredicates(query, mutation)
    if (typeof matches === 'undefined') {
      return undefined
    }

    return matches ? Object.freeze([values]) : Object.freeze([])
  }

  const rows = mutation.rows
  if (!rows) {
    return Object.freeze([])
  }

  if (!rows.some(row => Object.prototype.hasOwnProperty.call(row, foreignKey))) {
    return Object.freeze([])
  }

  const matchingRows: Readonly<Record<string, unknown>>[] = []
  for (const row of rows) {
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (matches) {
      matchingRows.push(row)
    }
  }

  return Object.freeze(matchingRows)
}

function mutationPredicatesContainQueryPredicates(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
): boolean | undefined {
  for (const queryPredicate of query.predicates) {
    if (queryPredicate.operator !== '=') {
      return undefined
    }

    const mutationPredicate = mutation.predicates.find(predicate => predicate.column === queryPredicate.column)
    if (!mutationPredicate) {
      return undefined
    }

    if (mutationPredicate.operator === '=' && mutationPredicate.value === queryPredicate.value) {
      continue
    }

    if (
      mutationPredicate.operator === 'in'
      && Array.isArray(mutationPredicate.value)
      && mutationPredicate.value.includes(queryPredicate.value)
    ) {
      continue
    }

    return false
  }

  return true
}
