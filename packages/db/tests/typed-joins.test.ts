import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, configureDB, createConnectionManager, createDialect, defineGeneratedTable, resetDB } from '../src'

describe('typed table joins', () => {
  afterEach(() => {
    resetDB()
  })

  it('returns selected joined values and outer-join nulls in one query', async () => {
    const adapter = createSQLiteAdapter()
    await adapter.initialize()

    try {
      await adapter.execute('CREATE TABLE members (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL)')
      await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      await adapter.execute('INSERT INTO members VALUES (1, 10), (2, 99)')
      await adapter.execute("INSERT INTO users VALUES (10, 'Ava'), (20, 'Sam')")
      let queryCount = 0
      configureDB(createConnectionManager({
        defaultConnection: 'default',
        connections: {
          default: {
            adapter,
            dialect: createDialect('sqlite'),
            logger: {
              onQuerySuccess() {
                queryCount += 1
              },
            },
          },
        },
      }))
      const members = defineGeneratedTable('members', { id: column.id(), userId: column.integer() })
      const users = defineGeneratedTable('users', { id: column.id(), name: column.string() })

      const rows = await DB.table(members)
        .join(users, 'members.userId', '=', 'users.id')
        .select('members.id')
        .addSelect('users.name as userName')
        .where('users.name', 'Ava')
        .orderBy('members.id')
        .get()
      expect(rows).toEqual([{ id: 1, userName: 'Ava' }])
      expect(queryCount).toBe(1)

      const leftRows = await DB.table(members)
        .leftJoin(users, 'members.userId', '=', 'users.id')
        .select('members.id', 'users.name as userName')
        .orderBy('members.id')
        .get()
      expect(leftRows).toEqual([{ id: 1, userName: 'Ava' }, { id: 2, userName: null }])
      expect(queryCount).toBe(2)

      const rightRows = await DB.table(members)
        .rightJoin(users, 'members.userId', '=', 'users.id')
        .select('members.id', 'users.name as userName')
        .orderBy('users.id')
        .get()
      expect(rightRows).toEqual([{ id: 1, userName: 'Ava' }, { id: null, userName: 'Sam' }])
      expect(queryCount).toBe(3)
    } finally {
      await adapter.disconnect()
    }
  })
})
