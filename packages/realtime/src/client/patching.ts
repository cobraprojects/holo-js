import type { RealtimeSubscriptionSnapshot } from '../contracts'
import {
  getValueAtPath,
  replaceValueAtPath,
  replaceValuesAtPathsUsing,
  spliceValuesAtPath,
  type RealtimePatchPathSegment,
} from '../runtime/result-patching'
import type {
  RealtimeWireMovePatchOperation,
  RealtimeWirePatchOperation,
  RealtimeWireReplacePatchOperation,
  RealtimeWireSplicePatchOperation,
  RealtimeWireSnapshotPatch,
  RealtimeWireUndefinedReplacePatchOperation,
} from './types'
import { stableStringify } from './utils'

const patchedSnapshots = new WeakSet<object>()
const unsafeWirePatchKeys = new Set(['__proto__', 'constructor', 'prototype'])

export function parseWireSnapshotPatch(value: unknown): RealtimeWireSnapshotPatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const patch = value as Record<string, unknown>
  const operationsValue = patch.operations
  if (!Array.isArray(operationsValue)) {
    return undefined
  }
  const version = patch.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return undefined
  }

  const operations: RealtimeWirePatchOperation[] = []
  for (const operation of operationsValue) {
    const parsedOperation = parseWirePatchOperation(operation)
    if (!parsedOperation) {
      return undefined
    }

    operations.push(parsedOperation)
  }

  const dependencies = Array.isArray(patch.dependencies)
    ? parseWireStringArray(patch.dependencies)
    : undefined
  if (Array.isArray(patch.dependencies) && !dependencies) {
    return undefined
  }

  return {
    ...(dependencies ? { dependencies } : {}),
    operations: Object.freeze(operations),
    version,
  }
}

function parseWireStringArray(value: readonly unknown[]): readonly string[] | undefined {
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      return undefined
    }

    result.push(item)
  }

  return Object.freeze(result)
}

function parseWirePatchOperation(value: unknown): RealtimeWirePatchOperation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const operation = value as Record<string, unknown>
  const path = parseWirePatchPath(operation.path)
  if (!path) {
    return undefined
  }

  if (operation.op === 'replace') {
    if (operation.valueKind === 'undefined') {
      return Object.freeze({
        op: 'replace',
        path,
        value: undefined,
      })
    }

    if (typeof operation.valueKind !== 'undefined') {
      return undefined
    }

    return Object.freeze({
      op: 'replace',
      path,
      value: operation.value,
    })
  }

  if (operation.op === 'merge') {
    const fields = operation.fields
    if (!isMergePatchFields(fields)) {
      return undefined
    }

    return Object.freeze({
      op: 'merge',
      path,
      fields,
    })
  }

  if (operation.op === 'move') {
    const from = operation.from
    const to = operation.to
    if (
      typeof from !== 'number'
      || typeof to !== 'number'
      || !Number.isInteger(from)
      || !Number.isInteger(to)
      || from < 0
      || to < 0
    ) {
      return undefined
    }

    return Object.freeze({
      op: 'move',
      path,
      from,
      to,
    })
  }

  const index = operation.index
  const deleteCount = operation.deleteCount
  const values = operation.values
  if (
    operation.op !== 'splice'
    || typeof index !== 'number'
    || typeof deleteCount !== 'number'
    || !Number.isInteger(index)
    || !Number.isInteger(deleteCount)
    || index < 0
    || deleteCount < 0
    || !Array.isArray(values)
  ) {
    return undefined
  }

  return Object.freeze({
    op: 'splice',
    path,
    index,
    deleteCount,
    values: Object.freeze([...values]),
  })
}

function parseWirePatchPath(value: unknown): readonly RealtimePatchPathSegment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const path: RealtimePatchPathSegment[] = []
  for (const segment of value) {
    if (typeof segment === 'string') {
      if (!isSafeWirePatchKey(segment)) {
        return undefined
      }

      path.push(segment)
      continue
    }

    if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0) {
      return undefined
    }

    path.push(segment)
  }

  return Object.freeze(path)
}

function isMergePatchFields(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }

  return Object.keys(value).every(isSafeWirePatchKey)
}

function isSafeWirePatchKey(key: string): boolean {
  return !unsafeWirePatchKeys.has(key)
}

export function isStaleRealtimeVersion(currentVersion: number | undefined, nextVersion: number | undefined): boolean {
  return typeof currentVersion === 'number'
    && typeof nextVersion === 'number'
    && nextVersion <= currentVersion
}

export function isStaleRealtimeSnapshot<TResult>(
  currentSnapshot: RealtimeSubscriptionSnapshot<TResult> | undefined,
  nextSnapshot: RealtimeSubscriptionSnapshot<TResult>,
): boolean {
  return isStaleRealtimeVersion(currentSnapshot?.version, nextSnapshot.version)
}

