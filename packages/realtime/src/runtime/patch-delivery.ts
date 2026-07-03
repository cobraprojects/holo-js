import type { RealtimeQueryDefinitionMetadata } from '../contracts'
import type { DatabaseMutationEvent } from './dependencies'
import { deliverPatchedQueryData } from './delivery'
import {
  compactPatchOperations,
  createReplacePatchOperations,
} from './patch-operations'
import {
  createPatchedQueryObservation,
  isPatchableQueryPatchTarget,
  readPatchPathKey,
  tryPatchObservedQuery,
  updateDelayedPatchedQueryPatchTarget,
  updatePatchedQueryPatchTarget,
} from './query-patching'
import {
  readMutationValueKeys,
} from './predicate-matching'
import { collectRelevantMutationTargets } from './query-relevant-mutations'
import type {
  PatchedQueryDelivery,
  PatchedQueryResult,
  QueryPatchTarget,
  RelevantMutationTarget,
} from './query-state'
import {
  EMPTY_RESULT_PATH,
  applyTopLevelPathReplacement,
  canReplaceTopLevelPath,
  finishTopLevelPathReplacement,
  getValueAtPath,
  replacePatchedQueryDataWithPlan,
  replaceTwoValuesAtPaths,
  replaceValueAtPath,
  type TopLevelReplacementState,
} from './result-patching'
import {
  getRuntimeState,
  type ActiveQueryEntry,
  type BackfillCache,
  type RealtimeSubscriptionPatchOperation,
} from './state'

const EMPTY_PATCHED_QUERY_DELIVERIES: readonly PatchedQueryDelivery[] = Object.freeze([])
const EMPTY_PATCH_OPERATIONS: readonly RealtimeSubscriptionPatchOperation[] = Object.freeze([])

export async function tryPatchQueryEntry(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  backfills: BackfillCache,
): Promise<boolean> {
  if (getRuntimeState().refreshes.get(entry.refreshKey)?.running) {
    return false
  }

  if (!entry.current) {
    return false
  }

  let firstPatch: PatchedQueryResult | undefined
  let firstPatchIndex = -1
  let additionalPatches: PatchedQueryDelivery[] | undefined
  let patchedValuesByPathKey: Map<string, unknown> | undefined
  let patchedBelongsToHydrationKeys: Set<string> | undefined
  let handledUnchangedPatch = false
  const version = entry.version
  const data = entry.current.data
  const relevantTargets = collectRelevantMutationTargets(entry.patchTargets, backfills)
  for (const { mutations, target } of relevantTargets) {
    if (canSkipPatchedBelongsToHydrationTarget(target, patchedBelongsToHydrationKeys)) {
      continue
    }

    if (canSkipCoveredHydratedMutationValueTarget(target, mutations, relevantTargets)) {
      continue
    }

    if (!isPatchableQueryPatchTarget(target)) {
      if (canSkipCoveredUnpatchableTarget(target, mutations, relevantTargets)) {
        continue
      }

      return false
    }

    const result = await tryPatchObservedQuery(target, mutations, backfills)
    if (entry.version !== version) {
      return false
    }

    if (!result.patched) {
      return false
    }

    if ('unchanged' in result) {
      handledUnchangedPatch = true
      if (result.nextQuery) {
        const pathKey = readPatchPathKey(result.nextQuery, target)
        const nextQuery = createPatchedQueryObservation(result.nextQuery, target.currentValue, pathKey)
        const path = nextQuery.resultPath!
        entry.queries[target.index] = nextQuery
        entry.patchTargets[target.index] = updatePatchedQueryPatchTarget(
          target,
          nextQuery,
          target.currentValue,
          data,
          path,
          pathKey,
        )
      }

      continue
    }

    patchedBelongsToHydrationKeys = recordPatchedBelongsToHydrationKeys(target, patchedBelongsToHydrationKeys)
    patchedValuesByPathKey ??= new Map()
    if (patchedValuesByPathKey.has(target.resultPathKey)) {
      if (!Object.is(patchedValuesByPathKey.get(target.resultPathKey), result.value)) {
        return false
      }
    } else {
      patchedValuesByPathKey.set(target.resultPathKey, result.value)
    }

    if (!firstPatch) {
      firstPatch = result
      firstPatchIndex = target.index
      continue
    }

    additionalPatches ??= []
    additionalPatches.push(result.nextQuery
      ? {
          nextQuery: result.nextQuery,
          index: target.index,
          query: result.query,
          value: result.value,
        }
      : {
          index: target.index,
          query: result.query,
          value: result.value,
        })
  }

  if (!firstPatch) {
    return handledUnchangedPatch
  }

  await deliverPatchedQueryEntry(
    entry,
    firstPatch,
    firstPatchIndex,
    additionalPatches ?? EMPTY_PATCHED_QUERY_DELIVERIES,
  )
  return true
}

