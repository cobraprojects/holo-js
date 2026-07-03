import type { DatabaseDependencyInvalidationEvent } from '@holo-js/db'
import {
  type NO_EXACT_ID_PREDICATE,
  readMutationExactIdPredicateValue,
  readMutationFirstPredicate,
  readMutationPredicateCount,
  readMutationValueKeys,
  type DatabaseQueryPredicateObservation,
} from './predicate-matching'

export type DatabaseMutationEvent = {
  readonly connectionName: string
  readonly exactId?: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly firstPredicate?: DatabaseQueryPredicateObservation
  readonly kind: 'insert' | 'update' | 'delete' | 'upsert'
  readonly predicateCount?: number
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly previousRows?: readonly Readonly<Record<string, unknown>>[]
  readonly rows?: readonly Readonly<Record<string, unknown>>[]
  readonly tableName: string
  readonly values?: Readonly<Record<string, unknown>>
  readonly valueKeys?: readonly string[]
}

export type DatabaseDependencyInvalidationEventWithMutations = DatabaseDependencyInvalidationEvent & {
  readonly mutations?: readonly DatabaseMutationEvent[]
}

export type ParsedPredicateDependency = {
  readonly tableKey: string
  readonly columnName: string
  readonly encodedValue: string
}

export type ParsedDatabaseDependency = {
  readonly suffix?: string
  readonly tableKey: string
}

export type DatabaseDependencyInvalidationMetadata = {
  readonly directDependencies: readonly string[]
  readonly exactPredicates: readonly ParsedPredicateDependency[]
  readonly hasMutationDependency: boolean
  readonly predicates: readonly ParsedPredicateDependency[]
  readonly tableDependencies: readonly string[]
}

export type DatabaseDependencyInvalidationEventWithMetadata = DatabaseDependencyInvalidationEvent & {
  readonly __holoDatabaseDependencyMetadata__?: DatabaseDependencyInvalidationMetadata
}

export type PredicateDependencyIndex = Map<string, Map<string, Set<string>>>

export type ParsedInvalidationEvent = {
  readonly dependencies: readonly string[]
  readonly directDependencies: readonly string[]
  readonly exactPredicates: PredicateDependencyIndex
  readonly hasMutationDependency: boolean
  readonly mutations: readonly DatabaseMutationEvent[]
  readonly predicates: PredicateDependencyIndex
  readonly tableDependencies: readonly string[]
}

export type MutationIndex = Map<string, readonly DatabaseMutationEvent[]>

export const EMPTY_DATABASE_MUTATIONS: readonly DatabaseMutationEvent[] = Object.freeze([])
export const EMPTY_MUTATION_INDEX: MutationIndex = new Map()
export const EMPTY_TABLE_DEPENDENCIES: readonly string[] = Object.freeze([])

const DATABASE_DEPENDENCY_PREFIX = 'db:'
const DATABASE_DEPENDENCY_METADATA_KEY = '__holoDatabaseDependencyMetadata__'
const MUTATION_DEPENDENCY_SUFFIX = 'mutation'
const WHERE_DEPENDENCY_PREFIX = 'where:'
const WHERE_EXACT_DEPENDENCY_PREFIX = 'where-exact:'

export function createMutationIndexKey(connectionName: string, tableName: string): string {
  return `${connectionName}:${tableName}`
}

export function createMutationIndex(events: readonly ParsedInvalidationEvent[]): MutationIndex {
  const mutations = new Map<string, DatabaseMutationEvent[]>()
  for (const event of events) {
    for (const mutation of event.mutations) {
      const key = createMutationIndexKey(mutation.connectionName, mutation.tableName)
      const indexedMutations = mutations.get(key)
      if (indexedMutations) {
        indexedMutations.push(mutation)
        continue
      }

      mutations.set(key, [mutation])
    }
  }

  if (mutations.size === 0) {
    return EMPTY_MUTATION_INDEX
  }

  for (const indexedMutations of mutations.values()) {
    Object.freeze(indexedMutations)
  }

  return mutations
}

