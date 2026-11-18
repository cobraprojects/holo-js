import { CompilerError, ConfigurationError, SecurityError } from '../core/errors'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import { splitTablePath } from '../schema/identifiers'
import { knownJoinedColumns } from './modelRowProjection'
import type { TableDefinition } from '../schema/types'
import type { QueryDateBucketSelection, QueryDateBucketUnit, SelectQueryPlan } from './ast'

export type DateBucketStorage = 'calendar' | 'datetime' | 'timestamp'

const MAX_ALIAS_BYTES = 63
const DATE_BUCKET_UNITS: ReadonlySet<string> = new Set<QueryDateBucketUnit>(['year', 'month', 'day', 'hour'])
const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9]*(?:[/_+-][A-Za-z0-9]+)*$/

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

export function assertDateBucketAlias(alias: string): void {
  if (alias.length === 0 || new TextEncoder().encode(alias).length > MAX_ALIAS_BYTES) {
    throw new SecurityError(`Date bucket alias "${alias}" must be 1 to ${MAX_ALIAS_BYTES} bytes, the longest name PostgreSQL keeps.`)
  }
}

function isRegionTimeZone(timeZone: string): boolean {
  if (!TIME_ZONE_NAME.test(timeZone) || (timeZone !== 'UTC' && !timeZone.includes('/'))) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

type QueryTable = { readonly name: string | undefined, readonly definition: TableDefinition | undefined, readonly columns: readonly string[] | undefined }

function visibleName(tableName: string | undefined, alias: string | undefined): string | undefined {
  return alias ?? (tableName === undefined ? undefined : splitTablePath(tableName).table)
}

function queryTables(plan: SelectQueryPlan, connectionName: string): readonly QueryTable[] {
  const generated = (tableName: string | undefined) => tableName === undefined ? undefined : getConnectionGeneratedTableDefinition(tableName, connectionName)
  const sourceDefinition = plan.source.table ?? generated(plan.source.tableName)
  return [
    { name: visibleName(plan.source.tableName, plan.source.alias), definition: sourceDefinition, columns: sourceDefinition && Object.keys(sourceDefinition.columns) },
    ...plan.joins.map((join) => {
      const definition = join.subquery ? undefined : join.definition ?? generated(join.table)
      return { name: visibleName(join.table, join.alias), definition, columns: knownJoinedColumns(join, connectionName) }
    }),
  ]
}

export function queryColumnNames(plan: SelectQueryPlan, connectionName: string): readonly string[] {
  return queryTables(plan, connectionName).flatMap(table => table.columns ?? [])
}

export function dateBucketStorage(plan: SelectQueryPlan, bucket: QueryDateBucketSelection, connectionName: string): DateBucketStorage {
  const separator = bucket.column.lastIndexOf('.')
  const name = bucket.column.slice(separator + 1)
  const tables = queryTables(plan, connectionName)
  const qualifier = bucket.column.slice(0, separator)
  const owners = separator === -1
    ? tables.filter(table => table.columns === undefined || table.columns.includes(name))
    : tables.filter(table => table.name === qualifier || table.name === splitTablePath(qualifier).table)
  if (owners.length > 1) {
    throw new CompilerError(`selectDate() column "${bucket.column}" may belong to more than one table of the query. Qualify it with its table or alias.`)
  }
  const definition = owners[0]?.definition
  const column = definition && Object.hasOwn(definition.columns, name) ? definition.columns[name] : undefined
  if (!column) {
    throw new ConfigurationError(`selectDate() can't tell whether "${bucket.column}" holds a date or a timestamp. Pass a table definition to DB.table() or generate the schema.`)
  }
  if (column.kind === 'date') return 'calendar'
  if (column.kind === 'datetime' || column.kind === 'timestamp') return column.kind
  throw new SecurityError(`selectDate() needs a date, datetime or timestamp column, but "${bucket.column}" is a ${column.kind} column.`)
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