function canSkipPatchedBelongsToHydrationTarget(
  target: QueryPatchTarget,
  patchedBelongsToHydrationKeys: ReadonlySet<string> | undefined,
): boolean {
  const relation = target.query.relation
  if (!patchedBelongsToHydrationKeys || relation?.kind !== 'belongsToParentKey') {
    return false
  }

  return patchedBelongsToHydrationKeys.has(createBelongsToHydrationKey(target.mutationIndexKey, relation.foreignKey))
}

function recordPatchedBelongsToHydrationKeys(
  target: QueryPatchTarget,
  patchedBelongsToHydrationKeys: Set<string> | undefined,
): Set<string> | undefined {
  const hydrations = target.query.belongsToHydrations
  if (!hydrations || hydrations.length === 0) {
    return patchedBelongsToHydrationKeys
  }

  const keys = patchedBelongsToHydrationKeys ?? new Set<string>()
  for (const hydration of hydrations) {
    keys.add(createBelongsToHydrationKey(target.mutationIndexKey, hydration.foreignKey))
  }

  return keys
}

function createBelongsToHydrationKey(
  mutationIndexKey: string,
  foreignKey: string,
): string {
  return `${mutationIndexKey}:${foreignKey}`
}

async function deliverPatchedQueryEntry(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  firstPatch: PatchedQueryResult,
  firstPatchIndex: number,
  additionalPatches: readonly PatchedQueryDelivery[],
): Promise<void> {
  let data: unknown = entry.current?.data
  const { queries } = entry
  const shouldCreatePatchOperations = entry.patchSubscriberRefs.size > 0
  if (additionalPatches.length === 0) {
    const query = firstPatch.nextQuery ?? firstPatch.query
    const path = query.resultPath ?? EMPTY_RESULT_PATH
    const target = entry.patchTargets[firstPatchIndex]
    const pathKey = readPatchPathKey(query, target)
    const previousValue = shouldCreatePatchOperations
      ? target?.currentValue ?? (path.length === 0 ? data : getValueAtPath(data, path))
      : undefined
    data = path.length === 0
      ? firstPatch.value
      : replaceValueAtPath(data, path, firstPatch.value)
    const nextQuery = createPatchedQueryObservation(query, firstPatch.value, pathKey)
    queries[firstPatchIndex] = nextQuery
    if (target) {
      entry.patchTargets[firstPatchIndex] = updatePatchedQueryPatchTarget(
        target,
        nextQuery,
        firstPatch.value,
        data,
        path,
        pathKey,
      )
    }

    await deliverPatchedQueryData(
      entry,
      data,
      queries,
      shouldCreatePatchOperations
        ? createReplacePatchOperations(path, previousValue, firstPatch.value)
        : EMPTY_PATCH_OPERATIONS,
    )
    return
  }

  const secondPatch = additionalPatches[0]
  if (secondPatch && additionalPatches.length === 1) {
    const firstQuery = firstPatch.nextQuery ?? firstPatch.query
    const firstPath = firstQuery.resultPath ?? EMPTY_RESULT_PATH
    const firstTarget = entry.patchTargets[firstPatchIndex]
    const firstPathKey = readPatchPathKey(firstQuery, firstTarget)
    const firstPreviousValue = shouldCreatePatchOperations
      ? firstTarget?.currentValue ?? (firstPath.length === 0 ? data : getValueAtPath(data, firstPath))
      : undefined
    const firstNextQuery = createPatchedQueryObservation(firstQuery, firstPatch.value, firstPathKey)
    const secondQuery = secondPatch.nextQuery ?? secondPatch.query
    const secondPath = secondQuery.resultPath ?? EMPTY_RESULT_PATH
    const secondTarget = entry.patchTargets[secondPatch.index]
    const secondPathKey = readPatchPathKey(secondQuery, secondTarget)
    const secondPreviousValue = shouldCreatePatchOperations
      ? secondTarget?.currentValue ?? (secondPath.length === 0 ? data : getValueAtPath(data, secondPath))
      : undefined
    const secondNextQuery = createPatchedQueryObservation(secondQuery, secondPatch.value, secondPathKey)
    queries[firstPatchIndex] = firstNextQuery
    queries[secondPatch.index] = secondNextQuery
    data = replaceTwoValuesAtPaths(
      data,
      firstPath,
      firstPatch.value,
      secondPath,
      secondPatch.value,
    )

    if (firstTarget) {
      entry.patchTargets[firstPatchIndex] = updatePatchedQueryPatchTarget(
        firstTarget,
        firstNextQuery,
        firstPatch.value,
        data,
        firstPath,
        firstPathKey,
      )
    }

    if (secondTarget) {
      entry.patchTargets[secondPatch.index] = updatePatchedQueryPatchTarget(
        secondTarget,
        secondNextQuery,
        secondPatch.value,
        data,
        secondPath,
        secondPathKey,
      )
    }

    await deliverPatchedQueryData(
      entry,
      data,
      queries,
      shouldCreatePatchOperations
        ? compactPatchOperations(
            firstPathKey === secondPathKey
              ? createReplacePatchOperations(firstPath, firstPreviousValue, firstPatch.value)
              : [
                  ...createReplacePatchOperations(firstPath, firstPreviousValue, firstPatch.value),
                  ...createReplacePatchOperations(secondPath, secondPreviousValue, secondPatch.value),
                ],
          )
        : EMPTY_PATCH_OPERATIONS,
    )
    return
  }

  let canUseTopLevelReplacement = true
  let topLevelReplacementState: TopLevelReplacementState | undefined
  let firstDelayedTargetIndex = -1
  let delayedTargetIndexes: number[] | undefined
  const patchOperations: RealtimeSubscriptionPatchOperation[] | undefined = shouldCreatePatchOperations ? [] : undefined
  const patchedOperationPathKeys = shouldCreatePatchOperations ? new Set<string>() : undefined
  for (let patchIndex = -1; ; patchIndex += 1) {
    let patch: PatchedQueryResult | PatchedQueryDelivery
    let index: number
    if (patchIndex < 0) {
      patch = firstPatch
      index = firstPatchIndex
    } else {
      const additionalPatch = additionalPatches[patchIndex]
      if (!additionalPatch) {
        break
      }

      patch = additionalPatch
      index = additionalPatch.index
    }

    const query = patch.nextQuery ?? patch.query
    const path = query.resultPath ?? EMPTY_RESULT_PATH
    const target = entry.patchTargets[index]
    const pathKey = readPatchPathKey(query, target)
    const nextQuery = createPatchedQueryObservation(query, patch.value, pathKey)
    if (patchOperations && patchedOperationPathKeys && !patchedOperationPathKeys.has(pathKey)) {
      const previousValue = target?.currentValue ?? (path.length === 0 ? data : getValueAtPath(data, path))
      patchedOperationPathKeys.add(pathKey)
      patchOperations.push(...createReplacePatchOperations(path, previousValue, patch.value))
    }
    if (canUseTopLevelReplacement) {
      if (canReplaceTopLevelPath(path)) {
        topLevelReplacementState ??= {}
        if (!applyTopLevelPathReplacement(data, topLevelReplacementState, path, patch.value)) {
          canUseTopLevelReplacement = false
          topLevelReplacementState = undefined
        }
      } else {
        canUseTopLevelReplacement = false
        topLevelReplacementState = undefined
      }
    }

    queries[index] = nextQuery

    if (!target) {
      continue
    }

    if (pathKey === target.resultPathKey) {
      entry.patchTargets[index] = updatePatchedQueryPatchTarget(
        target,
        nextQuery,
        patch.value,
        data,
        path,
        pathKey,
      )
      continue
    }

    if (firstDelayedTargetIndex < 0) {
      firstDelayedTargetIndex = index
      continue
    }

    delayedTargetIndexes ??= [firstDelayedTargetIndex]
    delayedTargetIndexes.push(index)
  }

  data = canUseTopLevelReplacement && topLevelReplacementState
    ? finishTopLevelPathReplacement(data, topLevelReplacementState).value
    : replacePatchedQueryDataWithPlan(data, firstPatch, additionalPatches)
  updateDelayedTargets(entry, data, firstDelayedTargetIndex, delayedTargetIndexes)

  await deliverPatchedQueryData(
    entry,
    data,
    queries,
    patchOperations ? compactPatchOperations(patchOperations) : EMPTY_PATCH_OPERATIONS,
  )
}

