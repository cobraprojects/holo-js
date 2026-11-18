import { CompilerError, ConfigurationError, SecurityError } from '../core/errors'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import { splitTablePath } from '../schema/identifiers'
import { knownJoinedColumns } from './modelRowProjection'
import { dateBucketSelections, readAllColumnsSelectionTable } from './ast'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryDateBucketSelection, QueryDateBucketUnit, QueryPredicateNode, SelectQueryPlan } from './ast'

export type DateBucketStorage = 'calendar' | 'datetime' | 'timestamp'

const MAX_ALIAS_BYTES = 63

export function truncatedIdentifier(name: string): string {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length <= MAX_ALIAS_BYTES) return name
  let end = MAX_ALIAS_BYTES
  while (end > 0 && ((bytes[end] ?? 0) & 0xC0) === 0x80) end -= 1
  return new TextDecoder().decode(bytes.slice(0, end))
}

export function effectiveOutputName(name: string): string {
  return truncatedIdentifier(name).toLowerCase()
}

export function planHasDateBuckets(plan: SelectQueryPlan): boolean {
  return planDateBuckets(plan).length > 0
}

export function assertDateBucketAliasLength(alias: string): void {
  if (new TextEncoder().encode(alias).length > MAX_ALIAS_BYTES) {
    throw new SecurityError(`Date bucket alias "${alias}" must be at most ${MAX_ALIAS_BYTES} bytes, the longest name PostgreSQL keeps.`)
  }
}

const DATE_BUCKET_UNITS: ReadonlySet<string> = new Set<QueryDateBucketUnit>(['year', 'month', 'day', 'hour'])
const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9]*(?:[/_+-][A-Za-z0-9]+)*$/

