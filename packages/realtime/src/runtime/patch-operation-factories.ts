import {
  copyPatchPath,
  type RealtimePatchPathSegment,
} from './result-patching'
import type {
  RealtimeSubscriptionPatchOperation,
  RealtimeSubscriptionSplicePatchOperation,
} from './state'

export function createReplacePatchOperation(
  path: readonly RealtimePatchPathSegment[],
  value: unknown,
): RealtimeSubscriptionPatchOperation {
  if (typeof value === 'undefined') {
    return Object.freeze({
      op: 'replace',
      path: copyPatchPath(path),
      valueKind: 'undefined',
    })
  }

  return Object.freeze({
    op: 'replace',
    path: copyPatchPath(path),
    value,
  })
}

export function createMergePatchOperation(
  path: readonly RealtimePatchPathSegment[],
  fields: Readonly<Record<string, unknown>>,
): RealtimeSubscriptionPatchOperation {
  return Object.freeze({
    op: 'merge',
    path: copyPatchPath(path),
    fields: Object.freeze(Object.fromEntries(Object.entries(fields))),
  })
}

export function createSplicePatchOperation(
  path: readonly RealtimePatchPathSegment[],
  index: number,
  deleteCount: number,
  values: readonly unknown[],
): RealtimeSubscriptionSplicePatchOperation {
  return Object.freeze({
    op: 'splice',
    path: copyPatchPath(path),
    index,
    deleteCount,
    values: Object.freeze([...values]),
  })
}

export function createMovePatchOperation(
  path: readonly RealtimePatchPathSegment[],
  from: number,
  to: number,
): RealtimeSubscriptionPatchOperation {
  return Object.freeze({
    op: 'move',
    path: copyPatchPath(path),
    from,
    to,
  })
}

export function canCreateMergePatchOperation(fields: Readonly<Record<string, unknown>>): boolean {
  for (const value of Object.values(fields)) {
    if (typeof value === 'undefined') {
      return false
    }
  }

  return true
}
