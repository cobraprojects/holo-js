import { CapabilityError, CompilerError, ConfigurationError, SecurityError } from '../core/errors'
import { getApplicationTimezone } from '../applicationTimezone'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import { splitTablePath } from '../schema/identifiers'
import { knownJoinedColumns, knownTableColumns } from './modelRowProjection'
import { dateBucketSelections, readAllColumnsSelectionTable } from './ast'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryDateBucketSelection, QueryDateBucketUnit, QueryPredicateNode, SelectQueryPlan } from './ast'

export type DateBucketStorage = 'calendar' | 'datetime' | 'timestamp'

const MAX_ALIAS_BYTES = 63

export function effectiveOutputName(name: string): string {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length <= MAX_ALIAS_BYTES) return name.toLowerCase()
  let end = MAX_ALIAS_BYTES
  while (end > 0 && (bytes[end]! & 0xC0) === 0x80) end -= 1
  return new TextDecoder().decode(bytes.slice(0, end)).toLowerCase()
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

function isVisibleAs(qualifier: string, { tableName, alias }: VisibleTable): boolean {
  if (alias !== undefined) return qualifier === alias
  return tableName !== undefined && (qualifier === tableName || qualifier === splitTablePath(tableName).table)
}

function matchingColumnDefinition(table: TableDefinition | undefined, name: string, matches: IdentifierMatch): AnyColumnDefinition | undefined {
  if (!table) return undefined
  const key = Object.keys(table.columns).find(column => matches(column, name))
  return key === undefined ? undefined : table.columns[key]
}

function visibleTables(plan: SelectQueryPlan, connectionName: string | undefined): readonly VisibleTable[] {
  return [
    {
      tableName: plan.source.tableName,
      alias: plan.source.alias,
      definition: plan.source.table ?? generatedDefinition(plan.source.tableName, connectionName),
      columns: () => connectionName === undefined ? undefined : knownTableColumns(plan.source.tableName, plan.source.table, connectionName),
    },
    ...plan.joins.map(join => ({
      tableName: join.table,
      alias: join.alias,
      definition: join.definition ?? generatedDefinition(join.table, connectionName),
      columns: () => join.subquery ? explicitOutputNames(join.subquery) : connectionName === undefined ? undefined : knownJoinedColumns(join, connectionName),
    })),
  ]
}

function explicitOutputNames(plan: SelectQueryPlan): readonly string[] | undefined {
  const names = plan.selections.map((selection) => {
    if (selection.kind === 'raw') return undefined
    if (selection.kind !== 'column') return selection.alias
    if (selection.alias) return selection.alias
    if (selection.column === '*' || readAllColumnsSelectionTable(selection.column) !== undefined) return undefined
    return selection.column.slice(selection.column.lastIndexOf('.') + 1)
  })
  if (plan.selections.length === 0 || names.some(name => name === undefined)) return undefined
  return names.filter((name): name is string => name !== undefined)
}

function boundTables(visible: readonly VisibleTable[], qualifier: string | undefined): readonly VisibleTable[] {
  return qualifier === undefined ? visible : visible.filter(table => isVisibleAs(qualifier, table))
}

function bucketColumnDefinition(plan: SelectQueryPlan, column: string, connectionName: string | undefined): AnyColumnDefinition | undefined {
  const separator = column.lastIndexOf('.')
  const name = column.slice(separator + 1)
  const qualifier = separator === -1 ? undefined : column.slice(0, separator)
  const tables = boundTables(visibleTables(plan, connectionName), qualifier)
  const find = (matches: IdentifierMatch) => tables
    .map(table => matchingColumnDefinition(table.definition, name, matches))
    .find(definition => definition !== undefined)
  return find(sameIdentifierExactly) ?? find(sameIdentifierFolded)
}

