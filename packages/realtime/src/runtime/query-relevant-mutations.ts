import {
  EMPTY_DATABASE_MUTATIONS,
  type DatabaseMutationEvent,
  type MutationIndex,
} from './dependencies'
import {
  matchesPredicates,
} from './predicate-matching'
import {
  isQueryObservationContradictedByExactPredicates,
} from './predicate-dependency-matching'
import {
  EMPTY_RELEVANT_MUTATION_TARGETS,
  type BackfillCache,
  type QueryPatchTarget,
  type RelevantMutationLookupCache,
  type RelevantMutationTarget,
} from './query-state'

function getRelevantMutations(
  target: QueryPatchTarget,
  mutations: MutationIndex,
): readonly DatabaseMutationEvent[] {
  return mutations.get(target.mutationIndexKey) ?? EMPTY_DATABASE_MUTATIONS
}

function getCachedRelevantMutations(
  target: QueryPatchTarget,
  mutations: MutationIndex,
  cache: RelevantMutationLookupCache,
): readonly DatabaseMutationEvent[] {
  const first = cache.first
  if (first && first.key === target.mutationIndexKey) {
    return first.mutations
  }

  const cachedMutations = cache.mutationsByKey?.get(target.mutationIndexKey)
  if (cachedMutations) {
    return cachedMutations
  }

  const relevantMutations = getRelevantMutations(target, mutations)
  if (!first) {
    cache.first = {
      key: target.mutationIndexKey,
      mutations: relevantMutations,
    }
    return relevantMutations
  }

  cache.mutationsByKey ??= new Map([[first.key, first.mutations]])
  cache.mutationsByKey.set(target.mutationIndexKey, relevantMutations)
  return relevantMutations
}

function targetContradictedByExactPredicates(
  target: QueryPatchTarget,
  backfills: BackfillCache,
): boolean {
  const exactPredicates = backfills.exactPredicates
  if (!exactPredicates || exactPredicates.size === 0) {
    return false
  }

  return isQueryObservationContradictedByExactPredicates(target.query, exactPredicates) === true
}

function mutationContradictedByExactPredicates(
  target: QueryPatchTarget,
  mutation: DatabaseMutationEvent,
  backfills: BackfillCache,
): boolean {
  const exactPredicates = backfills.mutationExactPredicates?.get(mutation)
  if (!exactPredicates || exactPredicates.size === 0) {
    return false
  }

  return isQueryObservationContradictedByExactPredicates(target.query, exactPredicates) === true
}

function mutationRowsContradictTarget(
  target: QueryPatchTarget,
  mutation: DatabaseMutationEvent,
): boolean {
  const query = target.query
  if (query.predicates.length === 0) {
    return false
  }

  switch (mutation.kind) {
    case 'insert':
    case 'delete':
      return mutationRowsCannotMatchTarget(target, mutation.rows)
    case 'update':
    case 'upsert':
      return mutationRowsCannotMatchTarget(target, mutation.previousRows)
        && mutationRowsCannotMatchTarget(target, mutation.rows)
  }
}

function mutationRowsCannotMatchTarget(
  target: QueryPatchTarget,
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): boolean {
  if (!rows || rows.length === 0) {
    return false
  }

  for (const row of rows) {
    const matches = matchesPredicates(row, target.query.predicates)
    if (matches !== false) {
      return false
    }
  }

  return true
}

function mutationContradictedTarget(
  target: QueryPatchTarget,
  mutation: DatabaseMutationEvent,
  backfills: BackfillCache,
): boolean {
  return mutationContradictedByExactPredicates(target, mutation, backfills)
    || mutationRowsContradictTarget(target, mutation)
}

function filterRelevantMutationsForTarget(
  target: QueryPatchTarget,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): readonly DatabaseMutationEvent[] {
  if (mutations.length === 0) {
    return mutations
  }

  let firstMutation: DatabaseMutationEvent | undefined
  let filteredMutations: DatabaseMutationEvent[] | undefined
  for (const mutation of mutations) {
    if (mutationContradictedTarget(target, mutation, backfills)) {
      continue
    }

    if (!firstMutation) {
      firstMutation = mutation
      continue
    }

    filteredMutations ??= [firstMutation]
    filteredMutations.push(mutation)
  }

  if (!firstMutation) {
    return EMPTY_DATABASE_MUTATIONS
  }

  return filteredMutations ? Object.freeze(filteredMutations) : Object.freeze([firstMutation])
}

export function collectRelevantMutationTargets(
  targets: readonly QueryPatchTarget[],
  backfills: BackfillCache,
): readonly RelevantMutationTarget[] {
  const cache: RelevantMutationLookupCache = {}
  let firstRelevantTarget: RelevantMutationTarget | undefined
  let relevantTargets: RelevantMutationTarget[] | undefined
  for (const target of targets) {
    if (targetContradictedByExactPredicates(target, backfills)) {
      continue
    }

    const relevantMutations = getCachedRelevantMutations(target, backfills.mutations, cache)
    const targetMutations = filterRelevantMutationsForTarget(target, relevantMutations, backfills)
    if (targetMutations.length === 0) {
      continue
    }

    const relevantTarget = {
      mutations: targetMutations,
      target,
    }
    if (!firstRelevantTarget) {
      firstRelevantTarget = relevantTarget
      continue
    }

    relevantTargets ??= [firstRelevantTarget]
    relevantTargets.push(relevantTarget)
  }

  if (!firstRelevantTarget) {
    return EMPTY_RELEVANT_MUTATION_TARGETS
  }

  return relevantTargets ?? Object.freeze([firstRelevantTarget])
}
