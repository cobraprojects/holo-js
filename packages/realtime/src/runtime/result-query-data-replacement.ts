import {
  EMPTY_RESULT_PATH,
  getValueAtPath,
  type RealtimePatchPathSegment,
} from './result-path'
import {
  addPathReplacementToPlan,
  createEmptyPathReplacementPlan,
  replaceValueWithPlan,
} from './result-replacement-plan'
import {
  applyTopLevelSegmentReplacement,
  finishTopLevelPathReplacement,
  type TopLevelReplacementState,
} from './result-top-level-replacement'
import {
  replaceValueAtPath,
} from './result-value-replacement'

export type PatchedQueryDataReplacementQuery = {
  readonly resultPath?: readonly RealtimePatchPathSegment[]
}

export type PatchedQueryDataReplacement = {
  readonly nextQuery?: PatchedQueryDataReplacementQuery
  readonly query: PatchedQueryDataReplacementQuery
  readonly value: unknown
}

export function replacePatchedQueryDataWithPlan(
  value: unknown,
  firstPatch: PatchedQueryDataReplacement,
  additionalPatches: readonly PatchedQueryDataReplacement[],
): unknown {
  const sharedParentReplacement = replacePatchedQueryDataAtSharedParentPath(
    value,
    firstPatch,
    additionalPatches,
  )
  if (sharedParentReplacement.replaced) {
    return sharedParentReplacement.value
  }

  const replacementPlan = createEmptyPathReplacementPlan()
  if (!addPathReplacementToPlan(replacementPlan, getPatchedQueryDeliveryPath(firstPatch), firstPatch.value)) {
    return replacePatchedQueryDataSequentially(value, firstPatch, additionalPatches)
  }

  for (const patch of additionalPatches) {
    if (!addPathReplacementToPlan(replacementPlan, getPatchedQueryDeliveryPath(patch), patch.value)) {
      return replacePatchedQueryDataSequentially(value, firstPatch, additionalPatches)
    }
  }

  return replaceValueWithPlan(value, replacementPlan)
}

function replacePatchedQueryDataSequentially(
  value: unknown,
  firstPatch: PatchedQueryDataReplacement,
  additionalPatches: readonly PatchedQueryDataReplacement[],
): unknown {
  let nextValue = value
  const firstPath = getPatchedQueryDeliveryPath(firstPatch)
  nextValue = firstPath.length === 0
    ? firstPatch.value
    : replaceValueAtPath(nextValue, firstPath, firstPatch.value)

  for (const patch of additionalPatches) {
    const path = getPatchedQueryDeliveryPath(patch)
    nextValue = path.length === 0
      ? patch.value
      : replaceValueAtPath(nextValue, path, patch.value)
  }

  return nextValue
}

function getPatchedQueryDeliveryPath(
  patch: PatchedQueryDataReplacement,
): readonly RealtimePatchPathSegment[] {
  const query = patch.nextQuery ?? patch.query
  return query.resultPath ?? EMPTY_RESULT_PATH
}

function replacePatchedQueryDataAtSharedParentPath(
  value: unknown,
  firstPatch: PatchedQueryDataReplacement,
  additionalPatches: readonly PatchedQueryDataReplacement[],
): { readonly replaced: true, readonly value: unknown } | { readonly replaced: false } {
  const firstPath = getPatchedQueryDeliveryPath(firstPatch)
  if (firstPath.length < 2) {
    return { replaced: false }
  }

  const parentPath = firstPath.slice(0, -1)
  const firstParent = getValueAtPath(value, parentPath)
  const firstSegment = firstPath[firstPath.length - 1]
  if (typeof firstSegment === 'undefined') {
    return { replaced: false }
  }

  const replacementState: TopLevelReplacementState = {}
  if (!applyTopLevelSegmentReplacement(firstParent, replacementState, firstSegment, firstPatch.value)) {
    return { replaced: false }
  }

  for (const patch of additionalPatches) {
    const path = getPatchedQueryDeliveryPath(patch)
    if (path.length !== firstPath.length || !isSamePatchParentPath(path, parentPath)) {
      return { replaced: false }
    }

    const segment = path[path.length - 1]
    if (typeof segment === 'undefined') {
      return { replaced: false }
    }

    if (!applyTopLevelSegmentReplacement(firstParent, replacementState, segment, patch.value)) {
      return { replaced: false }
    }
  }

  const parentReplacement = finishTopLevelPathReplacement(firstParent, replacementState).value
  const nextValue = replaceValueAtPath(value, parentPath, parentReplacement)
  return {
    replaced: true,
    value: nextValue,
  }
}

function isSamePatchParentPath(
  path: readonly RealtimePatchPathSegment[],
  parentPath: readonly RealtimePatchPathSegment[],
): boolean {
  for (let index = 0; index < parentPath.length; index += 1) {
    if (path[index] !== parentPath[index]) {
      return false
    }
  }

  return true
}
