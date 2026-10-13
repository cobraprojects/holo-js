import { afterEach, describe, expect, it } from 'vitest'
import { DB, defineModel, queryCacheInternals, resetDB } from '../src'
import type { QuerySuccessLog } from '../src/core/types'
import { openDatabase } from './support/database'

describe('database count and existence', () => {
  afterEach(() => resetDB())

  it.each(['sqlite', 'postgres', 'mysql'] as const)('returns only aggregate results on %s and preserves query cardinality', async driver => {
    const logs: QuerySuccessLog[] = []
    const { table } = await openDatabase(driver, {
      logger: { onQuerySuccess: entry => { logs.push(entry) } },
      security: { debugSqlInLogs: true },
    })
    const query = DB.table(table)
    await query.insert([
      { id: 1, name: 'A', active: true },
      { id: 2, name: 'A', active: true },
      { id: 3, name: 'B', active: false },
      { id: 4, name: 'C', active: false },
    ])
    logs.length = 0
    expect(await query.count()).toBe(4)
    expect(logs.at(-1)?.rowCount).toBe(1)
    expect(logs.at(-1)?.sql).toMatch(/^SELECT COUNT\(\*\)/)
    expect(await query.exists()).toBe(true)
    expect(logs.at(-1)?.sql).toMatch(/^SELECT EXISTS/)
    expect(await query.where('id', 9).doesntExist()).toBe(true)
    expect(await defineModel(table, { timestamps: false }).query().count()).toBe(4)
    expect(await query.select('name').distinct().count()).toBe(3)
    expect(await query.select('name').addSelectCount('quantity').groupBy('name').having('count(*)', '>', 1).count()).toBe(1)
    expect(await query.where('id', '<', 3).union(query.where('id', '>', 2)).count()).toBe(4)
    expect(await query.orderBy('id').offset(2).limit(1).count()).toBe(1)
    expect(await query.limit(100).offset(9).exists()).toBe(false)
    expect(await query.limit(0).exists()).toBe(false)
    const excluded = query.select('name').where('active', true)
    expect(await query.select('name').distinct().whereNotInSub('name', excluded).count()).toBe(2)
    expect(await query.whereNotExists(query.where('id', 9)).count()).toBe(4)
    expect(await query.joinSub(query.select('name'), 'right_items', `${table.tableName}.name`, '=', 'right_items.name').select('id').count()).toBe(6)
    expect(await query.joinSub(query, 'right_items', `${table.tableName}.name`, '=', 'right_items.name').count()).toBe(6)
    expect(await query.joinSub(query, 'right_items', `${table.tableName}.name`, '=', 'right_items.name').limit(2).offset(1).count()).toBe(2)
    expect(logs.map(entry => entry.rowCount)).toEqual(Array(logs.length).fill(1))
    const collected = await queryCacheInternals.collectDatabaseQueryDependencies(async () => ({
      count: await query.where('active', true).count(),
      exists: await query.where('active', true).exists(),
      absent: await query.where('active', true).doesntExist(),
    }))
    expect(collected.value).toEqual({ count: 2, exists: true, absent: false })
    expect(collected.queries.map(entry => ({ result: entry.result, aggregate: entry.aggregate }))).toEqual([
      { result: 2, aggregate: { kind: 'count' } },
      { result: true, aggregate: { kind: 'count', count: 2, output: 'boolean' } },
      { result: false, aggregate: { kind: 'count', count: 2, output: 'inverseBoolean' } },
    ])
  })
})
