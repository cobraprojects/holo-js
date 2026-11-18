import { CapabilityError } from '../core/errors'
import { getApplicationTimezone } from '../applicationTimezone'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { dateBucketStorage, mysqlTimeZoneName, sameMySQLTimeZone } from './dateBuckets'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { QueryDateBucketSelection, QueryPredicateNode, SelectQueryPlan } from './ast'

const convertibleTimeZones = new WeakMap<DatabaseContext, Set<string>>()

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

function convertedTimeZones(plan: SelectQueryPlan, connectionName: string): readonly string[] {
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
  const root = getRootDatabaseContext(connection)
  const convertible = convertibleTimeZones.get(root) ?? new Set<string>()
  convertibleTimeZones.set(root, convertible)
  const unchecked = convertedTimeZones(plan, connection.getConnectionName()).filter(zone => !convertible.has(zone))
  if (unchecked.length === 0) return
  const { rows } = await connection.queryCompiled<Record<string, unknown>>({
    sql: `SELECT ${unchecked.map((_zone, index) => `CONVERT_TZ('2000-01-01 00:00:00', '+00:00', ?) AS \`zone_${index}\``).join(', ')}`,
    bindings: unchecked,
    source: 'query:date-bucket-time-zone',
  })
  for (const [index, zone] of unchecked.entries()) {
    if (rows[0]?.[`zone_${index}`] == null) {
      throw new CapabilityError(`MySQL can't convert dates to the "${zone}" time zone because its time zone tables are empty. Load them with mysql_tzinfo_to_sql.`)
    }
    convertible.add(zone)
  }
}
