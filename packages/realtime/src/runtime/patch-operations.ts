import type {
  RealtimePatchPathSegment,
} from './result-patching'
import type {
  RealtimeSubscriptionPatchOperation,
} from './state'
import { isRecord } from './value'
import {
  canCreateMergePatchOperation,
  createMergePatchOperation,
  createMovePatchOperation,
  createReplacePatchOperation,
  createSplicePatchOperation,
} from './patch-operation-factories'

export {
  canCreateMergePatchOperation,
  createMergePatchOperation,
  createMovePatchOperation,
  createReplacePatchOperation,
  createSplicePatchOperation,
} from './patch-operation-factories'

export {
  compactPatchOperations,
} from './patch-operation-compaction'

export function createReplacePatchOperations(
  path: readonly RealtimePatchPathSegment[],
  previousValue: unknown,
  nextValue: unknown,
): readonly RealtimeSubscriptionPatchOperation[] {
  if (areEquivalentPatchValues(previousValue, nextValue)) {
    return Object.freeze([])
  }

  const recordOperations = createRecordFieldReplacePatchOperations(path, previousValue, nextValue)
  if (recordOperations) {
    return recordOperations
  }

  const arrayMoveOperations = createArrayMovePatchOperations(path, previousValue, nextValue)
  if (arrayMoveOperations) {
    return arrayMoveOperations
  }

  const arrayWindowSlideOperations = createArrayWindowSlidePatchOperations(path, previousValue, nextValue)
  if (arrayWindowSlideOperations) {
    return arrayWindowSlideOperations
  }

  const arrayItemOperations = createArrayItemReplacePatchOperations(path, previousValue, nextValue)
  if (arrayItemOperations) {
    return arrayItemOperations
  }

  const spliceOperation = createArraySplicePatchOperation(path, previousValue, nextValue)
  if (spliceOperation) {
    return Object.freeze([spliceOperation])
  }

  return Object.freeze([createReplacePatchOperation(path, nextValue)])
}

