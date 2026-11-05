import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import { createQueryCompiler } from './queryCompilerFactory'
import { splitTablePath } from '../schema/identifiers'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SelectQueryPlan, QueryPredicateNode } from './ast'

type TableIdentityRow = {
  readonly schema: string | null
  readonly name: string | null
  readonly bare_schema: string | null
}

type TableIdentityEntry = {
  readonly generation: number
  readonly identity: Promise<string>
}

const resolvedIdentities = new WeakMap<object, Map<string, TableIdentityEntry>>()
const canonicalNames = new Map<string, Map<string, string>>()

function ownerIdentities(connection: DatabaseContext): Map<string, TableIdentityEntry> {
  const owner = getRootDatabaseContext(connection)
  const existing = resolvedIdentities.get(owner)
  if (existing) return existing
  const created = new Map<string, TableIdentityEntry>()
  resolvedIdentities.set(owner, created)
  return created
}

function rememberCanonicalName(connectionName: string, tableName: string, identity: string): void {
  const names = canonicalNames.get(connectionName) ?? new Map<string, string>()
  names.set(tableName, identity)
  canonicalNames.set(connectionName, names)
}

function toCanonicalName(tableName: string, row: TableIdentityRow | undefined): string {
  if (!row?.schema || !row.name) return tableName
  const { table } = splitTablePath(tableName)
  return row.schema === row.bare_schema ? table : `${row.schema}.${table}`
}

async function lookupTableIdentity(connection: DatabaseContext, tableName: string): Promise<string> {
  const statement = createQueryCompiler(connection).compileTableIdentityLookup(tableName)
  if (!statement) return tableName
  const { rows } = await connection.queryCompiled<TableIdentityRow>(statement)
  return toCanonicalName(tableName, rows[0])
}

export function canonicalTableName(connectionName: string, tableName: string): string {
  return canonicalNames.get(connectionName)?.get(tableName) ?? tableName
}

export async function resolveTableIdentity(connection: DatabaseContext, tableName: string): Promise<string> {
  if (splitTablePath(tableName).schema === undefined) return tableName
  const identities = ownerIdentities(connection)
  const cached = identities.get(tableName)
  const entry = cached?.generation === currentSchemaGeneration()
    ? cached
    : { generation: currentSchemaGeneration(), identity: lookupTableIdentity(connection, tableName) }
  if (entry !== cached) {
    identities.set(tableName, entry)
    entry.identity.catch(() => {
      if (identities.get(tableName) === entry) identities.delete(tableName)
    })
  }
  const identity = await entry.identity
  rememberCanonicalName(connection.getConnectionName(), tableName, identity)
  return identity
}

function collectPredicateTables(predicate: QueryPredicateNode, tables: Set<string>, seen: Set<SelectQueryPlan>): void {
  if (predicate.kind === 'group') {
    for (const child of predicate.predicates) collectPredicateTables(child, tables, seen)
    return
  }
  if (predicate.kind === 'exists' || predicate.kind === 'subquery') collectPlanTables(predicate.subquery, tables, seen)
}

function collectPlanTables(plan: SelectQueryPlan, tables: Set<string>, seen: Set<SelectQueryPlan>): void {
  if (seen.has(plan)) return
  seen.add(plan)
  tables.add(plan.source.tableName)
  for (const join of plan.joins) {
    if (join.table) tables.add(join.table)
    if (join.subquery) collectPlanTables(join.subquery, tables, seen)
  }
  for (const union of plan.unions) collectPlanTables(union.query, tables, seen)
  for (const selection of plan.selections) {
    if (selection.kind === 'subquery') collectPlanTables(selection.query, tables, seen)
  }
  for (const predicate of plan.predicates) collectPredicateTables(predicate, tables, seen)
}

export async function resolvePlanTableIdentities(connection: DatabaseContext, plan: SelectQueryPlan): Promise<void> {
  const tables = new Set<string>()
  collectPlanTables(plan, tables, new Set())
  for (const tableName of tables) {
    await resolveTableIdentity(connection, tableName)
  }
}
