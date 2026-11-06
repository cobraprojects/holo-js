import {
  collectReadPredicateDependencies,
  collectTableDependencies,
  parseDatabaseDependency,
  type ParsedInvalidationEvent,
  type PredicateDependencyIndex,
} from './dependencies'
import {
  isQueryObservationContradictedByExactPredicates,
} from './predicate-dependency-matching'
import {
  EMPTY_QUERY_ENTRIES,
  getRuntimeState,
  type ActiveQueryEntry,
  type QueryEntryCollector,
  type RefreshDelivery,
} from './state'
import type { RealtimeQueryDefinitionMetadata } from '../contracts'

const PREDICATE_WILDCARD_VALUE = '*'

function isBroadTablePredicates(tablePredicates: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  if (tablePredicates.size === 0) {
    return true
  }

  for (const values of tablePredicates.values()) {
    if (values.has(PREDICATE_WILDCARD_VALUE)) {
      return true
    }
  }

  return false
}

export function addQueryEntryDependencies(entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  for (const dependency of entry.dependencies) {
    const entries = state.dependencySubscribers.get(dependency) ?? new Set<string>()
    entries.add(entry.refreshKey)
    state.dependencySubscribers.set(dependency, entries)
  }
}

export function addQueryEntryInvalidationIndexes(entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  for (const tableKey of entry.tableDependencies) {
    const tablePredicates = entry.predicateDependencies.get(tableKey)
    if (!tablePredicates || isBroadTablePredicates(tablePredicates)) {
      const broadEntries = state.tableBroadSubscribers.get(tableKey) ?? new Set<string>()
      broadEntries.add(entry.refreshKey)
      state.tableBroadSubscribers.set(tableKey, broadEntries)
      continue
    }

    const columnEntries = state.tablePredicateColumnSubscribers.get(tableKey) ?? new Map<string, Set<string>>()
    const valueEntries = state.tablePredicateValueSubscribers.get(tableKey) ?? new Map<string, Map<string, Set<string>>>()
    for (const [columnName, values] of tablePredicates) {
      const entries = columnEntries.get(columnName) ?? new Set<string>()
      entries.add(entry.refreshKey)
      columnEntries.set(columnName, entries)

      const columnValues = valueEntries.get(columnName) ?? new Map<string, Set<string>>()
      for (const value of values) {
        const valueSubscribers = columnValues.get(value) ?? new Set<string>()
        valueSubscribers.add(entry.refreshKey)
        columnValues.set(value, valueSubscribers)
      }
      valueEntries.set(columnName, columnValues)
    }
    state.tablePredicateColumnSubscribers.set(tableKey, columnEntries)
    state.tablePredicateValueSubscribers.set(tableKey, valueEntries)
  }
}

export function removeQueryEntryDependencies(entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  for (const dependency of entry.dependencies) {
    const entries = state.dependencySubscribers.get(dependency)
    if (!entries) {
      continue
    }

    entries.delete(entry.refreshKey)
    if (entries.size === 0) {
      state.dependencySubscribers.delete(dependency)
    }
  }
}

export function removeQueryEntryInvalidationIndexes(entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>): void {
  const state = getRuntimeState()
  for (const tableKey of entry.tableDependencies) {
    const tablePredicates = entry.predicateDependencies.get(tableKey)
    if (!tablePredicates || isBroadTablePredicates(tablePredicates)) {
      const broadEntries = state.tableBroadSubscribers.get(tableKey)
      broadEntries?.delete(entry.refreshKey)
      if (broadEntries?.size === 0) {
        state.tableBroadSubscribers.delete(tableKey)
      }
      continue
    }

    const columnEntries = state.tablePredicateColumnSubscribers.get(tableKey)
    if (columnEntries) {
      for (const columnName of tablePredicates.keys()) {
        const entries = columnEntries.get(columnName)
        if (!entries) {
          continue
        }

        entries.delete(entry.refreshKey)
        if (entries.size === 0) {
          columnEntries.delete(columnName)
        }
      }
      if (columnEntries.size === 0) {
        state.tablePredicateColumnSubscribers.delete(tableKey)
      }
    }

    const valueEntries = state.tablePredicateValueSubscribers.get(tableKey)
    if (!valueEntries) {
      continue
    }

    for (const [columnName, values] of tablePredicates) {
      const columnValues = valueEntries.get(columnName)
      if (!columnValues) {
        continue
      }

      for (const value of values) {
        const entries = columnValues.get(value)
        if (!entries) {
          continue
        }

        entries.delete(entry.refreshKey)
        if (entries.size === 0) {
          columnValues.delete(value)
        }
      }

      if (columnValues.size === 0) {
        valueEntries.delete(columnName)
      }
    }
    if (valueEntries.size === 0) {
      state.tablePredicateValueSubscribers.delete(tableKey)
    }
  }
}

export function updateQueryEntryDependencies(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  dependencies: readonly string[],
  predicateDependencies: PredicateDependencyIndex,
  tableDependencies: readonly string[],
): void {
  removeQueryEntryDependencies(entry)
  removeQueryEntryInvalidationIndexes(entry)
  entry.dependencies = dependencies
  entry.predicateDependencies = predicateDependencies
  entry.tableDependencies = tableDependencies
  addQueryEntryDependencies(entry)
  addQueryEntryInvalidationIndexes(entry)
}