export function createSingleEventMutationIndex(event: ParsedInvalidationEvent): MutationIndex {
  const firstMutation = event.mutations[0]
  if (!firstMutation) {
    return EMPTY_MUTATION_INDEX
  }

  if (event.mutations.length === 1) {
    return new Map([
      [
        createMutationIndexKey(firstMutation.connectionName, firstMutation.tableName),
        Object.freeze([firstMutation]),
      ],
    ])
  }

  const mutations = new Map<string, DatabaseMutationEvent[]>()
  for (const mutation of event.mutations) {
    const key = createMutationIndexKey(mutation.connectionName, mutation.tableName)
    const indexedMutations = mutations.get(key)
    if (indexedMutations) {
      indexedMutations.push(mutation)
      continue
    }

    mutations.set(key, [mutation])
  }

  for (const indexedMutations of mutations.values()) {
    Object.freeze(indexedMutations)
  }

  return mutations
}

export function parseDatabaseDependency(dependency: string): ParsedDatabaseDependency | undefined {
  if (!dependency.startsWith(DATABASE_DEPENDENCY_PREFIX)) {
    return undefined
  }

  const connectionEnd = dependency.indexOf(':', DATABASE_DEPENDENCY_PREFIX.length)
  if (connectionEnd <= DATABASE_DEPENDENCY_PREFIX.length) {
    return undefined
  }

  const tableStart = connectionEnd + 1
  const tableEnd = dependency.indexOf(':', tableStart)
  if (tableEnd < 0) {
    return tableStart === dependency.length
      ? undefined
      : { tableKey: dependency }
  }

  if (tableEnd === tableStart) {
    return undefined
  }

  const suffixStart = tableEnd + 1
  return {
    suffix: suffixStart === dependency.length ? '' : dependency.slice(suffixStart),
    tableKey: dependency.slice(0, tableEnd),
  }
}

function parsePredicateDependencySuffix(
  tableKey: string,
  suffix: string,
  prefix: string,
): ParsedPredicateDependency | undefined {
  if (!suffix.startsWith(prefix)) {
    return undefined
  }

  const columnStart = prefix.length
  const valueSeparator = suffix.indexOf(':', columnStart)
  if (valueSeparator <= columnStart || valueSeparator === suffix.length - 1) {
    return undefined
  }

  return {
    tableKey,
    columnName: suffix.slice(columnStart, valueSeparator),
    encodedValue: suffix.slice(valueSeparator + 1),
  }
}

export function parsePredicateDependency(dependency: string): ParsedPredicateDependency | undefined {
  const parsed = parseDatabaseDependency(dependency)
  if (!parsed?.suffix) {
    return undefined
  }

  return parsePredicateDependencySuffix(parsed.tableKey, parsed.suffix, WHERE_DEPENDENCY_PREFIX)
}

export function parseTableDependency(dependency: string): string | undefined {
  const parsed = parseDatabaseDependency(dependency)
  return parsed && parsed.suffix === undefined ? parsed.tableKey : undefined
}

function isMutationDependencySuffix(suffix: string): boolean {
  return suffix === MUTATION_DEPENDENCY_SUFFIX
}

function hasUpsertMutation(mutations: readonly DatabaseMutationEvent[]): boolean {
  return mutations.some(mutation => mutation.kind === 'upsert')
}

export function collectPredicateDependencies(
  dependencies: readonly string[],
  parseDependency: (dependency: string) => ParsedPredicateDependency | undefined = parsePredicateDependency,
): PredicateDependencyIndex {
  const predicates: PredicateDependencyIndex = new Map<string, Map<string, Set<string>>>()
  for (const dependency of dependencies) {
    const parsed = parseDependency(dependency)
    if (!parsed) {
      continue
    }

    addPredicateDependency(predicates, parsed)
  }

  return predicates
}

function addPredicateDependency(
  predicates: PredicateDependencyIndex,
  parsed: ParsedPredicateDependency,
): void {
  const tablePredicates = predicates.get(parsed.tableKey) ?? new Map<string, Set<string>>()
  const values = tablePredicates.get(parsed.columnName) ?? new Set<string>()
  values.add(parsed.encodedValue)
  tablePredicates.set(parsed.columnName, values)
  predicates.set(parsed.tableKey, tablePredicates)
}

function createPredicateDependencyIndex(
  dependencies: readonly ParsedPredicateDependency[],
): PredicateDependencyIndex {
  const predicates: PredicateDependencyIndex = new Map<string, Map<string, Set<string>>>()
  for (const dependency of dependencies) {
    addPredicateDependency(predicates, dependency)
  }

  return predicates
}

