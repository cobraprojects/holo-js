import type {
  RealtimePatchPathSegment,
} from './result-path'
import {
  copyArrayWithReplacement,
  copyRecordWithReplacement,
} from './result-value-replacement'
import { isRecord } from './value'

export type PathReplacementPlan = {
  children?: Map<RealtimePatchPathSegment, PathReplacementPlan>
  hasReplacement: boolean
  replacement: unknown
}

export function createTwoPathReplacementPlan(
  firstPath: readonly RealtimePatchPathSegment[],
  firstValue: unknown,
  secondPath: readonly RealtimePatchPathSegment[],
  secondValue: unknown,
): PathReplacementPlan | undefined {
  const root = createEmptyPathReplacementPlan()
  if (!addPathReplacementToPlan(root, firstPath, firstValue)) {
    return undefined
  }

  if (!addPathReplacementToPlan(root, secondPath, secondValue)) {
    return undefined
  }

  return root
}

export function createEmptyPathReplacementPlan(): PathReplacementPlan {
  return {
    hasReplacement: false,
    replacement: undefined,
  }
}

export function addPathReplacementToPlan(
  root: PathReplacementPlan,
  path: readonly RealtimePatchPathSegment[],
  replacement: unknown,
): boolean {
  if (path.length === 0) {
    if (root.children?.size) {
      return false
    }

    root.hasReplacement = true
    root.replacement = replacement
    return true
  }

  if (root.hasReplacement) {
    return false
  }

  let plan = root
  for (let index = 0; index < path.length; index += 1) {
    if (plan.hasReplacement) {
      return false
    }

    const segment = path[index]
    if (typeof segment === 'undefined') {
      return false
    }

    plan.children ??= new Map()
    let childPlan = plan.children.get(segment)
    if (!childPlan) {
      childPlan = createEmptyPathReplacementPlan()
      plan.children.set(segment, childPlan)
    }

    plan = childPlan
  }

  if (plan.children?.size) {
    return false
  }

  plan.hasReplacement = true
  plan.replacement = replacement
  return true
}

export function replaceValueWithPlan(value: unknown, plan: PathReplacementPlan): unknown {
  if (plan.hasReplacement) {
    return plan.replacement
  }

  const children = plan.children
  if (!children?.size) {
    return value
  }

  if (Array.isArray(value)) {
    let nextValue: unknown[] | undefined
    for (const [segment, childPlan] of children) {
      if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0 || segment >= value.length) {
        continue
      }

      const childValue = value[segment]
      const nextChildValue = replaceValueWithPlan(childValue, childPlan)
      if (nextChildValue === childValue) {
        continue
      }

      nextValue ??= copyArrayWithReplacement(value, segment, nextChildValue)
      nextValue[segment] = nextChildValue
    }

    return nextValue ? Object.freeze(nextValue) : value
  }

  if (isRecord(value)) {
    let nextValue: Record<string, unknown> | undefined
    for (const [segment, childPlan] of children) {
      if (typeof segment !== 'string') {
        continue
      }

      const childValue = value[segment]
      const nextChildValue = replaceValueWithPlan(childValue, childPlan)
      if (nextChildValue === childValue) {
        continue
      }

      nextValue ??= copyRecordWithReplacement(value, segment, nextChildValue)
      nextValue[segment] = nextChildValue
    }

    return nextValue ? Object.freeze(nextValue) : value
  }

  return value
}