export function selectionMayOutputName(
  plan: SelectQueryPlan,
  selection: SelectQueryPlan['selections'][number],
  name: string,
  connectionName: string | undefined,
  unknown: { readonly raw: boolean, readonly wildcard: boolean },
): boolean {
  if (selection.kind === 'raw') return unknown.raw
  if (selection.kind !== 'column' || selection.alias) return false
  const wildcardTable = selection.column === '*' ? undefined : readAllColumnsSelectionTable(selection.column)
  if (selection.column !== '*' && wildcardTable === undefined) return false
  const tables = boundTables(visibleTables(plan, connectionName), wildcardTable)
  if (tables.length === 0) return unknown.wildcard
  return tables
    .some((table) => {
      const columns = table.columns()
      return columns === undefined ? unknown.wildcard : columns.some(column => effectiveOutputName(column) === effectiveOutputName(name))
    })
}

export function columnOwner(plan: SelectQueryPlan, name: string, connectionName: string | undefined, matches: IdentifierMatch = sameIdentifierFolded): string | undefined {
  const candidates = visibleTables(plan, connectionName).filter((table) => {
    const columns = table.columns()
    return columns === undefined || columns.some(column => matches(column, name))
  })
  const owner = candidates.length === 1 ? candidates[0] : undefined
  return owner && (owner.alias ?? owner.tableName ?? plan.source.tableName)
}

export type GroupedKeyContext = { readonly connectionName: string | undefined, readonly foldsColumnNames: boolean }

export function groupedCursorKey(plan: SelectQueryPlan, column: string, context: GroupedKeyContext): string {
  if (dateBucketSelections(plan).has(column)) return column
  const { connectionName } = context
  const separator = column.lastIndexOf('.')
  const name = context.foldsColumnNames ? column.slice(separator + 1).toLowerCase() : column.slice(separator + 1)
  if (separator === -1) {
    const owner = columnOwner(plan, column, connectionName, context.foldsColumnNames ? sameIdentifierFolded : sameIdentifierExactly)
    return owner === undefined ? name : `${owner}.${name}`
  }
  const table = boundTables(visibleTables(plan, connectionName), column.slice(0, separator))[0]
  return table ? `${table.alias ?? table.tableName ?? plan.source.tableName}.${name}` : `${column.slice(0, separator)}.${name}`
}

export function assertGroupedOrderKeysUnshadowed(plan: SelectQueryPlan, context: GroupedKeyContext): void {
  for (const orderBy of plan.orderBy) {
    if (orderBy.kind !== 'column' || orderBy.column.includes('.') || dateBucketSelections(plan).has(orderBy.column)) continue
    const key = orderBy.column
    const shadowed = plan.selections.some((selection) => {
      if (selection.kind === 'raw' || selection.kind === 'date-bucket') return false
      if (selection.kind !== 'column') return sameIdentifierFolded(selection.alias, key)
      return selection.alias !== undefined && sameIdentifierFolded(selection.alias, key)
        && groupedCursorKey(plan, selection.column, context) !== groupedCursorKey(plan, key, context)
    })
    if (shadowed) {
      throw new SecurityError(`Cursor pagination cannot order grouped rows by "${key}" because a selected column of that name is not the grouped column.`)
    }
  }
}

export function bareColumnOwner(plan: SelectQueryPlan, name: string, connectionName: string | undefined): string {
  const owner = columnOwner(plan, name, connectionName)
  if (owner === undefined) {
    throw new CompilerError(`Column "${name}" shares its name with a date bucket and Holo can't tell which table owns it. Qualify it with its table.`)
  }
  return owner
}

