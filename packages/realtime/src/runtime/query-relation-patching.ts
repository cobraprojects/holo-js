import {
  UNPATCHED_RESULT,
} from './query-patch-results'
import { tryPatchBelongsToManyRelation } from './query-relation-belongs-to-many-patching'
import { tryPatchBelongsToParentKeyRelation } from './query-relation-belongs-to-parent-key-patching'
import type {
  DatabaseMutationEvent,
} from './dependencies'
import type {
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import type { BackfillCache } from './state'

export async function tryPatchQueryRelation(
  query: DatabaseQueryObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  const relation = query.relation
  if (!relation) {
    return UNPATCHED_RESULT
  }

  if (!query.patchable) {
    return UNPATCHED_RESULT
  }

  if (relation.kind === 'belongsToParentKey') {
    return await tryPatchBelongsToParentKeyRelation(query, value, mutations, relation, backfills)
  }

  return await tryPatchBelongsToManyRelation(query, value, mutations, relation, backfills)
}
