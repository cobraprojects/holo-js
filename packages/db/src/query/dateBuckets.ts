import { CapabilityError, ConfigurationError, SecurityError } from '../core/errors'
import { getApplicationTimezone } from '../applicationTimezone'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import { qualifiesTable } from './modelRowProjection'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryDateBucketSelection, QueryDateBucketUnit, QueryPredicateNode, SelectQueryPlan } from './ast'

export type DateBucketStorage = 'calendar' | 'instant'

const DATE_BUCKET_UNITS: ReadonlySet<string> = new Set<QueryDateBucketUnit>(['year', 'month', 'day', 'hour'])
const TIME_ZONE_NAME = /^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/

function resolvedTimeZone(timeZone: string): string | undefined {
  if (!TIME_ZONE_NAME.test(timeZone)) return undefined
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
    return TIME_ZONE_NAME.test(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

export function assertDateBucketUnit(unit: string): asserts unit is QueryDateBucketUnit {
  if (!DATE_BUCKET_UNITS.has(unit)) {
    throw new SecurityError(`Date bucket unit "${unit}" is not one of year, month, day or hour.`)
  }
}

export function normalizeDateBucketTimeZone(timeZone: string): string {
  const resolved = resolvedTimeZone(timeZone)
  if (resolved === undefined) {
    throw new SecurityError(`Date bucket time zone "${timeZone}" must be an IANA time zone name such as "UTC" or "Europe/Paris".`)
  }
  return resolved
}

export function assertDateBucketTimeZone(timeZone: string): void {
  if (resolvedTimeZone(timeZone) !== timeZone) {
    throw new SecurityError(`Date bucket time zone "${timeZone}" must be a canonical IANA time zone name such as "UTC" or "Europe/Paris".`)
  }
}

function generatedDefinition(tableName: string | undefined, connectionName: string | undefined): TableDefinition | undefined {
  return tableName === undefined || connectionName === undefined ? undefined : getConnectionGeneratedTableDefinition(tableName, connectionName)
}

function bucketColumnDefinition(plan: SelectQueryPlan, column: string, connectionName: string | undefined): AnyColumnDefinition | undefined {
  const separator = column.lastIndexOf('.')
  const name = column.slice(separator + 1)
  const qualifier = separator === -1 ? undefined : column.slice(0, separator)
  const sourceTable = plan.source.table ?? generatedDefinition(plan.source.tableName, connectionName)
  const joinTables = plan.joins
    .filter(join => qualifier === undefined || qualifiesTable(qualifier, join.table, join.alias))
    .map(join => join.definition ?? generatedDefinition(join.table, connectionName))
  const tables = qualifier === undefined || qualifiesTable(qualifier, plan.source.tableName, plan.source.alias)
    ? [sourceTable, ...(qualifier === undefined ? joinTables : [])]
    : joinTables
  return tables.map(table => table?.columns[name]).find(definition => definition !== undefined)
}

export function dateBucketStorage(plan: SelectQueryPlan, bucket: QueryDateBucketSelection, connectionName: string | undefined): DateBucketStorage {
  const definition = bucketColumnDefinition(plan, bucket.column, connectionName)
  if (!definition) {
    throw new ConfigurationError(`selectDate() can't tell whether "${bucket.column}" holds a date or a timestamp. Pass a table definition to DB.table() or generate the schema.`)
  }
  if (definition.kind === 'date') return 'calendar'
  if (definition.kind === 'datetime' || definition.kind === 'timestamp') return 'instant'
  throw new SecurityError(`selectDate() needs a date, datetime or timestamp column, but "${bucket.column}" is a ${definition.kind} column.`)
}

export function mysqlTimeZoneName(timeZone: string): string {
  return timeZone === 'UTC' ? '+00:00' : timeZone
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
  const converted = planDateBuckets(plan)
    .filter(({ plan: owner, bucket }) => bucket.timeZone !== undefined && bucket.timeZone !== applicationTimeZone && dateBucketStorage(owner, bucket, connectionName) === 'instant')
  const zones = new Set(converted.flatMap(({ bucket }) => [applicationTimeZone, bucket.timeZone!]))
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