export function assertDateBucketSpelling(plan: SelectQueryPlan): void {
  const aliases = new Map([...dateBucketSelections(plan).keys()].map(alias => [alias.toLowerCase(), alias]))
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

export function assertDateBucketOutputsUnshadowed(plan: SelectQueryPlan, connectionName: string | undefined): void {
  const sourceColumns = visibleTables(plan, connectionName)[0]!.columns() ?? []
  for (const alias of dateBucketSelections(plan).keys()) {
    if (sourceColumns.some(column => sameIdentifierFolded(column, alias))) {
      throw new SecurityError(`Date bucket alias "${alias}" must not reuse a column name of table "${plan.source.tableName}".`)
    }
    if (plan.selections.some(selection => selectionMayOutputName(plan, selection, alias, connectionName, { raw: true, wildcard: true }))) {
      throw new SecurityError(`Date bucket alias "${alias}" must not be reused by a wildcard or raw selection, and Holo can't verify the column names of raw selections or of wildcards of tables missing from the generated schema.`)
    }
  }
}

export function dateBucketStorage(plan: SelectQueryPlan, bucket: QueryDateBucketSelection, connectionName: string | undefined): DateBucketStorage {
  const definition = bucketColumnDefinition(plan, bucket.column, connectionName)
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

export function sameMySQLTimeZone(left: string, right: string): boolean {
  return mysqlTimeZoneName(left) === mysqlTimeZoneName(right)
}

const convertibleMySQLTimeZones = new WeakMap<DatabaseContext, Set<string>>()

type PlannedDateBucket = { readonly plan: SelectQueryPlan, readonly bucket: QueryDateBucketSelection }

function predicateDateBuckets(predicate: QueryPredicateNode): readonly PlannedDateBucket[] {
  if (predicate.kind === 'group') return predicate.predicates.flatMap(predicateDateBuckets)
  if (predicate.kind === 'exists' || predicate.kind === 'subquery') return planDateBuckets(predicate.subquery)
  return []
}

function planDateBuckets(plan: SelectQueryPlan): readonly PlannedDateBucket[] {
  return [
    ...plan.selections.flatMap(selection => selection.kind === 'date-bucket'
      ? [{ plan, bucket: selection }]
      : selection.kind === 'subquery' ? planDateBuckets(selection.query) : []),
    ...plan.joins.flatMap(join => join.subquery ? planDateBuckets(join.subquery) : []),
    ...plan.unions.flatMap(union => planDateBuckets(union.query)),
    ...plan.predicates.flatMap(predicateDateBuckets),
  ]
}

function convertedMySQLTimeZones(plan: SelectQueryPlan, connectionName: string): readonly string[] {
  const applicationTimeZone = getApplicationTimezone()
  const zones = new Set(planDateBuckets(plan).flatMap(({ plan: owner, bucket }) => {
    const timeZone = bucket.timeZone ?? applicationTimeZone
    const storage = dateBucketStorage(owner, bucket, connectionName)
    if (storage === 'timestamp') return [timeZone]
    return storage === 'datetime' && !sameMySQLTimeZone(timeZone, applicationTimeZone) ? [applicationTimeZone, timeZone] : []
  }))
  return [...zones].filter(zone => mysqlTimeZoneName(zone) === zone)
}

export async function assertDateBucketTimeZonesConvertible(connection: DatabaseContext, plan: SelectQueryPlan): Promise<void> {
  if (connection.getDialect().name !== 'mysql') return
  const known = convertibleMySQLTimeZones.get(connection) ?? new Set<string>()
  convertibleMySQLTimeZones.set(connection, known)
  for (const timeZone of convertedMySQLTimeZones(plan, connection.getConnectionName())) {
    if (known.has(timeZone)) continue
    const { rows } = await connection.queryCompiled<{ converted: unknown }>({
      sql: 'SELECT CONVERT_TZ(\'2000-01-01 00:00:00\', \'+00:00\', ?) AS converted',
      bindings: [timeZone],
      source: 'query:date-bucket-time-zone',
    })
    if (rows[0]?.converted == null) {
      throw new CapabilityError(`MySQL can't convert dates to the "${timeZone}" time zone because its time zone tables are empty. Load them with mysql_tzinfo_to_sql.`)
    }
    known.add(timeZone)
  }
}