export function isStaleRealtimePatch<TResult>(
  currentSnapshot: RealtimeSubscriptionSnapshot<TResult>,
  patch: RealtimeWireSnapshotPatch,
): boolean {
  return isStaleRealtimeVersion(currentSnapshot.version, patch.version)
}

export function shouldNotifyPatchedRealtimeSnapshot<TResult>(
  currentSnapshot: RealtimeSubscriptionSnapshot<TResult>,
  nextSnapshot: RealtimeSubscriptionSnapshot<TResult>,
): boolean {
  return nextSnapshot.data !== currentSnapshot.data
    || nextSnapshot.dependencies !== currentSnapshot.dependencies
    || nextSnapshot.version !== currentSnapshot.version
}

export function applyWireSnapshotPatch<TResult>(
  snapshot: RealtimeSubscriptionSnapshot<TResult>,
  patch: RealtimeWireSnapshotPatch,
): RealtimeSubscriptionSnapshot<TResult> {
  if (isStaleRealtimePatch(snapshot, patch)) {
    return snapshot
  }

  const data = applyWirePatchOperations(snapshot.data, patch.operations)

  const nextSnapshot = {
    ...snapshot,
    ...(patch.dependencies ? { dependencies: patch.dependencies } : {}),
    version: patch.version,
    data: data as TResult,
  }
  patchedSnapshots.add(nextSnapshot)
  return nextSnapshot
}

function applyWirePatchOperations(
  value: unknown,
  operations: readonly RealtimeWirePatchOperation[],
): unknown {
  if (operations.every(isWireReplacePatchOperation)) {
    return replaceValuesAtPathsUsing(value, operations, operation => readSharedWireReplacePatchOperationValue(
      value,
      operation,
    ))
  }

  let nextValue = value
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]
    if (!operation) {
      continue
    }

    if (operation.op === 'replace') {
      const replacementValue = readSharedWireReplacePatchOperationValue(nextValue, operation)
      nextValue = operation.path.length === 0
        ? replacementValue
        : replaceValueAtPath(nextValue, operation.path, replacementValue)
      continue
    }

    if (operation.op === 'merge') {
      nextValue = mergeValueAtPath(nextValue, operation.path, operation.fields)
      continue
    }

    if (operation.op === 'splice') {
      const splices: RealtimeWireSplicePatchOperation[] = [operation]
      for (
        let nextOperationIndex = operationIndex + 1;
        nextOperationIndex < operations.length;
        nextOperationIndex += 1
      ) {
        const nextOperation = operations[nextOperationIndex]
        if (!nextOperation || nextOperation.op !== 'splice' || !areWirePatchPathsEqual(operation.path, nextOperation.path)) {
          break
        }

        splices.push(nextOperation)
        operationIndex = nextOperationIndex
      }

      nextValue = applyWireSpliceOperations(nextValue, operation.path, splices)
      continue
    }

    nextValue = moveValueAtPath(nextValue, operation)
  }

  return nextValue
}

function applyWireSpliceOperations(
  value: unknown,
  path: readonly RealtimePatchPathSegment[],
  splices: readonly RealtimeWireSplicePatchOperation[],
): unknown {
  return spliceValuesAtPath(
    value,
    path,
    shareEquivalentWireSpliceValues(value, path, splices),
  )
}

function shareEquivalentWireSpliceValues(
  value: unknown,
  path: readonly RealtimePatchPathSegment[],
  splices: readonly RealtimeWireSplicePatchOperation[],
): readonly RealtimeWireSplicePatchOperation[] {
  const target = path.length === 0 ? value : getValueAtPath(value, path)
  if (!Array.isArray(target)) {
    return splices
  }

  let nextTarget: unknown[] | undefined
  let sharedSplices: RealtimeWireSplicePatchOperation[] | undefined
  for (const [index, splice] of splices.entries()) {
    const currentTarget = nextTarget ?? target
    if (
      !Number.isInteger(splice.index)
      || !Number.isInteger(splice.deleteCount)
      || splice.index < 0
      || splice.deleteCount < 0
      || splice.index > currentTarget.length
    ) {
      sharedSplices?.push(splice)
      continue
    }

    const boundedDeleteCount = Math.min(splice.deleteCount, currentTarget.length - splice.index)
    const sharedValues = shareEquivalentWireSpliceReplacementValues(
      currentTarget,
      splice.index,
      boundedDeleteCount,
      splice.values,
    )
    if (sharedValues !== splice.values) {
      sharedSplices ??= splices.slice(0, index)
      sharedSplices.push(Object.freeze({
        ...splice,
        values: sharedValues,
      }))
    } else {
      sharedSplices?.push(splice)
    }

    if (isEquivalentWireSplice(currentTarget, splice.index, boundedDeleteCount, sharedValues)) {
      continue
    }

    nextTarget ??= [...target]
    nextTarget.splice(splice.index, boundedDeleteCount, ...sharedValues)
  }

  return sharedSplices ?? splices
}