function createArraySplicePatchOperation(
  path: readonly RealtimePatchPathSegment[],
  previousValue: unknown,
  nextValue: unknown,
): RealtimeSubscriptionPatchOperation | undefined {
  if (!Array.isArray(previousValue) || !Array.isArray(nextValue)) {
    return undefined
  }

  let prefixLength = 0
  while (
    prefixLength < previousValue.length
    && prefixLength < nextValue.length
    && previousValue[prefixLength] === nextValue[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < previousValue.length - prefixLength
    && suffixLength < nextValue.length - prefixLength
    && previousValue[previousValue.length - 1 - suffixLength] === nextValue[nextValue.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const deleteCount = previousValue.length - prefixLength - suffixLength
  const values = nextValue.slice(prefixLength, nextValue.length - suffixLength)
  return createSplicePatchOperation(path, prefixLength, deleteCount, values)
}

function createArrayWindowSlidePatchOperations(
  path: readonly RealtimePatchPathSegment[],
  previousValue: unknown,
  nextValue: unknown,
): readonly RealtimeSubscriptionPatchOperation[] | undefined {
  if (!Array.isArray(previousValue) || !Array.isArray(nextValue) || previousValue.length !== nextValue.length) {
    return undefined
  }

  const appendedCount = readWindowAppendedRowCount(previousValue, nextValue)
  if (typeof appendedCount === 'number') {
    return Object.freeze([
      createSplicePatchOperation(path, 0, appendedCount, Object.freeze([])),
      createSplicePatchOperation(path, previousValue.length - appendedCount, 0, nextValue.slice(nextValue.length - appendedCount)),
    ])
  }

  const prependedCount = readWindowPrependedRowCount(previousValue, nextValue)
  if (typeof prependedCount === 'number') {
    return Object.freeze([
      createSplicePatchOperation(path, 0, 0, nextValue.slice(0, prependedCount)),
      createSplicePatchOperation(path, previousValue.length, prependedCount, Object.freeze([])),
    ])
  }

  return undefined
}

function readWindowAppendedRowCount(
  previousValue: readonly unknown[],
  nextValue: readonly unknown[],
): number | undefined {
  for (let count = 1; count < previousValue.length; count += 1) {
    if (arraysMatchByIdentity(previousValue, count, nextValue, 0, previousValue.length - count)) {
      return count
    }
  }

  return undefined
}

function readWindowPrependedRowCount(
  previousValue: readonly unknown[],
  nextValue: readonly unknown[],
): number | undefined {
  for (let count = 1; count < previousValue.length; count += 1) {
    if (arraysMatchByIdentity(previousValue, 0, nextValue, count, previousValue.length - count)) {
      return count
    }
  }

  return undefined
}

function arraysMatchByIdentity(
  previousValue: readonly unknown[],
  previousStart: number,
  nextValue: readonly unknown[],
  nextStart: number,
  count: number,
): boolean {
  for (let index = 0; index < count; index += 1) {
    if (!areEquivalentArrayItems(previousValue[previousStart + index], nextValue[nextStart + index])) {
      return false
    }
  }

  return true
}

function createArrayMovePatchOperations(
  path: readonly RealtimePatchPathSegment[],
  previousValue: unknown,
  nextValue: unknown,
): readonly RealtimeSubscriptionPatchOperation[] | undefined {
  if (!Array.isArray(previousValue) || !Array.isArray(nextValue) || previousValue.length !== nextValue.length) {
    return undefined
  }

  const move = findSingleArrayMove(previousValue, nextValue)
  if (!move) {
    return undefined
  }

  const movedFieldOperations = createRecordFieldReplacePatchOperations(
    [...path, move.to],
    previousValue[move.from],
    nextValue[move.to],
  )
  if (!movedFieldOperations && !areEquivalentArrayItems(previousValue[move.from], nextValue[move.to])) {
    return undefined
  }

  return Object.freeze([
    createMovePatchOperation(path, move.from, move.to),
    ...(movedFieldOperations ?? []),
  ])
}

function findSingleArrayMove(
  previousValue: readonly unknown[],
  nextValue: readonly unknown[],
): { readonly from: number, readonly to: number } | undefined {
  for (let from = 0; from < previousValue.length; from += 1) {
    const candidate = previousValue[from]
    for (let to = 0; to < nextValue.length; to += 1) {
      if (!areSameArrayMoveItem(candidate, nextValue[to]) || from === to) {
        continue
      }

      if (arraysMatchAfterMove(previousValue, nextValue, from, to)) {
        return { from, to }
      }
    }
  }

  return undefined
}

function arraysMatchAfterMove(
  previousValue: readonly unknown[],
  nextValue: readonly unknown[],
  from: number,
  to: number,
): boolean {
  let previousIndex = 0
  let nextIndex = 0
  while (previousIndex < previousValue.length && nextIndex < nextValue.length) {
    if (previousIndex === from) {
      previousIndex += 1
      continue
    }

    if (nextIndex === to) {
      nextIndex += 1
      continue
    }

    if (!areEquivalentArrayItems(previousValue[previousIndex], nextValue[nextIndex])) {
      return false
    }

    previousIndex += 1
    nextIndex += 1
  }

  return true
}

function areSameArrayMoveItem(previousValue: unknown, nextValue: unknown): boolean {
  if (areEquivalentPatchValues(previousValue, nextValue)) {
    return true
  }

  return hasSameDefinedRecordIdentity(previousValue, nextValue)
}

function createArrayItemReplacePatchOperations(
  path: readonly RealtimePatchPathSegment[],
  previousValue: unknown,
  nextValue: unknown,
): readonly RealtimeSubscriptionPatchOperation[] | undefined {
  if (!Array.isArray(previousValue) || !Array.isArray(nextValue) || previousValue.length !== nextValue.length) {
    return undefined
  }

  const operations: RealtimeSubscriptionPatchOperation[] = []
  for (let index = 0; index < previousValue.length; index += 1) {
    const previousItem = previousValue[index]
    const nextItem = nextValue[index]
    if (previousItem === nextItem) {
      continue
    }

    if (areEquivalentArrayItems(previousItem, nextItem)) {
      continue
    }

    const itemOperations = createRecordFieldReplacePatchOperations([...path, index], previousItem, nextItem)
    if (itemOperations && hasSameRecordIdentity(previousItem, nextItem)) {
      operations.push(...itemOperations)
    } else {
      operations.push(createReplacePatchOperation([...path, index], nextItem))
    }
  }

  return Object.freeze(operations)
}

function areEquivalentArrayItems(previousValue: unknown, nextValue: unknown): boolean {
  return areEquivalentPatchValues(previousValue, nextValue)
}

function hasSamePatchableRecordKeys(
  previousValue: Readonly<Record<string, unknown>>,
  nextValue: Readonly<Record<string, unknown>>,
): boolean {
  const previousKeys = Object.keys(previousValue)
  const nextKeys = Object.keys(nextValue)
  if (previousKeys.length !== nextKeys.length) {
    return false
  }

  for (const key of previousKeys) {
    if (!Object.prototype.propertyIsEnumerable.call(nextValue, key)) {
      return false
    }
  }

  return true
}

function hasSameRecordIdentity(
  previousValue: Readonly<Record<string, unknown>>,
  nextValue: Readonly<Record<string, unknown>>,
): boolean {
  if (!Object.prototype.propertyIsEnumerable.call(previousValue, 'id') || !Object.prototype.propertyIsEnumerable.call(nextValue, 'id')) {
    return true
  }

  return previousValue.id === nextValue.id
}

function hasSameDefinedRecordIdentity(previousValue: unknown, nextValue: unknown): boolean {
  if (!isRecord(previousValue) || !isRecord(nextValue)) {
    return false
  }

  if (!Object.prototype.propertyIsEnumerable.call(previousValue, 'id') || !Object.prototype.propertyIsEnumerable.call(nextValue, 'id')) {
    return false
  }

  return previousValue.id === nextValue.id
}

function areEquivalentRecordValues(previousValue: unknown, nextValue: unknown): boolean {
  if (!isRecord(previousValue) || !isRecord(nextValue) || !hasSamePatchableRecordKeys(previousValue, nextValue)) {
    return false
  }

  for (const key of Object.keys(previousValue)) {
    if (!areEquivalentPatchValues(previousValue[key], nextValue[key])) {
      return false
    }
  }

  return true
}

function areEquivalentArrayValues(previousValue: unknown, nextValue: unknown): boolean {
  if (!Array.isArray(previousValue) || !Array.isArray(nextValue) || previousValue.length !== nextValue.length) {
    return false
  }

  for (let index = 0; index < previousValue.length; index += 1) {
    if (!areEquivalentPatchValues(previousValue[index], nextValue[index])) {
      return false
    }
  }

  return true
}

function areEquivalentPatchValues(previousValue: unknown, nextValue: unknown): boolean {
  return previousValue === nextValue
    || areEquivalentRecordValues(previousValue, nextValue)
    || areEquivalentArrayValues(previousValue, nextValue)
}

function createRecordFieldReplacePatchOperations(
  path: readonly RealtimePatchPathSegment[],
  previousValue: unknown,
  nextValue: unknown,
): readonly RealtimeSubscriptionPatchOperation[] | undefined {
  if (!isRecord(previousValue) || !isRecord(nextValue) || !hasSamePatchableRecordKeys(previousValue, nextValue)) {
    return undefined
  }

  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(previousValue)) {
    if (areEquivalentPatchValues(previousValue[key], nextValue[key])) {
      continue
    }

    fields[key] = nextValue[key]
  }

  const changedKeys = Object.keys(fields)
  if (changedKeys.length === 1) {
    return Object.freeze([createReplacePatchOperation([...path, changedKeys[0]!], fields[changedKeys[0]!])])
  }

  if (!canCreateMergePatchOperation(fields)) {
    return Object.freeze(changedKeys.map(key => createReplacePatchOperation([...path, key], fields[key])))
  }

  return Object.freeze([createMergePatchOperation(path, fields)])
}