function canSkipCoveredHydratedMutationValueTarget(
  target: QueryPatchTarget,
  mutations: readonly DatabaseMutationEvent[],
  relevantTargets: readonly RelevantMutationTarget[],
): boolean {
  const hydrations = target.query.belongsToHydrations
  if (!hydrations || hydrations.length === 0) {
    return false
  }

  return canSkipCoveredMutationValueTarget(target, mutations, relevantTargets, false)
}

function canSkipCoveredUnpatchableTarget(
  target: QueryPatchTarget,
  mutations: readonly DatabaseMutationEvent[],
  relevantTargets: readonly RelevantMutationTarget[],
): boolean {
  return canSkipCoveredMutationValueTarget(target, mutations, relevantTargets, true)
}

function canSkipCoveredMutationValueTarget(
  target: QueryPatchTarget,
  mutations: readonly DatabaseMutationEvent[],
  relevantTargets: readonly RelevantMutationTarget[],
  includeSelectedColumns: boolean,
): boolean {
  for (const mutation of mutations) {
    const values = mutation.values
    if (!values) {
      return false
    }

    for (const column of readMutationValueKeys(mutation)) {
      if (!hasPatchableColumnTarget(target, column, relevantTargets, includeSelectedColumns)) {
        return false
      }
    }
  }

  return true
}

