import type { DatabaseDependencyInvalidationEvent } from '@holo-js/db'
export type DatabaseMutationEvent = {
  readonly kind: 'insert' | 'update' | 'delete' | 'upsert'
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
  readonly contextId?: number
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
  readonly contextId?: number
  readonly connectionName?: string
  readonly dependencies: readonly string[]
  readonly directDependencies: readonly string[]
  readonly exactPredicates: PredicateDependencyIndex
  readonly hasMutationDependency: boolean
  readonly predicates: PredicateDependencyIndex
  readonly tableDependencies: readonly string[]
}

const EMPTY_DATABASE_MUTATIONS: readonly DatabaseMutationEvent[] = Object.freeze([])
export const EMPTY_TABLE_DEPENDENCIES: readonly string[] = Object.freeze([])

const DATABASE_DEPENDENCY_PREFIX = 'db:'
const DATABASE_DEPENDENCY_METADATA_KEY = '__holoDatabaseDependencyMetadata__'
const MUTATION_DEPENDENCY_SUFFIX = 'mutation'
const WHERE_DEPENDENCY_PREFIX = 'where:'
const WHERE_EXACT_DEPENDENCY_PREFIX = 'where-exact:'

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

function collectPredicateDependencies(
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

export function collectReadPredicateDependencies(
  dependencies: readonly string[],
  reads: readonly { readonly dependencies: readonly string[] }[],
): PredicateDependencyIndex {
  const predicates = collectPredicateDependencies(dependencies)
  if (predicates.size === 0) {
    return predicates
  }

  for (const read of reads) {
    for (const tableKey of collectBroadReadTables(read.dependencies)) {
      predicates.delete(tableKey)
    }
  }

  return predicates
}

function collectBroadReadTables(dependencies: readonly string[]): ReadonlySet<string> {
  const tables = new Set<string>()
  for (const dependency of dependencies) {
    const tableKey = parseTableDependency(dependency)
    if (tableKey) {
      tables.add(tableKey)
    }
  }

  for (const dependency of dependencies) {
    const parsed = parsePredicateDependency(dependency)
    if (parsed) {
      tables.delete(parsed.tableKey)
    }
  }

  return tables
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

export function readDatabaseDependencyInvalidationMetadata(
  event: DatabaseDependencyInvalidationEvent,
): DatabaseDependencyInvalidationMetadata | undefined {
  return (event as DatabaseDependencyInvalidationEventWithMetadata)[DATABASE_DEPENDENCY_METADATA_KEY]
}

export function parseInvalidationEvent(event: DatabaseDependencyInvalidationEvent): ParsedInvalidationEvent {
  const eventWithMutations = event as DatabaseDependencyInvalidationEventWithMutations
  const metadata = readDatabaseDependencyInvalidationMetadata(event)
  const mutations = eventWithMutations.mutations ?? EMPTY_DATABASE_MUTATIONS
  if (metadata) {
    const hasMutationDependency = metadata.hasMutationDependency || hasUpsertMutation(mutations)
    return {
      ...(metadata.contextId === undefined ? {} : { contextId: metadata.contextId, connectionName: event.connectionName }),
      dependencies: hasMutationDependency ? event.dependencies : metadata.directDependencies,
      directDependencies: metadata.directDependencies,
      exactPredicates: createPredicateDependencyIndex(metadata.exactPredicates),
      hasMutationDependency,
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
    predicates,
    tableDependencies: Object.freeze(tableDependencies),
  }
}
