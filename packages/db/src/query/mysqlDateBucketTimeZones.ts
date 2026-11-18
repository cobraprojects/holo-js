import { CapabilityError } from '../core/errors'
import { getApplicationTimezone } from '../applicationTimezone'
import type { DatabaseContext } from '../core/DatabaseContext'
import { isEmittingQueryLog } from '../core/queryLogScope'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentPinnedConnection } from '../concurrency/pinnedConnection'
import { dateBucketStorage, mysqlTimeZoneName, planDateBuckets, planHasDateBuckets, sameMySQLTimeZone } from './dateBuckets'
import type { SelectQueryPlan } from './ast'

const convertibleMySQLTimeZones = new WeakMap<DatabaseContext, Set<string>>()
const inFlightMySQLTimeZoneChecks = new WeakMap<object, Map<string, Promise<void>>>()

function convertedMySQLTimeZones(plan: SelectQueryPlan, connectionName: string): readonly string[] {
  const applicationTimeZone = getApplicationTimezone()
  const zones = new Set(planDateBuckets(plan).flatMap(({ plan: owner, bucket }) => {
    const timeZone = bucket.timeZone ?? applicationTimeZone
    const storage = dateBucketStorage(owner, bucket, connectionName, true)
    if (storage === 'timestamp') return [timeZone]
    return storage === 'datetime' && !sameMySQLTimeZone(timeZone, applicationTimeZone) ? [applicationTimeZone, timeZone] : []
  }))
  return [...zones].filter(zone => mysqlTimeZoneName(zone) === zone)
}

export async function assertDateBucketTimeZonesConvertible(connection: DatabaseContext, plan: SelectQueryPlan): Promise<void> {
  if (connection.getDialect().name !== 'mysql' || !planHasDateBuckets(plan)) return
  const root = getRootDatabaseContext(connection)
  const convertible = convertibleMySQLTimeZones.get(root) ?? new Set<string>()
  convertibleMySQLTimeZones.set(root, convertible)
  const zones = convertedMySQLTimeZones(plan, connection.getConnectionName()).filter(zone => !convertible.has(zone))
  if (zones.length === 0) return
  if (isEmittingQueryLog()) {
    await Promise.all(checkMySQLTimeZones(connection, zones, convertible).values())
    return
  }
  const scope: object = currentRootTransaction(connection) ?? currentPinnedConnection(connection.getAdapter()) ?? connection
  const inFlight = inFlightMySQLTimeZoneChecks.get(scope) ?? new Map<string, Promise<void>>()
  inFlightMySQLTimeZoneChecks.set(scope, inFlight)
  const unchecked = zones.filter(zone => !inFlight.has(zone))
  for (const [zone, check] of checkMySQLTimeZones(connection, unchecked, convertible)) {
    inFlight.set(zone, check)
    check.then(() => inFlight.delete(zone), () => inFlight.delete(zone))
  }
  await Promise.all(zones.map(zone => inFlight.get(zone)))
}

function checkMySQLTimeZones(connection: DatabaseContext, zones: readonly string[], convertible: Set<string>): ReadonlyMap<string, Promise<void>> {
  if (zones.length === 0) return new Map()
  const probe = probeMySQLTimeZones(connection, zones)
  return new Map(zones.map(zone => [zone, probe.then((missing) => {
    if (missing.includes(zone)) {
      throw new CapabilityError(`MySQL can't convert dates to the "${zone}" time zone because its time zone tables are empty. Load them with mysql_tzinfo_to_sql.`)
    }
    convertible.add(zone)
  })]))
}

async function probeMySQLTimeZones(connection: DatabaseContext, zones: readonly string[]): Promise<readonly string[]> {
  const { rows } = await connection.queryCompiled<Record<string, unknown>>({
    sql: `SELECT ${zones.map((_zone, index) => `CONVERT_TZ('2000-01-01 00:00:00', '+00:00', ?) AS \`zone_${index}\``).join(', ')}`,
    bindings: zones,
    source: 'query:date-bucket-time-zone',
  })
  return zones.filter((_zone, index) => rows[0]?.[`zone_${index}`] == null)
}
