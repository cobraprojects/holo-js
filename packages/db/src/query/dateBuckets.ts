import { CapabilityError, SecurityError } from '../core/errors'
import { getApplicationTimezone } from '../applicationTimezone'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { QueryDateBucketSelection, QueryDateBucketUnit, QueryPredicateNode, SelectQueryPlan } from './ast'

const DATE_BUCKET_UNITS: ReadonlySet<string> = new Set<QueryDateBucketUnit>(['year', 'month', 'day', 'hour'])
const TIME_ZONE_NAME = /^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*$/

function isKnownTimeZone(timeZone: string): boolean {
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
  if (!TIME_ZONE_NAME.test(timeZone) || !isKnownTimeZone(timeZone)) {
    throw new SecurityError(`Date bucket time zone "${timeZone}" must be an IANA time zone name such as "UTC" or "Europe/Paris".`)
  }
}

export function mysqlTimeZoneName(timeZone: string): string {
  return timeZone === 'UTC' ? '+00:00' : timeZone
}

const convertibleMySQLTimeZones = new WeakMap<DatabaseContext, Set<string>>()

function predicateDateBuckets(predicate: QueryPredicateNode): readonly QueryDateBucketSelection[] {
  if (predicate.kind === 'group') return predicate.predicates.flatMap(predicateDateBuckets)
  if (predicate.kind === 'exists' || predicate.kind === 'subquery') return planDateBuckets(predicate.subquery)
  return []
}

function planDateBuckets(plan: SelectQueryPlan): readonly QueryDateBucketSelection[] {
  return [
    ...plan.selections.flatMap(selection => selection.kind === 'date-bucket'
      ? [selection]
      : selection.kind === 'subquery' ? planDateBuckets(selection.query) : []),
    ...plan.joins.flatMap(join => join.subquery ? planDateBuckets(join.subquery) : []),
    ...plan.unions.flatMap(union => planDateBuckets(union.query)),
    ...plan.predicates.flatMap(predicateDateBuckets),
  ]
}

function convertedMySQLTimeZones(plan: SelectQueryPlan): readonly string[] {
  const applicationTimeZone = getApplicationTimezone()
  const converted = planDateBuckets(plan).filter(bucket => !bucket.calendarDate && bucket.timeZone !== undefined && bucket.timeZone !== applicationTimeZone)
  const zones = new Set(converted.flatMap(bucket => [applicationTimeZone, bucket.timeZone!]))
  return [...zones].filter(zone => mysqlTimeZoneName(zone) === zone)
}

export async function assertDateBucketTimeZonesConvertible(connection: DatabaseContext, plan: SelectQueryPlan): Promise<void> {
  if (connection.getDialect().name !== 'mysql') return
  const known = convertibleMySQLTimeZones.get(connection) ?? new Set<string>()
  convertibleMySQLTimeZones.set(connection, known)
  for (const timeZone of convertedMySQLTimeZones(plan)) {
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
