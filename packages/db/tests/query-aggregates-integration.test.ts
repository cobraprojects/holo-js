import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, resetDB } from '../src'
import { openDatabase } from './support/database'

function registerAggregateScenarios(driver: 'sqlite' | 'postgres' | 'mysql') {
  afterEach(() => resetDB())

  it('aggregates bigint and decimal columns the driver returns as text', async () => {
    const { schema } = await openDatabase(driver)
    const name = `aggregate_points_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.bigInteger('points')
      table.decimal('balance')
    })
    try {
      await DB.table(name).insert([{ points: 5, balance: '1.25' }, { points: 7, balance: '2.50' }])

      expect(await DB.table(name).sum('points')).toBe(12)
      expect(await DB.table(name).avg('points')).toBe(6)
      expect(await DB.table(name).min('balance')).toBe(1.25)
      expect(await DB.table(name).max('balance')).toBe(2.5)
    } finally {
      await schema.dropTable(name)
    }
  })

  it('rejects a column whose values are not numbers', async () => {
    const { schema } = await openDatabase(driver)
    const name = `aggregate_labels_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.string('label')
    })
    try {
      await DB.table(name).insert({ label: 'twelve' })

      await expect(DB.table(name).sum('label')).rejects.toThrow('Query aggregate "sum" requires numeric values for column "label".')
    } finally {
      await schema.dropTable(name)
    }
  })
}

describe('query-builder aggregates on sqlite', () => {
  registerAggregateScenarios('sqlite')
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('query-builder aggregates on postgres', () => {
  registerAggregateScenarios('postgres')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('query-builder aggregates on mysql', () => {
  registerAggregateScenarios('mysql')
})
