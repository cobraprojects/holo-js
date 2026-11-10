import { createDialect, type DriverQueryResult } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { expect, onTestFinished } from 'vitest'
import { applyWireSnapshotPatch } from '../../src/client/patching'
import type { RealtimeSubscriptionPatchOperation, RealtimeSubscriptionPatch } from '../../src/runtime/state'
import type { RealtimeSubscriptionSnapshot } from '../../src/contracts'

type FixtureRow = Readonly<Record<string, string | number | boolean | null>>
type FixtureColumn = 'INTEGER' | 'REAL' | 'TEXT'

export async function createNativeRelationalAdapter(
  tables: Readonly<Record<string, readonly FixtureRow[]>>,
  definitions: Readonly<Record<string, Readonly<Record<string, FixtureColumn>>>> = {},
) {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const quote = createDialect('sqlite').quoteIdentifier
  for (const [tableName, rows] of Object.entries(tables)) {
    const names = [...new Set([...Object.keys(definitions[tableName] ?? {}), ...rows.flatMap(row => Object.keys(row))])]
    if (names.length === 0) throw new Error(`Native fixture ${tableName} requires column definitions.`)
    const columns = names.map(name => {
      const values = rows.map(row => row[name]).filter(value => value !== null && value !== undefined)
      const type = definitions[tableName]?.[name] ?? (values.every(value => typeof value === 'number' || typeof value === 'boolean')
        ? values.some(value => typeof value === 'number' && !Number.isInteger(value)) ? 'REAL' : 'INTEGER'
        : 'TEXT')
      return `${quote(name)} ${type}${name === 'id' ? ' PRIMARY KEY' : ''}`
    })
    await adapter.execute(`CREATE TABLE ${quote(tableName)} (${columns.join(', ')})`)
    for (const row of rows) {
      const keys = Object.keys(row)
      await adapter.execute(`INSERT INTO ${quote(tableName)} (${keys.map(quote).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(key => typeof row[key] === 'boolean' ? Number(row[key]) : row[key]))
    }
  }
  const queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  const executions: Array<{ sql: string, bindings: readonly unknown[] }> = []
  const query = adapter.query.bind(adapter)
  const execute = adapter.execute.bind(adapter)
  adapter.introspect = async <TRow extends Record<string, unknown>>(sql: string, bindings: readonly unknown[] = []): Promise<DriverQueryResult<TRow>> => query<TRow>(sql, bindings)
  adapter.query = async <TRow extends Record<string, unknown>>(sql: string, bindings: readonly unknown[] = []): Promise<DriverQueryResult<TRow>> => {
    queries.push({ sql, bindings })
    return query<TRow>(sql, bindings)
  }
  adapter.execute = async (sql, bindings = []) => {
    executions.push({ sql, bindings })
    return execute(sql, bindings)
  }
  return Object.assign(adapter, { queries, executions })
}

export function expectEquivalentWireOperations(
  previous: unknown,
  actual: readonly RealtimeSubscriptionPatchOperation[] | undefined,
  expected: readonly RealtimeSubscriptionPatchOperation[],
  current: unknown,
): void {
  const snapshot = { name: 'test', data: previous, dependencies: [], version: 0 }
  expect(actual ? applyWireSnapshotPatch(snapshot, { operations: actual, version: 1 }).data : current)
    .toEqual(applyWireSnapshotPatch(snapshot, { operations: expected, version: 1 }).data)
}

export function expectWireHistory(
  snapshots: readonly unknown[],
  patches: readonly { readonly operations: readonly RealtimeSubscriptionPatchOperation[], readonly version: number }[],
  expectedSnapshots: readonly unknown[],
  expectedOperations: readonly (readonly RealtimeSubscriptionPatchOperation[])[],
): void {
  const expected = [...expectedSnapshots]
  if (expectedOperations.length > 0) {
    for (const operations of expectedOperations) {
      expected.push(applyWireSnapshotPatch({ name: 'test', data: expected.at(-1), dependencies: [], version: 0 }, { operations, version: 1 }).data)
    }
  }
  const actual: unknown[] = []
  expect(new Set(patches.map(patch => patch.version)).size).toBe(patches.length)
  expect(patches.map(patch => patch.version)).toEqual(patches.map(patch => patch.version).sort((left, right) => left - right))
  let snapshotIndex = 0
  let patchIndex = 0
  for (let version = 1; version <= snapshots.length + patches.length; version += 1) {
    const patch = patches[patchIndex]
    if (patch?.version === version) {
      expect(version).toBeGreaterThan(1)
      actual.push(applyWireSnapshotPatch({ name: 'test', data: actual.at(-1), dependencies: [], version: version - 1 }, patch).data)
      patchIndex += 1
    } else {
      expect(snapshotIndex).toBeLessThan(snapshots.length)
      actual.push(snapshots[snapshotIndex])
      snapshotIndex += 1
    }
  }
  expect(patchIndex).toBe(patches.length)
  expect(actual).toEqual(expected)
}

export function observeWireSnapshots(snapshots: unknown[], patches: unknown[]) {
  let current: RealtimeSubscriptionSnapshot<unknown> | undefined
  return {
    onData(snapshot: RealtimeSubscriptionSnapshot<unknown>) {
      current = snapshot
      snapshots.push(snapshot.data)
    },
    onPatch(patch: RealtimeSubscriptionPatch) {
      patches.push(patch)
      if (!current) throw new Error('A wire patch requires its initial snapshot.')
      current = applyWireSnapshotPatch(current, patch)
      snapshots.push(current.data)
    },
  }
}
