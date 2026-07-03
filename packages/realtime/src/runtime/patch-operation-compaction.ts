import type {
  RealtimePatchPathSegment,
} from './result-patching'
import type {
  RealtimeSubscriptionPatchOperation,
  RealtimeSubscriptionSplicePatchOperation,
} from './state'
import {
  canCreateMergePatchOperation,
  createMergePatchOperation,
  createSplicePatchOperation,
} from './patch-operation-factories'

export function compactPatchOperations(
  operations: readonly RealtimeSubscriptionPatchOperation[],
): readonly RealtimeSubscriptionPatchOperation[] {
  if (operations.length < 2) {
    return operations
  }

  const compactedOperations: RealtimeSubscriptionPatchOperation[] = []
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]
    if (!operation) {
      continue
    }

    if (operation.op === 'splice') {
      if (isNoopSplicePatchOperation(operation)) {
        continue
      }

      const compactedSplice = compactSplicePatchOperationRun(operations, index, operation)
      compactedOperations.push(compactedSplice.operation)
      index = compactedSplice.index
      continue
    }

    const mergeCandidate = readMergePatchOperationCandidate(operation)
    if (!mergeCandidate) {
      compactedOperations.push(operation)
      continue
    }

    if (Object.keys(mergeCandidate.fields).length === 0) {
      continue
    }

    const fields = new Map<string, unknown>(Object.entries(mergeCandidate.fields))
    let nextIndex = index + 1
    while (nextIndex < operations.length) {
      const nextOperation = operations[nextIndex]
      if (!nextOperation) {
        nextIndex += 1
        continue
      }

      const nextMergeCandidate = readMergePatchOperationCandidate(nextOperation)
      if (!nextMergeCandidate || !patchPathsEqual(mergeCandidate.path, nextMergeCandidate.path)) {
        break
      }

      for (const [field, value] of Object.entries(nextMergeCandidate.fields)) {
        fields.set(field, value)
      }
      nextIndex += 1
    }

    if (nextIndex === index + 1) {
      compactedOperations.push(operation)
      continue
    }

    compactedOperations.push(createMergePatchOperation(mergeCandidate.path, Object.fromEntries(fields)))
    index = nextIndex - 1
  }

  return Object.freeze(compactedOperations)
}

function readMergePatchOperationCandidate(
  operation: RealtimeSubscriptionPatchOperation,
): { readonly fields: Readonly<Record<string, unknown>>, readonly path: readonly RealtimePatchPathSegment[] } | undefined {
  if (operation.op === 'merge') {
    if (!canCreateMergePatchOperation(operation.fields)) {
      return undefined
    }

    return {
      fields: operation.fields,
      path: operation.path,
    }
  }

  if (operation.op !== 'replace' || !hasReplacePatchOperationValue(operation)) {
    return undefined
  }

  const field = operation.path.at(-1)
  if (typeof field !== 'string') {
    return undefined
  }

  return {
    fields: { [field]: operation.value },
    path: operation.path.slice(0, -1),
  }
}

function compactSplicePatchOperationRun(
  operations: readonly RealtimeSubscriptionPatchOperation[],
  index: number,
  operation: RealtimeSubscriptionSplicePatchOperation,
): { readonly operation: RealtimeSubscriptionSplicePatchOperation, readonly index: number } {
  let compactedOperation = operation
  let nextIndex = index + 1
  while (nextIndex < operations.length) {
    const nextOperation = operations[nextIndex]
    if (!nextOperation || nextOperation.op !== 'splice' || !patchPathsEqual(compactedOperation.path, nextOperation.path)) {
      break
    }

    if (isNoopSplicePatchOperation(nextOperation)) {
      nextIndex += 1
      continue
    }

    const composedOperation = composeSplicePatchOperations(compactedOperation, nextOperation)
    if (!composedOperation) {
      break
    }

    compactedOperation = composedOperation
    nextIndex += 1
  }

  return {
    operation: compactedOperation,
    index: nextIndex - 1,
  }
}

function composeSplicePatchOperations(
  firstOperation: RealtimeSubscriptionSplicePatchOperation,
  secondOperation: RealtimeSubscriptionSplicePatchOperation,
): RealtimeSubscriptionSplicePatchOperation | undefined {
  if (secondOperation.index === firstOperation.index) {
    const deletedInsertedValues = Math.min(secondOperation.deleteCount, firstOperation.values.length)
    return createSplicePatchOperation(
      firstOperation.path,
      firstOperation.index,
      firstOperation.deleteCount + Math.max(0, secondOperation.deleteCount - firstOperation.values.length),
      [
        ...secondOperation.values,
        ...firstOperation.values.slice(deletedInsertedValues),
      ],
    )
  }

  if (secondOperation.index === firstOperation.index + firstOperation.values.length) {
    return createSplicePatchOperation(
      firstOperation.path,
      firstOperation.index,
      firstOperation.deleteCount + secondOperation.deleteCount,
      [
        ...firstOperation.values,
        ...secondOperation.values,
      ],
    )
  }

  return undefined
}

function isNoopSplicePatchOperation(
  operation: RealtimeSubscriptionSplicePatchOperation,
): boolean {
  return operation.deleteCount === 0 && operation.values.length === 0
}

function hasReplacePatchOperationValue(
  operation: RealtimeSubscriptionPatchOperation,
): operation is RealtimeSubscriptionPatchOperation & { readonly value: unknown } {
  return Object.prototype.hasOwnProperty.call(operation, 'value')
}

function patchPathsEqual(
  leftPath: readonly RealtimePatchPathSegment[],
  rightPath: readonly RealtimePatchPathSegment[],
): boolean {
  if (leftPath.length !== rightPath.length) {
    return false
  }

  for (let index = 0; index < leftPath.length; index += 1) {
    if (leftPath[index] !== rightPath[index]) {
      return false
    }
  }

  return true
}
