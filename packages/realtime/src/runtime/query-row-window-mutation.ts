import type { DatabaseMutationEvent } from './dependencies'
import { hydrateBelongsToMutationRows } from './query-belongs-to-hydration'
import { hydrateRelatedMutationRows } from './query-related-hydration'
import { projectedUpdateCannotAffectQueryResult, readMutationPatchMetadata } from './query-row-patch-context'
import type { BackfillCache, DatabaseQueryObservation, MutationPatchMetadata, QueryRowPatchContext } from './query-state'

type PreparedRowWindowMutation = {
  readonly mutation: DatabaseMutationEvent
  readonly metadata: MutationPatchMetadata
}

export async function prepareRowWindowMutation(
  query: DatabaseQueryObservation,
  queryContext: QueryRowPatchContext,
  mutation: DatabaseMutationEvent,
  backfills: BackfillCache,
): Promise<PreparedRowWindowMutation | null | undefined> {
  const metadata = readMutationPatchMetadata(mutation, backfills)
  if (projectedUpdateCannotAffectQueryResult(query, queryContext, mutation, metadata)) {
    return null
  }

  const belongsToHydratedMutation = await hydrateBelongsToMutationRows(mutation, query.belongsToHydrations, backfills)
  if (!belongsToHydratedMutation) {
    return undefined
  }

  const hydratedMutation = await hydrateRelatedMutationRows(belongsToHydratedMutation, query.relatedHydrations, backfills)
  return hydratedMutation ? { mutation: hydratedMutation, metadata } : undefined
}

