import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DB,
  column,
  configureDB,
  createConnectionManager,
  createDialect,
  resetDB,
} from '../src'
import { defineTable } from './support/internal'

describe('JSON null query semantics', () => {
  afterEach(() => {
    resetDB()
  })

  it('matches explicit SQLite JSON null values without matching missing paths', async () => {
    const adapter = createSQLiteAdapter()
    await adapter.initialize()

    try {
      await adapter.execute('CREATE TABLE documents (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, marker TEXT NOT NULL)')
      await adapter.execute(
        'INSERT INTO documents (id, settings, marker) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)',
        [
          1,
          '{"profile":{"region":null}}',
          'original',
          2,
          '{"profile":{}}',
          'original',
          3,
          '{"profile":{"region":"eu"}}',
          'original',
          4,
          '{}',
          'original',
        ],
      )

      configureDB(createConnectionManager({
        defaultConnection: 'default',
        connections: {
          default: {
            adapter,
            dialect: createDialect('sqlite'),
          },
        },
      }))

      const documents = defineTable('documents', {
        id: column.id(),
        settings: column.json(),
        marker: column.string(),
      })

      const explicitNullRows = await DB.table(documents)
        .select('id')
        .whereJson('settings->profile->region', '=', null)
        .get()
      expect(explicitNullRows).toEqual([{ id: 1 }])

      const nonNullRows = await DB.table(documents)
        .select('id')
        .whereJson('settings->profile->region', '!=', null)
        .get()
      expect(nonNullRows).toEqual([{ id: 3 }])

      const updateResult = await DB.table(documents)
        .whereJson('settings->profile->region', '=', null)
        .update({ marker: 'matched' })
      expect(updateResult.affectedRows).toBe(1)
      expect((await adapter.query<{ id: number, marker: string }>(
        'SELECT id, marker FROM documents ORDER BY id',
      )).rows).toEqual([
        { id: 1, marker: 'matched' },
        { id: 2, marker: 'original' },
        { id: 3, marker: 'original' },
        { id: 4, marker: 'original' },
      ])

      const deleteResult = await DB.table(documents)
        .whereJson('settings->profile->region', '=', null)
        .delete()
      expect(deleteResult.affectedRows).toBe(1)
      expect((await adapter.query<{ id: number }>('SELECT id FROM documents ORDER BY id')).rows).toEqual([
        { id: 2 },
        { id: 3 },
        { id: 4 },
      ])
    } finally {
      await adapter.disconnect()
    }
  })

  it('keeps SQLite JSON scalar equality type-exact', async () => {
    const adapter = createSQLiteAdapter()
    await adapter.initialize()

    try {
      await adapter.execute('CREATE TABLE documents (id INTEGER PRIMARY KEY, settings TEXT NOT NULL)')
      await adapter.execute(
        'INSERT INTO documents (id, settings) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)',
        [
          1,
          '{"value":true}',
          2,
          '{"value":1}',
          3,
          '{"value":"1"}',
          4,
          '{"value":false}',
          5,
          '{"value":null}',
          6,
          '{}',
        ],
      )

      configureDB(createConnectionManager({
        defaultConnection: 'default',
        connections: {
          default: {
            adapter,
            dialect: createDialect('sqlite'),
          },
        },
      }))

      const documents = defineTable('documents', {
        id: column.id(),
        settings: column.json(),
      })

      await expect(DB.table(documents).select('id').whereJson('settings->value', true).get()).resolves.toEqual([{ id: 1 }])
      await expect(DB.table(documents).select('id').whereJson('settings->value', 1).get()).resolves.toEqual([{ id: 2 }])
      await expect(DB.table(documents).select('id').whereJson('settings->value', '1').get()).resolves.toEqual([{ id: 3 }])
      await expect(DB.table(documents).select('id').whereJson('settings->value', false).get()).resolves.toEqual([{ id: 4 }])
      await expect(DB.table(documents).select('id').whereJson('settings->value', '!=', true).get()).resolves.toEqual([
        { id: 2 },
        { id: 3 },
        { id: 4 },
        { id: 5 },
      ])
    } finally {
      await adapter.disconnect()
    }
  })
})