function hasPatchableColumnTarget(
  target: QueryPatchTarget,
  column: string,
  relevantTargets: readonly RelevantMutationTarget[],
  includeSelectedColumns: boolean,
): boolean {
  for (const relevantTarget of relevantTargets) {
    const candidate = relevantTarget.target
    if (candidate === target || candidate.mutationIndexKey !== target.mutationIndexKey || !isPatchableQueryPatchTarget(candidate)) {
      continue
    }

    if (candidate.query.scalarColumn === column) {
      return true
    }

    if (candidate.query.scalarListColumn === column) {
      return true
    }

    if (includeSelectedColumns && candidateCoversSelectedColumn(candidate, column)) {
      return true
    }

    const relation = candidate.query.relation
    if (relation?.kind === 'belongsToParentKey' && relation.foreignKey === column) {
      return true
    }
  }

  return false
}

function candidateCoversSelectedColumn(
  candidate: QueryPatchTarget,
  column: string,
): boolean {
  if (candidate.query.relation) {
    return false
  }

  if (
    candidate.rowPatchMode !== 'rows'
    && candidate.rowPatchMode !== 'offset-window'
    && candidate.rowPatchMode !== 'record'
    && candidate.rowPatchMode !== 'pagination'
  ) {
    return false
  }

  const selections = candidate.query.selections
  if (!selections || selections.length === 0) {
    return true
  }

  for (const selection of selections) {
    if (selection.column === column) {
      return true
    }
  }

  return false
}

function updateDelayedTargets(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  data: unknown,
  firstDelayedTargetIndex: number,
  delayedTargetIndexes: readonly number[] | undefined,
): void {
  if (delayedTargetIndexes) {
    for (const index of delayedTargetIndexes) {
      updateDelayedPatchedQueryPatchTarget(entry, index, data)
    }
    return
  }

  if (firstDelayedTargetIndex >= 0) {
    updateDelayedPatchedQueryPatchTarget(entry, firstDelayedTargetIndex, data)
  }
}
