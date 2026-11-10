import {
  getValueAtPath,
  type RealtimePatchPathSegment,
} from './result-path'
import {
  addPathReplacementToPlan,
  createEmptyPathReplacementPlan,
  replaceValueWithPlan,
} from './result-replacement-plan'
import {
  replaceValueAtPath,
} from './result-value-replacement'

export type PathSpliceReplacement = {
  readonly index: number
  readonly deleteCount: number
  readonly values: readonly unknown[]
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