export function ensureRefreshDeliveryPredicateDependencies<TDefinition extends RealtimeQueryDefinitionMetadata>(
  delivery: RefreshDelivery<TDefinition>,
): PredicateDependencyIndex {
  delivery.predicateDependencies ??= collectReadPredicateDependencies(delivery.result.dependencies, delivery.result.queries)
  return delivery.predicateDependencies
}

export function ensureRefreshDeliveryTableDependencies<TDefinition extends RealtimeQueryDefinitionMetadata>(
  delivery: RefreshDelivery<TDefinition>,
): readonly string[] {
  delivery.tableDependencies ??= collectTableDependencies(delivery.result.dependencies)
  return delivery.tableDependencies
}

export function arePredicateDependenciesEqual(
  current: PredicateDependencyIndex,
  next: PredicateDependencyIndex,
): boolean {
  if (current === next) {
    return true
  }

  if (current.size !== next.size) {
    return false
  }

  for (const [tableKey, currentColumns] of current) {
    const nextColumns = next.get(tableKey)
    if (!nextColumns || nextColumns.size !== currentColumns.size) {
      return false
    }

    for (const [columnName, currentValues] of currentColumns) {
      const nextValues = nextColumns.get(columnName)
      if (!nextValues || nextValues.size !== currentValues.size) {
        return false
      }

      for (const value of currentValues) {
        if (!nextValues.has(value)) {
          return false
        }
      }
    }
  }

  return true
}

export function areDependencySetsEqual(
  currentDependencies: readonly string[],
  nextDependencies: readonly string[],
): boolean {
  if (currentDependencies === nextDependencies) {
    return true
  }

  if (currentDependencies.length !== nextDependencies.length) {
    return false
  }

  for (let index = 0; index < currentDependencies.length; index += 1) {
    if (currentDependencies[index] !== nextDependencies[index]) {
      const currentDependencySet = new Set(currentDependencies)
      if (currentDependencySet.size !== nextDependencies.length) {
        return false
      }

      for (const dependency of nextDependencies) {
        if (!currentDependencySet.has(dependency)) {
          return false
        }
      }

      return true
    }
  }

  return true
}

export function collectQueryEntriesForParsedInvalidation(
  event: ParsedInvalidationEvent,
): readonly ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[] {
  const state = getRuntimeState()
  const entries: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[] = []
  const collector: QueryEntryCollector = {
    entries,
    event,
    state,
  }
  collectQueryEntryKeysForParsedInvalidation(collector)
  return entries.length === 0 ? EMPTY_QUERY_ENTRIES : entries
}

export function collectQueryEntriesForParsedInvalidations(
  events: readonly ParsedInvalidationEvent[],
): readonly ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[] {
  if (events.length === 0) {
    return EMPTY_QUERY_ENTRIES
  }

  const firstEvent = events[0]!
  if (events.length === 1) {
    return collectQueryEntriesForParsedInvalidation(firstEvent)
  }

  const state = getRuntimeState()
  const entries: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[] = []
  const collector: QueryEntryCollector = {
    entries,
    event: firstEvent,
    state,
  }
  for (const event of events) {
    collector.event = event
    collectQueryEntryKeysForParsedInvalidation(collector)
  }

  return entries.length === 0 ? EMPTY_QUERY_ENTRIES : entries
}

function collectQueryEntryKey(collector: QueryEntryCollector, entryKey: string): void {
  if (entryKey === collector.firstEntryKey || collector.entryKeys?.has(entryKey)) {
    return
  }

  const entry = collector.state.queryEntries.get(entryKey)
  if (!entry || isQueryEntryContradictedByInvalidation(entry, collector.event)) {
    return
  }
  const { contextId, connectionName } = collector.event
  if (contextId !== undefined && connectionName) {
    const observed = entry.contexts.get(connectionName)
    if (observed ? !observed.has(contextId) : contextId !== entry.contextId) return
  }

  if (typeof collector.firstEntryKey === 'undefined') {
    collector.firstEntryKey = entryKey
  } else {
    collector.entryKeys ??= new Set([collector.firstEntryKey])
    collector.entryKeys.add(entryKey)
  }
  collector.entries.push(entry)
}

function collectQueryEntryKeysForDependency(
  collector: QueryEntryCollector,
  dependency: string,
): void {
  const entryKeys = collector.state.dependencySubscribers.get(dependency)
  if (!entryKeys) {
    return
  }

  for (const entryKey of entryKeys) {
    collectQueryEntryKey(collector, entryKey)
  }
}