function isRegionTimeZone(timeZone: string): boolean {
  if (!TIME_ZONE_NAME.test(timeZone) || (timeZone !== 'UTC' && !timeZone.includes('/'))) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function assertDateBucketUnit(unit: string): asserts unit is QueryDateBucketUnit {
  if (!DATE_BUCKET_UNITS.has(unit)) {
    throw new SecurityError(`Date bucket unit "${unit}" is not one of year, month, day or hour.`)
  }
}

export function assertDateBucketTimeZone(timeZone: string): void {
  if (!isRegionTimeZone(timeZone)) {
    throw new SecurityError(`Date bucket time zone "${timeZone}" must be "UTC" or an IANA Area/Location name such as "Europe/Paris", not an abbreviation such as "CET".`)
  }
}

function generatedDefinition(tableName: string | undefined, connectionName: string | undefined): TableDefinition | undefined {
  return tableName === undefined || connectionName === undefined ? undefined : getConnectionGeneratedTableDefinition(tableName, connectionName)
}

type VisibleTable = {
  readonly tableName: string | undefined
  readonly alias: string | undefined
  readonly definition: TableDefinition | undefined
  readonly columns: () => readonly string[] | undefined
}

function sameIdentifierFolded(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

type IdentifierMatch = (left: string, right: string) => boolean

const sameIdentifierExactly: IdentifierMatch = (left, right) => left === right

function isVisibleAs(qualifier: string, { tableName, alias }: VisibleTable, matches: IdentifierMatch = sameIdentifierExactly): boolean {
  if (alias !== undefined) return matches(qualifier, alias)
  return tableName !== undefined && (matches(qualifier, tableName) || matches(qualifier, splitTablePath(tableName).table))
}

function matchingColumnDefinition(table: TableDefinition | undefined, name: string, matches: IdentifierMatch): AnyColumnDefinition | undefined {
  if (!table) return undefined
  const key = Object.keys(table.columns).find(column => matches(column, name))
  return key === undefined ? undefined : table.columns[key]
}

function visibleTables(plan: SelectQueryPlan, connectionName: string | undefined, wildcardMatches: IdentifierMatch = sameIdentifierExactly): readonly VisibleTable[] {
  const sourceDefinition = plan.source.table ?? generatedDefinition(plan.source.tableName, connectionName)
  return [
    {
      tableName: plan.source.tableName,
      alias: plan.source.alias,
      definition: sourceDefinition,
      columns: () => sourceDefinition ? Object.keys(sourceDefinition.columns) : undefined,
    },
    ...plan.joins.map((join) => {
      const definition = join.definition ?? generatedDefinition(join.table, connectionName)
      return {
        tableName: join.table,
        alias: join.alias,
        definition,
        columns: () => join.subquery
          ? subqueryOutputNames(join.subquery, connectionName, wildcardMatches)
          : definition ? Object.keys(definition.columns) : connectionName === undefined ? undefined : knownJoinedColumns(join, connectionName),
      }
    }),
  ]
}

function wildcardOutputNames(plan: SelectQueryPlan, column: string, connectionName: string | undefined, matches: IdentifierMatch): readonly string[] | undefined {
  const qualifier = column === '*' ? undefined : readAllColumnsSelectionTable(column)
  const tables = boundTables(visibleTables(plan, connectionName, matches), qualifier, matches)
  if (tables.length === 0) return undefined
  const columns = tables.map(table => table.columns())
  return columns.every((names): names is readonly string[] => names !== undefined) ? columns.flat() : undefined
}

function subqueryOutputNames(plan: SelectQueryPlan, connectionName: string | undefined, matches: IdentifierMatch): readonly string[] | undefined {
  const selections: readonly SelectQueryPlan['selections'][number][] = plan.selections.length === 0 ? [{ kind: 'column', column: '*' }] : plan.selections
  const names = selections.map((selection): readonly string[] | undefined => {
    if (selection.kind === 'raw') return undefined
    if (selection.kind !== 'column') return [selection.alias]
    if (selection.alias) return [selection.alias]
    if (selection.column === '*' || readAllColumnsSelectionTable(selection.column) !== undefined) return wildcardOutputNames(plan, selection.column, connectionName, matches)
    return [selection.column.slice(selection.column.lastIndexOf('.') + 1)]
  })
  return names.every((group): group is readonly string[] => group !== undefined) ? names.flat() : undefined
}

function boundTables(visible: readonly VisibleTable[], qualifier: string | undefined, matches: IdentifierMatch = sameIdentifierExactly): readonly VisibleTable[] {
  return qualifier === undefined ? visible : visible.filter(table => isVisibleAs(qualifier, table, matches))
}

function bucketColumnDefinition(plan: SelectQueryPlan, column: string, connectionName: string | undefined, foldsColumnNames: boolean): AnyColumnDefinition | undefined {
  const separator = column.lastIndexOf('.')
  const name = column.slice(separator + 1)
  const matches = foldsColumnNames ? sameIdentifierFolded : sameIdentifierExactly
  const tables = separator === -1
    ? ownerTables(plan, name, connectionName, matches)
    : boundTables(visibleTables(plan, connectionName), column.slice(0, separator))
  return tables
    .map(table => matchingColumnDefinition(table.definition, name, sameIdentifierExactly) ?? matchingColumnDefinition(table.definition, name, matches))
    .find(definition => definition !== undefined)
}

function ownerTables(plan: SelectQueryPlan, name: string, connectionName: string | undefined, matches: IdentifierMatch): readonly VisibleTable[] {
  const candidates = visibleTables(plan, connectionName, matches).filter((table) => {
    const columns = table.columns()
    return columns === undefined || columns.some(column => matches(column, name))
  })
  return candidates.length === 1 ? candidates : []
}

export function selectionMayOutputName(
  plan: SelectQueryPlan,
  selection: SelectQueryPlan['selections'][number],
  name: string,
  connectionName: string | undefined,
  unknown: { readonly raw: boolean, readonly wildcard: boolean },
  foldsIdentifiers: boolean,
): boolean {
  if (selection.kind === 'raw') return unknown.raw
  if (selection.kind !== 'column' || selection.alias) return false
  const wildcardTable = selection.column === '*' ? undefined : readAllColumnsSelectionTable(selection.column)
  if (selection.column !== '*' && wildcardTable === undefined) return false
  const matches = foldsIdentifiers ? sameIdentifierFolded : sameIdentifierExactly
  const tables = boundTables(visibleTables(plan, connectionName, matches), wildcardTable, matches)
  if (tables.length === 0) return unknown.wildcard
  return tables
    .some((table) => {
      const columns = table.columns()
      return columns === undefined ? unknown.wildcard : columns.some(column => effectiveOutputName(column) === effectiveOutputName(name))
    })
}

export function columnOwner(plan: SelectQueryPlan, name: string, connectionName: string | undefined, matches: IdentifierMatch = sameIdentifierFolded): string | undefined {
  const [owner] = ownerTables(plan, name, connectionName, matches)
  return owner && (owner.alias ?? owner.tableName ?? plan.source.tableName)
}

export type GroupedKeyContext = { readonly connectionName: string | undefined, readonly foldsColumnNames: boolean, readonly foldsTableNames: boolean }

export function groupedCursorKey(plan: SelectQueryPlan, column: string, context: GroupedKeyContext): string {
  if (dateBucketSelections(plan).has(column)) return column
  const { connectionName } = context
  const separator = column.lastIndexOf('.')
  const name = context.foldsColumnNames ? column.slice(separator + 1).toLowerCase() : column.slice(separator + 1)
  if (separator === -1) {
    const owner = columnOwner(plan, column, connectionName, context.foldsColumnNames ? sameIdentifierFolded : sameIdentifierExactly)
    return owner === undefined ? name : `${owner}.${name}`
  }
  const qualifierMatches = context.foldsTableNames ? sameIdentifierFolded : sameIdentifierExactly
  const table = boundTables(visibleTables(plan, connectionName, qualifierMatches), column.slice(0, separator), qualifierMatches)[0]
  return table ? `${table.alias ?? table.tableName ?? plan.source.tableName}.${name}` : `${column.slice(0, separator)}.${name}`
}

export function assertGroupedOrderKeysUnshadowed(plan: SelectQueryPlan, context: GroupedKeyContext): void {
  for (const orderBy of plan.orderBy) {
    if (orderBy.kind !== 'column' || orderBy.column.includes('.') || dateBucketSelections(plan).has(orderBy.column)) continue
    const key = orderBy.column
    const names: IdentifierMatch = context.foldsColumnNames
      ? sameIdentifierFolded
      : (left, right) => truncatedIdentifier(left) === truncatedIdentifier(right)
    const shadowed = plan.selections.some((selection) => {
      if (selection.kind === 'raw' || selection.kind === 'date-bucket') return false
      if (selection.kind !== 'column') return names(selection.alias, key)
      return selection.alias !== undefined && names(selection.alias, key)
        && groupedCursorKey(plan, selection.column, context) !== groupedCursorKey(plan, key, context)
    })
    if (shadowed) {
      throw new SecurityError(`Cursor pagination cannot order grouped rows by "${key}" because a selected column of that name is not the grouped column.`)
    }
  }
}

export function bareColumnOwner(plan: SelectQueryPlan, name: string, connectionName: string | undefined, foldsColumnNames: boolean): string {
  const owner = columnOwner(plan, name, connectionName, foldsColumnNames ? sameIdentifierFolded : sameIdentifierExactly)
  if (owner === undefined) {
    throw new CompilerError(`Column "${name}" shares its name with a date bucket and doesn't belong to exactly one table of the same query. Qualify it with its table.`)
  }
  return owner
}

export function assertDateBucketSpelling(plan: SelectQueryPlan, dateBuckets: ReadonlyMap<string, QueryDateBucketSelection> = dateBucketSelections(plan)): void {
  const aliases = new Map([...dateBuckets.keys()].map(alias => [alias.toLowerCase(), alias]))
  if (aliases.size === 0) return
  const references = [
    ...plan.groupBy,
    ...plan.orderBy.flatMap(orderBy => orderBy.kind === 'column' ? [orderBy.column] : []),
    ...plan.having.map(clause => clause.expression.match(/^\w+\((\w+)\)$/)?.[1] ?? clause.expression),
  ]
  for (const reference of references) {
    const alias = aliases.get(reference.toLowerCase())
    if (alias !== undefined && alias !== reference) {
      throw new CompilerError(`Refer to the date bucket "${alias}" by its exact name, not "${reference}".`)
    }
  }
}

export function assertDateBucketOutputsUnshadowed(plan: SelectQueryPlan, connectionName: string | undefined, foldsIdentifiers: boolean): void {
  const sourceColumns = visibleTables(plan, connectionName)[0]!.columns() ?? []
  for (const alias of dateBucketSelections(plan).keys()) {
    if (sourceColumns.some(column => effectiveOutputName(column) === effectiveOutputName(alias))) {
      throw new SecurityError(`Date bucket alias "${alias}" must not reuse a column name of table "${plan.source.tableName}".`)
    }
    if (plan.selections.some(selection => selectionMayOutputName(plan, selection, alias, connectionName, { raw: true, wildcard: true }, foldsIdentifiers))) {
      throw new SecurityError(`Date bucket alias "${alias}" must not be reused by a wildcard or raw selection, and Holo can't verify the column names of raw selections or of wildcards of tables missing from the generated schema.`)
    }
  }
}

export function dateBucketStorage(plan: SelectQueryPlan, bucket: QueryDateBucketSelection, connectionName: string | undefined, foldsColumnNames: boolean): DateBucketStorage {
  const definition = bucketColumnDefinition(plan, bucket.column, connectionName, foldsColumnNames)
  if (!definition) {
    throw new ConfigurationError(`selectDate() can't tell whether "${bucket.column}" holds a date or a timestamp. Pass a table definition to DB.table() or generate the schema.`)
  }
  if (definition.kind === 'date') return 'calendar'
  if (definition.kind === 'datetime' || definition.kind === 'timestamp') return definition.kind
  throw new SecurityError(`selectDate() needs a date, datetime or timestamp column, but "${bucket.column}" is a ${definition.kind} column.`)
}

const UTC_TIME_ZONES: ReadonlySet<string> = new Set(['utc', 'etc/utc', 'etc/uct', 'etc/universal', 'etc/zulu', 'etc/gmt', 'etc/gmt0', 'etc/gmt+0', 'etc/gmt-0', 'etc/greenwich'])

export function mysqlTimeZoneName(timeZone: string): string {
  return UTC_TIME_ZONES.has(timeZone.toLowerCase()) ? '+00:00' : timeZone
}

function canonicalTimeZone(timeZone: string): string {
  const name = mysqlTimeZoneName(timeZone)
  if (name === '+00:00') return name
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone.toLowerCase()
  } catch {
    return name.toLowerCase()
  }
}

export function sameMySQLTimeZone(left: string, right: string): boolean {
  return canonicalTimeZone(left) === canonicalTimeZone(right)
}

type PlannedDateBucket = { readonly plan: SelectQueryPlan, readonly bucket: QueryDateBucketSelection }

function predicateDateBuckets(predicate: QueryPredicateNode): readonly PlannedDateBucket[] {
  if (predicate.kind === 'group') return predicate.predicates.flatMap(predicateDateBuckets)
  if (predicate.kind === 'exists' || predicate.kind === 'subquery') return planDateBuckets(predicate.subquery)
  return []
}

const plannedDateBucketIndex = new WeakMap<SelectQueryPlan, readonly PlannedDateBucket[]>()

export function planDateBuckets(plan: SelectQueryPlan): readonly PlannedDateBucket[] {
  const indexed = plannedDateBucketIndex.get(plan)
  if (indexed) return indexed
  const planned = [
    ...plan.selections.flatMap(selection => selection.kind === 'date-bucket'
      ? [{ plan, bucket: selection }]
      : selection.kind === 'subquery' ? planDateBuckets(selection.query) : []),
    ...plan.joins.flatMap(join => join.subquery ? planDateBuckets(join.subquery) : []),
    ...plan.unions.flatMap(union => planDateBuckets(union.query)),
    ...plan.predicates.flatMap(predicateDateBuckets),
  ]
  plannedDateBucketIndex.set(plan, planned)
  return planned
}
