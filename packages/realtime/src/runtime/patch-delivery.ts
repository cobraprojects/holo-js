import { queryCacheInternals } from '@holo-js/db'
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
import { updateQueryPatchTargetCurrentValue } from './query-patch-targets'
import {
  readMutationValueKeys,
  readPrimaryKey,
} from './predicate-matching'
import { collectRelevantMutationTargets } from './query-relevant-mutations'
import { UnreadableBackfillError } from './query-backfill'
import { UNPATCHED_RESULT } from './query-patch-results'
import type {
  DatabaseQueryObservation,
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

async function tryPatchUnlessUnreadable(
  ...args: Parameters<typeof tryPatchObservedQuery>
): ReturnType<typeof tryPatchObservedQuery> {
  try {
    return await tryPatchObservedQuery(...args)
  } catch (error) {
    if (error instanceof UnreadableBackfillError) return UNPATCHED_RESULT
    throw error
  }
}

function isPatchableAfterRead(mutation: DatabaseMutationEvent, readBoundary: number | undefined): boolean {
  if (mutation.unordered) return false
  return readBoundary === undefined || mutation.publicationStartedAt === undefined || mutation.publicationStartedAt >= readBoundary
}

export async function tryPatchQueryEntry(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  backfills: BackfillCache,
): Promise<boolean> {
  if (getRuntimeState().refreshes.get(entry.refreshKey)?.running) {
    return false
  }

  if (!entry.current || entry.refreshFailed) {
    return false
  }

  let firstPatch: PatchedQueryResult | undefined
  let firstPatchIndex = -1
  let additionalPatches: PatchedQueryDelivery[] | undefined
  let patchedValuesByPathKey: Map<string, unknown> | undefined
  let patchedBelongsToHydrationKeys: Set<string> | undefined
  let handledUnchangedPatch = false
  const version = entry.version
  const schemaGeneration = queryCacheInternals.currentSchemaGeneration()
  let readBoundary = entry.readBoundary
  let observationVersion = entry.observationVersion ?? 0
  const markBackfilledRead = () => {
    if ((getRuntimeState().backfillConnectionLookups ?? 0) === (backfills.backfillConnectionLookupsAtStart ?? 0)) return
    readBoundary = queryCacheInternals.markMutationPublicationBoundary()
    entry.readBoundary = readBoundary
  }
  const data = entry.current.data
  const relevantTargets = collectRelevantMutationTargets(entry.patchTargets, backfills)
  if (relevantTargets.length === 0) {
    return entry.patchTargets.length > 0
      && entry.patchTargets.every(target => backfills.mutations.has(target.mutationIndexKey))
  }
  if (relevantTargets.some(({ mutations }) => mutations.some(mutation => !isPatchableAfterRead(mutation, readBoundary)))) {
    return false
  }

  if (hasNestedTargetsOnSameTable(relevantTargets)) {
    return false
  }
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

    const result = await tryPatchUnlessUnreadable(target, mutations, backfills)
    if (queryCacheInternals.hasPendingSchemaChanges() || schemaGeneration !== queryCacheInternals.currentSchemaGeneration() || entry.version !== version || entry.readBoundary !== readBoundary || (entry.observationVersion ?? 0) !== observationVersion) {
      return false
    }

    if (!result.patched) {
      return false
    }

    if ('unchanged' in result) {
      handledUnchangedPatch = true
      if (result.nextQuery) {
        markBackfilledRead()
        observationVersion += 1
        entry.observationVersion = observationVersion
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

  if (firstPatch || handledUnchangedPatch) {
    markBackfilledRead()
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

function hasNestedTargetsOnSameTable(
  relevantTargets: readonly RelevantMutationTarget[],
): boolean {
  if (relevantTargets.length < 2) {
    return false
  }

  const paths = new Set<string>()
  for (const { target } of relevantTargets) {
    let identity = JSON.stringify(target.mutationIndexKey)
    for (const segment of target.resultPath) {
      identity += `,${JSON.stringify(segment)}`
    }
    paths.add(identity)
  }

  for (const { target } of relevantTargets) {
    if (target.query.relation?.kind === 'belongsToParentKey') {
      continue
    }

    let identity = JSON.stringify(target.mutationIndexKey)
    for (const segment of target.resultPath) {
      if (paths.has(identity)) {
        return true
      }

      identity += `,${JSON.stringify(segment)}`
    }
  }

  return false
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
  const shouldCreatePatchOperations = Boolean(entry.options.onPatch)
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
    rebindSiblingObservations(entry, data, key => key === pathKey)
    syncAncestorTargets(entry, data, [path])
    await deliverPatchedQueryData(
      entry,
      data,
      queries,
      shouldCreatePatchOperations
        ? createReplacePatchOperations(path, previousValue, firstPatch.value, readPrimaryKey(query))
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
    rebindSiblingObservations(entry, data, key => key === firstPathKey || key === secondPathKey)
    syncAncestorTargets(entry, data, [firstPath, secondPath])
    await deliverPatchedQueryData(
      entry,
      data,
      queries,
      shouldCreatePatchOperations
        ? compactPatchOperations(
            firstPathKey === secondPathKey
              ? createReplacePatchOperations(firstPath, firstPreviousValue, firstPatch.value, readPrimaryKey(firstQuery))
              : [
                  ...createReplacePatchOperations(firstPath, firstPreviousValue, firstPatch.value, readPrimaryKey(firstQuery)),
                  ...createReplacePatchOperations(secondPath, secondPreviousValue, secondPatch.value, readPrimaryKey(secondQuery)),
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
  const patchedPathKeys = new Set<string>()
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
    patchedPathKeys.add(pathKey)
    if (patchOperations && patchedOperationPathKeys && !patchedOperationPathKeys.has(pathKey)) {
      const previousValue = target?.currentValue ?? (path.length === 0 ? data : getValueAtPath(data, path))
      patchedOperationPathKeys.add(pathKey)
      patchOperations.push(...createReplacePatchOperations(path, previousValue, patch.value, readPrimaryKey(query)))
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
  rebindSiblingObservations(entry, data, key => patchedPathKeys.has(key))
  syncAncestorTargets(
    entry,
    data,
    [firstPatch, ...additionalPatches].map(patch => (patch.nextQuery ?? patch.query).resultPath ?? EMPTY_RESULT_PATH),
  )

  await deliverPatchedQueryData(
    entry,
    data,
    queries,
    patchOperations ? compactPatchOperations(patchOperations) : EMPTY_PATCH_OPERATIONS,
  )
}

function rebindSiblingObservations(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  data: unknown,
  isPatchedPathKey: (pathKey: string) => boolean,
): void {
  const { queries } = entry
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index]
    if (query?.resultBound !== true) {
      continue
    }

    const target = entry.patchTargets[index]
    const pathKey = readPatchPathKey(query, target)
    if (!isPatchedPathKey(pathKey)) {
      continue
    }

    const path = query.resultPath ?? EMPTY_RESULT_PATH
    const value = path.length === 0 ? data : getValueAtPath(data, path)
    if (Object.is(query.result, value)) {
      continue
    }

    const nextQuery = createPatchedQueryObservation(query, value, pathKey)
    queries[index] = nextQuery
    if (target) {
      entry.patchTargets[index] = updatePatchedQueryPatchTarget(target, nextQuery, value, data, path, pathKey)
    }
  }
}

function canSkipCoveredHydratedMutationValueTarget(
  target: QueryPatchTarget,
  mutations: readonly DatabaseMutationEvent[],
  relevantTargets: readonly RelevantMutationTarget[],
): boolean {
  const hydrations = target.query.belongsToHydrations
  if (!hydrations || hydrations.length === 0 || target.query.resultBound === false) {
    return false
  }

  return canSkipCoveredMutationValueTarget(target, mutations, relevantTargets, false)
}

function canSkipCoveredUnpatchableTarget(
  target: QueryPatchTarget,
  mutations: readonly DatabaseMutationEvent[],
  relevantTargets: readonly RelevantMutationTarget[],
): boolean {
  if (target.query.serialized || target.query.resultBound === false) {
    return false
  }

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

    if (includeSelectedColumns && (candidate.query.resultBound === false || !coversResultPath(target.query.resultPath, candidate.query.resultPath))) {
      continue
    }

    if (includeSelectedColumns && target.query.relation?.kind === 'belongsToParentKey' && !isSameParentKeyRelation(target.query, candidate.query)) {
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

function isSameParentKeyRelation(
  target: DatabaseQueryObservation,
  candidate: DatabaseQueryObservation,
): boolean {
  return candidate.relation?.kind === 'belongsToParentKey'
    && target.relation?.kind === 'belongsToParentKey'
    && candidate.relation.relationKey === target.relation.relationKey
}

function coversResultPath(
  targetPath: readonly unknown[] | undefined,
  candidatePath: readonly unknown[] | undefined,
): boolean {
  const base = targetPath ?? EMPTY_RESULT_PATH
  const path = candidatePath ?? EMPTY_RESULT_PATH
  const isRowOfTarget = path.length === base.length + 1 && typeof path.at(-1) === 'number'
  if (path.length !== base.length && !isRowOfTarget) {
    return false
  }

  return base.every((segment, index) => path[index] === segment)
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

function isStrictAncestorPath(ancestor: readonly unknown[], path: readonly unknown[]): boolean {
  return ancestor.length < path.length && ancestor.every((segment, index) => path[index] === segment)
}

function syncAncestorTargets(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  data: unknown,
  patchedPaths: readonly (readonly unknown[])[],
): void {
  for (let index = 0; index < entry.patchTargets.length; index += 1) {
    const query = entry.queries[index]
    const target = entry.patchTargets[index]
    if (!query || !target) continue
    const path = query.resultPath ?? EMPTY_RESULT_PATH
    if (!patchedPaths.some(patchedPath => isStrictAncestorPath(path, patchedPath))) continue
    if (query.resultBound !== true) {
      entry.patchTargets[index] = updateQueryPatchTargetCurrentValue(target, query, data)
      continue
    }
    const pathKey = readPatchPathKey(query, target)
    const value = path.length === 0 ? data : getValueAtPath(data, path)
    const nextQuery = createPatchedQueryObservation(query, value, pathKey)
    entry.queries[index] = nextQuery
    entry.patchTargets[index] = updatePatchedQueryPatchTarget(target, nextQuery, value, data, path, pathKey)
  }
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
