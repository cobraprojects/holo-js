import { afterEach, describe, expect, it, vi } from 'vitest'
import { DB, createDialect, resetDB } from '@holo-js/db'
import { replayRanMigrationsInDryRunScope } from '../src/runtime-schema-hydration'

afterEach(() => {
  resetDB()
})

describe('runtime schema hydration', () => {
  it('routes documented DB facade writes to the dry-run connection and restores the scope', async () => {
    const executeCompiled = vi.fn(async () => ({ affectedRows: 0 }))
    const dryRunConnection = {
      getConnectionName: () => 'main',
      getDriver: () => 'sqlite',
      getDialect: () => createDialect('sqlite'),
      executeCompiled,
    }

    await replayRanMigrationsInDryRunScope(
      dryRunConnection as never,
      [{
        name: '2026_07_19_120000_create_rooms',
        async up() {
          await DB.table('rooms').insert({ slug: 'general' })
        },
      }],
      new Set(['2026_07_19_120000_create_rooms']),
      {},
    )

    expect(executeCompiled).toHaveBeenCalledOnce()
    expect(executeCompiled).toHaveBeenCalledWith(expect.objectContaining({
      bindings: ['general'],
      sql: 'INSERT INTO "rooms" ("slug") VALUES (?)',
    }))
    expect(() => DB.connection()).toThrow('DB facade is not configured with a ConnectionManager.')
  })

  it('restores the DB facade scope when migration replay fails', async () => {
    const dryRunConnection = {
      getConnectionName: () => 'main',
    }

    await expect(replayRanMigrationsInDryRunScope(
      dryRunConnection as never,
      [{
        name: '2026_07_19_120000_broken',
        up() {
          expect(DB.connection()).toBe(dryRunConnection)
          throw new Error('replay failed')
        },
      }],
      new Set(['2026_07_19_120000_broken']),
      {},
    )).rejects.toThrow('replay failed')

    expect(() => DB.connection()).toThrow('DB facade is not configured with a ConnectionManager.')
  })
})