function collectQueryEntryKeysForExactTableInvalidation(
  collector: QueryEntryCollector,
  tableKey: string,
  exactPredicates: Map<string, Set<string>>,
): void {
  const broadEntryKeys = collector.state.tableBroadSubscribers.get(tableKey)
  if (broadEntryKeys) {
    for (const entryKey of broadEntryKeys) {
      collectQueryEntryKey(collector, entryKey)
    }
  }

  const columnEntries = collector.state.tablePredicateColumnSubscribers.get(tableKey)
  if (!columnEntries) {
    return
  }

  const valueEntries = collector.state.tablePredicateValueSubscribers.get(tableKey)
  for (const [columnName, entries] of columnEntries) {
    const exactValues = exactPredicates.get(columnName)
    if (!exactValues) {
      for (const entryKey of entries) {
        collectQueryEntryKey(collector, entryKey)
      }
      continue
    }

    for (const encodedValue of exactValues) {
      const valueSubscribers = valueEntries?.get(columnName)?.get(encodedValue)
      if (!valueSubscribers) {
        continue
      }

      for (const entryKey of valueSubscribers) {
        collectQueryEntryKey(collector, entryKey)
      }
    }
  }
}

function collectQueryEntryKeysForParsedInvalidation(collector: QueryEntryCollector): void {
  const event = collector.event
  if (event.exactPredicates.size === 0 || event.hasMutationDependency) {
    for (const dependency of event.dependencies) {
      collectQueryEntryKeysForDependency(collector, dependency)
    }
    return
  }

  for (const dependency of event.directDependencies) {
    collectQueryEntryKeysForDependency(collector, dependency)
  }

  for (const tableKey of event.tableDependencies) {
    const exactPredicates = event.exactPredicates.get(tableKey)
    if (!exactPredicates) {
      continue
    }

    collectQueryEntryKeysForExactTableInvalidation(collector, tableKey, exactPredicates)
  }
}

function isQueryEntryContradictedByInvalidation(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  event: ParsedInvalidationEvent,
): boolean {
  if (event.exactPredicates.size === 0 || event.hasMutationDependency) {
    return false
  }

  return isQueryEntryDependencyContradictedByInvalidation(entry, event)
    || isQueryEntryObservationContradictedByInvalidation(entry, event)
}

function isQueryEntryDependencyContradictedByInvalidation(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  event: ParsedInvalidationEvent,
): boolean {
  if (
    entry.predicateDependencies.size === 0
    || event.predicates.size === 0
  ) {
    return false
  }

  for (const [tableKey, tablePredicates] of entry.predicateDependencies) {
    if (tablePredicates.get(PREDICATE_WILDCARD_VALUE)?.has(PREDICATE_WILDCARD_VALUE)) {
      continue
    }

    if (isTablePredicatesContradicted(tableKey, tablePredicates, event) && isTableContradictedForEveryRead(entry, tableKey, event)) {
      return true
    }
  }

  return false
}

function isTablePredicatesContradicted(
  tableKey: string,
  tablePredicates: ReadonlyMap<string, ReadonlySet<string>>,
  event: ParsedInvalidationEvent,
): boolean {
  for (const [columnName, values] of tablePredicates) {
    const invalidatedValues = event.predicates.get(tableKey)?.get(columnName)
    const exactInvalidatedValues = event.exactPredicates.get(tableKey)?.get(columnName)
    if (!exactInvalidatedValues) {
      continue
    }

    let hasMatchingValue = values.has(PREDICATE_WILDCARD_VALUE)
    for (const value of values) {
      if (invalidatedValues?.has(value) || exactInvalidatedValues.has(value)) {
        hasMatchingValue = true
        break
      }
    }

    if (!hasMatchingValue) {
      return true
    }
  }

  return false
}

type ReadPredicateIndex = {
  readonly predicates: PredicateDependencyIndex
  readonly tables: ReadonlySet<string>
}

const readPredicateIndexes = new WeakMap<readonly string[], ReadPredicateIndex>()

function isTableContradictedForEveryRead(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  tableKey: string,
  event: ParsedInvalidationEvent,
): boolean {
  let readCount = 0
  for (const query of entry.queries) {
    const read = readPredicateIndex(query.dependencies)
    if (!read.tables.has(tableKey)) {
      continue
    }

    readCount += 1
    const readPredicates = read.predicates.get(tableKey)
    if (!readPredicates || !isTablePredicatesContradicted(tableKey, readPredicates, event)) {
      return false
    }
  }

  return readCount > 0 || entry.queries.length === 0
}

function readPredicateIndex(dependencies: readonly string[]): ReadPredicateIndex {
  const cached = readPredicateIndexes.get(dependencies)
  if (cached) {
    return cached
  }

  const tables = new Set<string>()
  for (const dependency of dependencies) {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    if (tableKey) {
      tables.add(tableKey)
    }
  }

  const index = {
    predicates: collectReadPredicateDependencies(dependencies, [{ dependencies }]),
    tables,
  }
  readPredicateIndexes.set(dependencies, index)
  return index
}

function isQueryEntryObservationContradictedByInvalidation(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  event: ParsedInvalidationEvent,
): boolean {
  let foundContradictedObservation = false
  for (const query of entry.queries) {
    const contradicted = isQueryObservationContradictedByExactPredicates(query, event.exactPredicates)
    if (contradicted === false) {
      return false
    }

    if (contradicted === true) {
      foundContradictedObservation = true
    }
  }

  return foundContradictedObservation
}
