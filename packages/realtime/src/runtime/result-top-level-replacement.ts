import type {
  RealtimePatchPathSegment,
} from './result-path'
import {
  copyArrayWithReplacement,
  copyRecordWithReplacement,
} from './result-value-replacement'
import { isRecord } from './value'

export type TopLevelReplacementResult = {
  readonly value: unknown
}

export type TopLevelReplacementState = {
  nextArray?: unknown[]
  nextRecord?: Record<string, unknown>
}

export function applyTopLevelPathReplacement(
  value: unknown,
  state: TopLevelReplacementState,
  path: readonly RealtimePatchPathSegment[],
  replacement: unknown,
): boolean {
  const segment = path[0]
  if (path.length !== 1 || typeof segment === 'undefined') {
    return false
  }

  return applyTopLevelSegmentReplacement(value, state, segment, replacement)
}

export function applyTopLevelSegmentReplacement(
  value: unknown,
  state: TopLevelReplacementState,
  segment: RealtimePatchPathSegment,
  replacement: unknown,
): boolean {
  if (Array.isArray(value)) {
    if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0 || segment >= value.length) {
      return false
    }

    if (value[segment] === replacement) {
      return true
    }

    state.nextArray ??= copyArrayWithReplacement(value, segment, replacement)
    state.nextArray[segment] = replacement
    return true
  }

  if (isRecord(value)) {
    if (typeof segment !== 'string') {
      return false
    }

    if (value[segment] === replacement) {
      return true
    }

    state.nextRecord ??= copyRecordWithReplacement(value, segment, replacement)
    state.nextRecord[segment] = replacement
    return true
  }

  return false
}

export function finishTopLevelPathReplacement(
  value: unknown,
  state: TopLevelReplacementState,
): TopLevelReplacementResult {
  if (state.nextArray) {
    return {
      value: Object.freeze(state.nextArray),
    }
  }

  if (state.nextRecord) {
    return {
      value: Object.freeze(state.nextRecord),
    }
  }

  return { value }
}

export function canReplaceTopLevelPath(path: readonly RealtimePatchPathSegment[]): boolean {
  return path.length === 1 && typeof path[0] !== 'undefined'
}