function shareEquivalentWireSpliceReplacementValues(
  target: readonly unknown[],
  index: number,
  deleteCount: number,
  values: readonly unknown[],
): readonly unknown[] {
  if (values.length === 0 || deleteCount === 0) {
    return values
  }

  let sharedValues: unknown[] | undefined
  for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
    const value = values[valueIndex]
    const sharedValue = valueIndex < deleteCount
      ? shareEquivalentWireValue(target[index + valueIndex], value)
      : value
    if (sharedValue !== value) {
      sharedValues ??= values.slice(0, valueIndex)
      sharedValues.push(sharedValue)
      continue
    }

    sharedValues?.push(value)
  }

  return sharedValues ? Object.freeze(sharedValues) : values
}

function isEquivalentWireSplice(
  target: readonly unknown[],
  index: number,
  deleteCount: number,
  values: readonly unknown[],
): boolean {
  if (deleteCount !== values.length) {
    return false
  }

  if (deleteCount === 0) {
    return true
  }

  for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
    if (target[index + valueIndex] !== values[valueIndex]) {
      return false
    }
  }

  return true
}

function mergeValueAtPath(
  value: unknown,
  path: readonly RealtimePatchPathSegment[],
  fields: Readonly<Record<string, unknown>>,
): unknown {
  const target = path.length === 0 ? value : getValueAtPath(value, path)
  if (!isMergePatchFields(target)) {
    return value
  }

  let changed = false
  const nextFields: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    const nextFieldValue = shareEquivalentWireValue(target[key], fields[key])
    nextFields[key] = nextFieldValue
    if (!Object.prototype.propertyIsEnumerable.call(target, key) || target[key] !== nextFieldValue) {
      changed = true
    }
  }

  if (!changed) {
    return value
  }

  const nextTarget = Object.freeze({
    ...target,
    ...nextFields,
  })

  return path.length === 0
    ? nextTarget
    : replaceValueAtPath(value, path, nextTarget)
}

function moveValueAtPath(
  value: unknown,
  operation: RealtimeWireMovePatchOperation,
): unknown {
  if (operation.from === operation.to) {
    return value
  }

  const target = operation.path.length === 0 ? value : getValueAtPath(value, operation.path)
  if (!Array.isArray(target) || operation.from >= target.length || operation.to >= target.length) {
    return value
  }

  const removed = target[operation.from]
  if (typeof removed === 'undefined') {
    return value
  }

  const withoutRemoved = [
    ...target.slice(0, operation.from),
    ...target.slice(operation.from + 1),
  ]

  const nextTarget = Object.freeze([
    ...withoutRemoved.slice(0, operation.to),
    removed,
    ...withoutRemoved.slice(operation.to),
  ])

  return operation.path.length === 0
    ? nextTarget
    : replaceValueAtPath(value, operation.path, nextTarget)
}

function areWirePatchPathsEqual(
  firstPath: readonly RealtimePatchPathSegment[],
  secondPath: readonly RealtimePatchPathSegment[],
): boolean {
  if (firstPath.length !== secondPath.length) {
    return false
  }

  for (let index = 0; index < firstPath.length; index += 1) {
    if (firstPath[index] !== secondPath[index]) {
      return false
    }
  }

  return true
}

function isWireReplacePatchOperation(
  operation: RealtimeWirePatchOperation,
): operation is RealtimeWireReplacePatchOperation | RealtimeWireUndefinedReplacePatchOperation {
  return operation.op === 'replace'
}

function readWireReplacePatchOperationValue(
  operation: RealtimeWireReplacePatchOperation | RealtimeWireUndefinedReplacePatchOperation,
): unknown {
  return Object.prototype.hasOwnProperty.call(operation, 'value')
    ? (operation as RealtimeWireReplacePatchOperation).value
    : undefined
}

function readSharedWireReplacePatchOperationValue(
  value: unknown,
  operation: RealtimeWireReplacePatchOperation | RealtimeWireUndefinedReplacePatchOperation,
): unknown {
  const replacementValue = readWireReplacePatchOperationValue(operation)
  const currentValue = operation.path.length === 0
    ? value
    : getValueAtPath(value, operation.path)
  return shareEquivalentWireValue(currentValue, replacementValue)
}

function shareEquivalentWireValue(currentValue: unknown, replacementValue: unknown): unknown {
  if (Object.is(currentValue, replacementValue)) {
    return currentValue
  }

  if (
    !currentValue
    || !replacementValue
    || typeof currentValue !== 'object'
    || typeof replacementValue !== 'object'
  ) {
    return replacementValue
  }

  return stableStringify(currentValue) === stableStringify(replacementValue)
    ? currentValue
    : replacementValue
}

export function isPatchedRealtimeSnapshot(snapshot: RealtimeSubscriptionSnapshot<unknown>): boolean {
  return patchedSnapshots.has(snapshot)
}
