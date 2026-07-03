import {
  getValueAtPath,
  type RealtimePatchPathSegment,
} from './result-path'
import {
  addPathReplacementToPlan,
  createEmptyPathReplacementPlan,
  createTwoPathReplacementPlan,
  replaceValueWithPlan,
} from './result-replacement-plan'
import {
  applyTopLevelPathReplacement,
  canReplaceTopLevelPath,
  finishTopLevelPathReplacement,
  type TopLevelReplacementResult,
  type TopLevelReplacementState,
} from './result-top-level-replacement'
import {
  replaceValueAtPath,
} from './result-value-replacement'

export type PathValueReplacement = {
  readonly path: readonly RealtimePatchPathSegment[]
  readonly value: unknown
}

export type PathSpliceReplacement = {
  readonly index: number
  readonly deleteCount: number
  readonly values: readonly unknown[]
}

export function replaceTwoValuesAtPaths(
  value: unknown,
  firstPath: readonly RealtimePatchPathSegment[],
  firstValue: unknown,
  secondPath: readonly RealtimePatchPathSegment[],
  secondValue: unknown,
): unknown {
  const topLevelReplacement = replaceTwoValuesAtTopLevelPaths(
    value,
    firstPath,
    firstValue,
    secondPath,
    secondValue,
  )
  if (topLevelReplacement) {
    return topLevelReplacement.value
  }

  const plan = createTwoPathReplacementPlan(firstPath, firstValue, secondPath, secondValue)
  if (!plan) {
    const nextValue = firstPath.length === 0
      ? firstValue
      : replaceValueAtPath(value, firstPath, firstValue)
    return secondPath.length === 0
      ? secondValue
      : replaceValueAtPath(nextValue, secondPath, secondValue)
  }

  return replaceValueWithPlan(value, plan)
}

export function replaceValuesAtPaths(
  value: unknown,
  replacements: readonly PathValueReplacement[],
): unknown {
  return replaceValuesAtPathsUsing(value, replacements, replacement => replacement.value)
}

export function replaceValuesAtPathsUsing<TReplacement extends {
  readonly path: readonly RealtimePatchPathSegment[]
}>(
  value: unknown,
  replacements: readonly TReplacement[],
  readReplacementValue: (replacement: TReplacement) => unknown,
): unknown {
  const firstReplacement = replacements[0]
  if (!firstReplacement) {
    return value
  }

  if (replacements.length === 1) {
    const replacementValue = readReplacementValue(firstReplacement)
    return firstReplacement.path.length === 0
      ? replacementValue
      : replaceValueAtPath(value, firstReplacement.path, replacementValue)
  }

  const replacementPlan = createEmptyPathReplacementPlan()
  for (const replacement of replacements) {
    if (!addPathReplacementToPlan(replacementPlan, replacement.path, readReplacementValue(replacement))) {
      return replaceValuesAtPathsSequentially(value, replacements, readReplacementValue)
    }
  }

  return replaceValueWithPlan(value, replacementPlan)
}

export function spliceValueAtPath(
  value: unknown,
  path: readonly RealtimePatchPathSegment[],
  index: number,
  deleteCount: number,
  items: readonly unknown[],
): unknown {
  return spliceValuesAtPath(value, path, [{
    index,
    deleteCount,
    values: items,
  }])
}

export function spliceValuesAtPath(
  value: unknown,
  path: readonly RealtimePatchPathSegment[],
  splices: readonly PathSpliceReplacement[],
): unknown {
  const target = path.length === 0 ? value : getValueAtPath(value, path)
  if (!Array.isArray(target)) {
    return value
  }

  let nextTarget: unknown[] | undefined
  for (const splice of splices) {
    const currentTarget = nextTarget ?? target
    if (
      !Number.isInteger(splice.index)
      || !Number.isInteger(splice.deleteCount)
      || splice.index < 0
      || splice.deleteCount < 0
      || splice.index > currentTarget.length
    ) {
      continue
    }

    const boundedDeleteCount = Math.min(splice.deleteCount, currentTarget.length - splice.index)
    if (isEquivalentSplice(currentTarget, splice.index, boundedDeleteCount, splice.values)) {
      continue
    }

    nextTarget ??= [...target]
    nextTarget.splice(splice.index, boundedDeleteCount, ...splice.values)
  }

  if (!nextTarget) {
    return value
  }

  const frozenTarget = Object.freeze(nextTarget)
  return path.length === 0
    ? frozenTarget
    : replaceValueAtPath(value, path, frozenTarget)
}

function replaceValuesAtPathsSequentially<TReplacement extends {
  readonly path: readonly RealtimePatchPathSegment[]
}>(
  value: unknown,
  replacements: readonly TReplacement[],
  readReplacementValue: (replacement: TReplacement) => unknown,
): unknown {
  let nextValue = value
  for (const replacement of replacements) {
    const replacementValue = readReplacementValue(replacement)
    nextValue = replacement.path.length === 0
      ? replacementValue
      : replaceValueAtPath(nextValue, replacement.path, replacementValue)
  }

  return nextValue
}

function replaceTwoValuesAtTopLevelPaths(
  value: unknown,
  firstPath: readonly RealtimePatchPathSegment[],
  firstValue: unknown,
  secondPath: readonly RealtimePatchPathSegment[],
  secondValue: unknown,
): TopLevelReplacementResult | undefined {
  if (!canReplaceTopLevelPath(firstPath) || !canReplaceTopLevelPath(secondPath)) {
    return undefined
  }

  const state: TopLevelReplacementState = {}
  if (!applyTopLevelPathReplacement(value, state, firstPath, firstValue)) {
    return undefined
  }

  if (!applyTopLevelPathReplacement(value, state, secondPath, secondValue)) {
    return undefined
  }

  return finishTopLevelPathReplacement(value, state)
}

function isEquivalentSplice(
  target: readonly unknown[],
  index: number,
  deleteCount: number,
  items: readonly unknown[],
): boolean {
  if (deleteCount !== items.length) {
    return false
  }

  if (deleteCount === 0) {
    return true
  }

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    if (target[index + itemIndex] !== items[itemIndex]) {
      return false
    }
  }

  return true
}
