import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, defineGeneratedTable, resetDB } from '../src'
import { openDatabase } from './support/database'

afterEach(() => {
  resetConfigRuntime()
  resetDB()
})

describe('Date values in date predicates', () => {
  it('finds a stored DATE row by the same Date before year 1 on SQLite', async () => {
    configureConfigRuntime({ app: { timezone: 'UTC' } } as never)
    const { schema } = await openDatabase('sqlite')
    await schema.createTable('bc_rows', (table) => {
      table.id()
      table.date('day')
    })
    const rows = defineGeneratedTable('bc_rows', { id: column.id(), day: column.date() })
    const yearZero = new Date('0000-06-15T12:00:00Z')
    const yearMinusOne = new Date('-000001-06-15T12:00:00Z')
    await DB.table(rows).insert({ day: yearZero })
    await DB.table(rows).insert({ day: yearMinusOne })

    await expect(DB.table(rows).where('day', yearZero).pluck('id')).resolves.toEqual([1])
    await expect(DB.table(rows).where('day', yearMinusOne).pluck('id')).resolves.toEqual([2])
    await expect(DB.table(rows).whereIn('day', [yearZero, yearMinusOne]).orderBy('id').pluck('id')).resolves.toEqual([1, 2])
  })


  it('leaves a Date before year 1 to the dialect instead of formatting a calendar date it cannot read', async () => {
    configureConfigRuntime({ app: { timezone: 'UTC' } } as never)
    await openDatabase('sqlite')
    const events = defineGeneratedTable('bc_events', { id: column.id(), day: column.date() })
    const yearZero = new Date('0000-06-15T12:00:00Z')
    const yearMinusOne = new Date('-000001-06-15T12:00:00Z')

    const bindingsOf = (query: { toSQL(): { bindings?: readonly unknown[] } }) => query.toSQL().bindings ?? []
    for (const value of [yearZero, yearMinusOne]) {
      expect(bindingsOf(DB.table(events).where('day', value))).not.toContain('0000-06-15')
      expect(bindingsOf(DB.table(events).where('day', value)).every(binding => typeof binding !== 'string' || !binding.includes('-1-06'))).toBe(true)
      for (const part of ['whereDate', 'whereYear', 'whereMonth', 'whereDay', 'whereTime'] as const) {
        const [binding] = bindingsOf(DB.table(events)[part]('day', value))
        expect(Number.isNaN(binding)).toBe(false)
        expect(binding).not.toBe('0000-06-15')
      }
    }
  })
})