export function collectTableDependencies(dependencies: readonly string[]): readonly string[] {
  let firstTableDependency: string | undefined
  let tableDependencies: Set<string> | undefined
  for (const dependency of dependencies) {
    const tableKey = parseTableDependency(dependency)
    if (!tableKey) {
      continue
    }

    if (typeof firstTableDependency === 'undefined') {
      firstTableDependency = tableKey
      continue
    }

    if (tableKey === firstTableDependency) {
      continue
    }

    tableDependencies ??= new Set([firstTableDependency])
    tableDependencies.add(tableKey)
  }

  if (tableDependencies) {
    return Object.freeze([...tableDependencies])
  }

  if (typeof firstTableDependency === 'undefined') {
    return EMPTY_TABLE_DEPENDENCIES
  }

  return Object.freeze([firstTableDependency])
}

function readDatabaseDependencyInvalidationMetadata(
  event: DatabaseDependencyInvalidationEvent,
): DatabaseDependencyInvalidationMetadata | undefined {
  return (event as DatabaseDependencyInvalidationEventWithMetadata)[DATABASE_DEPENDENCY_METADATA_KEY]
}

function bindMutationMetadata(
  mutations: readonly DatabaseMutationEvent[],
): readonly DatabaseMutationEvent[] {
  if (mutations.length === 0) {
    return EMPTY_DATABASE_MUTATIONS
  }

  const boundMutations: DatabaseMutationEvent[] = []
  for (const mutation of mutations) {
    boundMutations.push(Object.freeze({
      ...mutation,
      exactId: readMutationExactIdPredicateValue(mutation),
      firstPredicate: readMutationFirstPredicate(mutation),
      predicateCount: readMutationPredicateCount(mutation),
      valueKeys: readMutationValueKeys(mutation),
    }))
  }

  return Object.freeze(boundMutations)
}

export function parseInvalidationEvent(event: DatabaseDependencyInvalidationEvent): ParsedInvalidationEvent {
  const eventWithMutations = event as DatabaseDependencyInvalidationEventWithMutations
  const mutations = bindMutationMetadata(eventWithMutations.mutations ?? EMPTY_DATABASE_MUTATIONS)
  const metadata = readDatabaseDependencyInvalidationMetadata(event)
  if (metadata) {
    const hasMutationDependency = metadata.hasMutationDependency || hasUpsertMutation(mutations)
    return {
      dependencies: hasMutationDependency ? event.dependencies : metadata.directDependencies,
      directDependencies: metadata.directDependencies,
      exactPredicates: createPredicateDependencyIndex(metadata.exactPredicates),
      hasMutationDependency,
      mutations,
      predicates: createPredicateDependencyIndex(metadata.predicates),
      tableDependencies: metadata.tableDependencies,
    }
  }

  const directDependencies: string[] = []
  const exactPredicates: PredicateDependencyIndex = new Map<string, Map<string, Set<string>>>()
  const predicates: PredicateDependencyIndex = new Map<string, Map<string, Set<string>>>()
  const tableDependencyCandidates: string[] = []
  let mutationDependencyFound = hasUpsertMutation(mutations)
  for (const dependency of event.dependencies) {
    const parsed = parseDatabaseDependency(dependency)
    if (!parsed) {
      directDependencies.push(dependency)
      continue
    }

    if (parsed.suffix === undefined) {
      tableDependencyCandidates.push(parsed.tableKey)
      continue
    }

    if (isMutationDependencySuffix(parsed.suffix)) {
      mutationDependencyFound = true
      directDependencies.push(dependency)
      continue
    }

    const exactPredicate = parsePredicateDependencySuffix(
      parsed.tableKey,
      parsed.suffix,
      WHERE_EXACT_DEPENDENCY_PREFIX,
    )
    if (exactPredicate) {
      addPredicateDependency(exactPredicates, exactPredicate)
      directDependencies.push(dependency)
      continue
    }

    const predicate = parsePredicateDependencySuffix(
      parsed.tableKey,
      parsed.suffix,
      WHERE_DEPENDENCY_PREFIX,
    )
    if (predicate) {
      addPredicateDependency(predicates, predicate)
      directDependencies.push(dependency)
      continue
    }

    directDependencies.push(dependency)
  }

  const tableDependencies: string[] = []
  for (const tableKey of tableDependencyCandidates) {
    if (exactPredicates.has(tableKey)) {
      tableDependencies.push(tableKey)
      continue
    }

    directDependencies.push(tableKey)
  }

  return {
    dependencies: event.dependencies,
    directDependencies: Object.freeze(directDependencies),
    exactPredicates,
    hasMutationDependency: mutationDependencyFound,
    mutations,
    predicates,
    tableDependencies: Object.freeze(tableDependencies),
  }
}
