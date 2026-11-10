import { queryCacheInternals } from '@holo-js/db'
import { getValueAtPath } from './result-patching'
import type { DatabaseQueryObservation, QueryResultBinding } from './query-state'
import { isRecord } from './value'

function addSerializedResultBinding(
  bindings: Map<unknown, QueryResultBinding[]>,
  rawValue: unknown,
  serializedValue: unknown,
): void {
  const valueBindings = bindings.get(rawValue)
  if (!valueBindings) {
    return
  }

  valueBindings.push(Object.freeze({ value: serializedValue }))
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
  const visit = (
    rawCurrent: unknown,
    serializedCurrent: unknown,
  ): void => {
    if (!isBindingTraversalValue(rawCurrent)) {
      if (tracksLeafBindings) {
        addSerializedResultBinding(bindings, rawCurrent, serializedCurrent)
      }
      return
    }

    addSerializedResultBinding(bindings, rawCurrent, serializedCurrent)

    if (visited.has(rawCurrent)) {
      return
    }
    visited.add(rawCurrent)

    if (Array.isArray(rawCurrent)) {
      for (let index = 0; index < rawCurrent.length; index += 1) {
        visit(rawCurrent[index], Array.isArray(serializedCurrent) ? serializedCurrent[index] : undefined)
      }
      return
    }

    if (!isBindingTraversalRecord(rawCurrent)) {
      return
    }

    for (const key of Object.keys(rawCurrent)) {
      visit(rawCurrent[key], isRecord(serializedCurrent) ? serializedCurrent[key] : undefined)
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
  const implicitQueries = queries.filter(query => !query.resultPath)
  const explicitlyBoundQueries = bindExplicitQueryObservationPaths(queries, serializedValue)
  if (implicitQueries.length === 0) {
    return Object.freeze(explicitlyBoundQueries)
  }

  const bindingsByValue = collectSerializedResultBindings(implicitQueries, rawValue, serializedValue)
  const boundQueries: DatabaseQueryObservation[] = [...explicitlyBoundQueries]
  for (const query of implicitQueries) {
    const bindings = hasChangedObservedResult(query) || returnsSerializedSource(query, rawValue) ? [] : bindingsByValue.get(query.result)!
    if (bindings.length === 0) {
      boundQueries.push(Object.freeze({
        ...query,
        observedResult: undefined,
        serializedSources: undefined,
        resultBound: false,
      }))
      continue
    }

    for (const binding of bindings) {
      boundQueries.push(Object.freeze({
        ...query,
        observedResult: undefined,
        serializedSources: undefined,
        resultBound: true,
        result: binding.value,
      }))
    }
  }

  return Object.freeze(boundQueries)
}

function returnsSerializedSource(query: DatabaseQueryObservation, rawValue: unknown): boolean {
  return query.serializedSources !== undefined
    && containsAnyValue(rawValue, new Set(query.serializedSources), new WeakSet())
}

function containsAnyValue(current: unknown, targets: ReadonlySet<unknown>, visited: WeakSet<object>): boolean {
  if (targets.has(current)) {
    return true
  }

  if (!isBindingTraversalValue(current) || visited.has(current)) {
    return false
  }

  visited.add(current)
  if (Array.isArray(current)) {
    return current.some(value => containsAnyValue(value, targets, visited))
  }

  return isBindingTraversalRecord(current) && Object.values(current).some(value => containsAnyValue(value, targets, visited))
}

function hasChangedObservedResult(query: DatabaseQueryObservation): boolean {
  return query.observedResult !== undefined && queryCacheInternals.hasObservedResultChanged(query.observedResult, query.result)
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

    boundQueries.push(Object.freeze({
      ...query,
      observedResult: undefined,
      serializedSources: undefined,
      result: getValueAtPath(serializedValue, path),
      resultBound: true,
    }))
  }

  return boundQueries
}
