import { afterEach, describe, expect, it } from 'vitest'
import { DB, SecurityError, defineModel, queryCacheInternals, resetDB } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

describe('aliased table joins', () => {
  afterEach(() => resetDB())

  it.each(integrationDrivers(['sqlite', 'postgres', 'mysql']))('self-joins a table through an alias on %s', async driver => {
    const { table } = await openDatabase(driver)
    const source = table.tableName
    await DB.table(table).insert([
      { id: 1, name: 'A', active: true },
      { id: 2, name: 'A', active: false },
      { id: 3, name: 'B', active: true },
    ])

    const pairs = await DB.table(table)
      .join(`${source} as twin`, `${source}.name`, '=', 'twin.name')
      .whereColumn(`${source}.id`, '<', 'twin.id')
      .select(`${source}.id`, 'twin.id as twinId', 'twin.name as twinName')
      .get()
    expect(pairs).toEqual([{ id: 1, twinId: 2, twinName: 'A' }])

    expect(await DB.table(table)
      .leftJoin(`${source} AS twin`, 'twin.id', '=', `${source}.id`)
      .rightJoin(`${source}   as   other`, 'other.id', '=', 'twin.id')
      .select('other.id as otherId')
      .orderBy('other.id')
      .get()).toEqual([{ otherId: 1 }, { otherId: 2 }, { otherId: 3 }])
    expect(await DB.table(table).crossJoin(`${source} as twin`).count()).toBe(9)

    const twins = await defineModel(table, { timestamps: false }).query()
      .join(`${source} as twin`, `${source}.name`, '=', 'twin.name')
      .whereColumn(`${source}.id`, '!=', 'twin.id')
      .select(`${source}.*`)
      .orderBy(`${source}.id`)
      .get()
    expect(twins.map(model => model.get('id'))).toEqual([1, 2])

    const collected = await queryCacheInternals.collectDatabaseQueryDependencies(() => DB.table(table)
      .join(`${source} as twin`, `${source}.id`, '=', 'twin.id')
      .count())
    expect(collected.value).toBe(3)
    expect(collected.dependencies).toEqual([`db:default:${source.split('.').at(-1)}`])
  })

  it.each(integrationDrivers(['sqlite', 'postgres', 'mysql']))('quotes the joined table and alias on %s', async driver => {
    const { table } = await openDatabase(driver)
    const quote = (value: string) => driver === 'mysql' ? `\`${value}\`` : `"${value}"`
    const reference = table.tableName.split('.').map(quote).join('.')

    expect(DB.table(table).join(`${table.tableName} as twin`, 'twin.id', '=', `${table.tableName}.id`).toSQL().sql)
      .toContain(`INNER JOIN ${reference} AS ${quote('twin')} ON ${quote('twin')}.${quote('id')}`)
    expect(DB.table(table).crossJoin(`${table.tableName} as twin`).toSQL().sql)
      .toContain(`CROSS JOIN ${reference} AS ${quote('twin')}`)
  })

  it('rejects aliases that are not plain identifiers', async () => {
    const { table } = await openDatabase('sqlite')
    for (const joined of [
      `${table.tableName} as bad alias`,
      `${table.tableName} as "twin"`,
      `${table.tableName} as twin; DROP TABLE x`,
      `${table.tableName} as 1twin`,
      `${table.tableName} as`,
      `as twin`,
      `${table.tableName} twin`,
    ]) {
      await expect(DB.table(table).join(joined, 'twin.id', '=', `${table.tableName}.id`).get(), joined).rejects.toThrow(SecurityError)
    }
  })
})
