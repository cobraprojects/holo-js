import {
  createQueryObservationMetadata,
} from './query-metadata'
import { createQueryRowIdentityIndex } from './query-row-identity'
import {
  EMPTY_RESULT_PATH,
  EMPTY_RESULT_PATH_KEY,
  copyPatchPath,
  createResultPathKey,
  getValueAtPath,
  type RealtimePatchPathSegment,
} from './result-patching'
import type { DatabaseQueryObservation, QueryResultBinding } from './query-state'
import { isRecord } from './value'

function addSerializedResultBinding(
  bindings: Map<unknown, QueryResultBinding[]>,
  rawValue: unknown,
  serializedValue: unknown,
  path: readonly RealtimePatchPathSegment[],
): void {
  const valueBindings = bindings.get(rawValue)
  if (!valueBindings) {
    return
  }

  valueBindings.push(Object.freeze({
    path: copyPatchPath(path),
    pathKey: createResultPathKey(path),
    value: serializedValue,
  }))
}

function isBindingTraversalValue(value: unknown): value is object {
  return Boolean(value) && typeof value === 'object'
}

function collectSerializedResultBindings(
  queries: readonly DatabaseQueryObservation[],
  rawValue: unknown,
  serializedValue: unknown,
): Map<unknown, readonly QueryResultBinding[]> {
  const bindings = new Map<unknown, QueryResultBinding[]>()
  const primitiveQueryCounts = new Map<unknown, {
    aggregate: boolean
    count: number
  }>()
  let tracksLeafBindings = false
  for (const query of queries) {
    if (!bindings.has(query.result)) {
      bindings.set(query.result, [])
    }

    if (!isBindingTraversalValue(query.result)) {
      tracksLeafBindings = true
      const current = primitiveQueryCounts.get(query.result)
      primitiveQueryCounts.set(query.result, {
        aggregate: (current?.aggregate ?? true) && Boolean(query.aggregate),
        count: (current?.count ?? 0) + 1,
      })
    }
  }

  const visited = new WeakSet<object>()
  const path: RealtimePatchPathSegment[] = []
  const visit = (
    rawCurrent: unknown,
    serializedCurrent: unknown,
  ): void => {
    if (!isBindingTraversalValue(rawCurrent)) {
      if (tracksLeafBindings) {
        addSerializedResultBinding(bindings, rawCurrent, serializedCurrent, path)
      }
      return
    }

    addSerializedResultBinding(bindings, rawCurrent, serializedCurrent, path)

    if (visited.has(rawCurrent)) {
      return
    }
    visited.add(rawCurrent)

    if (Array.isArray(rawCurrent)) {
      for (let index = 0; index < rawCurrent.length; index += 1) {
        path.push(index)
        visit(rawCurrent[index], Array.isArray(serializedCurrent) ? serializedCurrent[index] : undefined)
        path.pop()
      }
      return
    }

    if (!isBindingTraversalRecord(rawCurrent)) {
      return
    }

    for (const key of Object.keys(rawCurrent)) {
      const nestedRaw = rawCurrent[key]
      path.push(key)
      visit(nestedRaw, isRecord(serializedCurrent) ? serializedCurrent[key] : undefined)
      path.pop()
    }
  }

  visit(rawValue, serializedValue)
  for (const [value, valueBindings] of bindings) {
    if (!isBindingTraversalValue(value) && shouldDiscardAmbiguousPrimitiveBindings(value, valueBindings, primitiveQueryCounts)) {
      valueBindings.length = 0
    }

    Object.freeze(valueBindings)
  }

  return bindings
}

function shouldDiscardAmbiguousPrimitiveBindings(
  value: unknown,
  bindings: readonly QueryResultBinding[],
  primitiveQueryCounts: ReadonlyMap<unknown, { readonly aggregate: boolean, readonly count: number }>,
): boolean {
  if (bindings.length <= 1) {
    return false
  }

  const primitiveQueries = primitiveQueryCounts.get(value)
  return !primitiveQueries?.aggregate || primitiveQueries.count !== bindings.length
}

function isBindingTraversalRecord(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function bindQueryObservationsToSerializedValue(
  queries: readonly DatabaseQueryObservation[],
  rawValue: unknown,
  serializedValue: unknown,
): readonly DatabaseQueryObservation[] {
  const explicitlyBoundQueries = bindExplicitQueryObservationPaths(queries, serializedValue)
  const implicitQueries = queries.filter(query => !query.resultPath)
  if (implicitQueries.length === 0) {
    return Object.freeze(explicitlyBoundQueries)
  }

  const bindingsByValue = collectSerializedResultBindings(implicitQueries, rawValue, serializedValue)
  const boundQueries: DatabaseQueryObservation[] = [...explicitlyBoundQueries]
  for (const query of implicitQueries) {
    const bindings = bindingsByValue.get(query.result)!
    if (bindings.length === 0) {
      boundQueries.push(Object.freeze({
        ...query,
        ...createQueryObservationMetadata(query),
        resultBound: false,
        resultPath: EMPTY_RESULT_PATH,
        resultPathKey: EMPTY_RESULT_PATH_KEY,
      }))
      continue
    }

    for (const binding of bindings) {
      boundQueries.push(Object.freeze({
        ...query,
        ...createQueryObservationMetadata(query),
        resultBound: true,
        result: binding.value,
        resultPath: binding.path,
        resultPathKey: binding.pathKey,
        rowIdentityIndex: createQueryRowIdentityIndex(binding.value),
      }))
    }
  }

  return Object.freeze(boundQueries)
}

function bindExplicitQueryObservationPaths(
  queries: readonly DatabaseQueryObservation[],
  serializedValue: unknown,
): DatabaseQueryObservation[] {
  const boundQueries: DatabaseQueryObservation[] = []
  for (const query of queries) {
    const path = query.resultPath
    if (!path) {
      continue
    }

    const resultPath = copyPatchPath(path)
    const result = getValueAtPath(serializedValue, resultPath)
    boundQueries.push(Object.freeze({
      ...query,
      ...createQueryObservationMetadata(query),
      result,
      resultBound: true,
      resultPath,
      resultPathKey: createResultPathKey(resultPath),
      rowIdentityIndex: createQueryRowIdentityIndex(result),
    }))
  }

  return boundQueries
}
