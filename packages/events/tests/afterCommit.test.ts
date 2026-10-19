import { createSQLiteAdapter } from '../../db-sqlite/src'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  DB,
  configureDB,
  createConnectionManager,
  resetDB,
  createDatabase,
  createDialect,
  createSchemaService,
} from '@holo-js/db'
import {
  configureEventsRuntime,
  defineEvent,
  defineListener,
  dispatchEvent,
  registerEvent,
  registerListener,
  resetEventsRegistry,
  resetEventsRuntime,
} from '../src'

async function configureTestDB() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  await createSchemaService(db).createTable('event_records', table => {
    table.id()
    table.string('user_id')
  })
  return db
}

afterEach(() => {
  resetEventsRegistry()
  resetEventsRuntime()
  resetDB()
})

describe('@holo-js/events afterCommit integration', () => {
  it('keeps immediate dispatch behavior inside transactions when no afterCommit is requested', async () => {
    await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async () => {})
    await DB.transaction(async () => {
      registerListener(defineListener({
        name: 'sync.audit',
        listensTo: ['user.registered'],
        async handle() {
          await handled()
        },
      }))

      const result = await dispatchEvent('user.registered', {
        userId: 'usr-1',
      })

      expect(result).toMatchObject({
        deferred: false,
        syncListeners: 1,
        queuedListeners: 0,
      })
      expect(handled).toHaveBeenCalledTimes(1)
    })
  })

  it('defers the full dispatch when dispatch-level afterCommit is requested in an active transaction', async () => {
    await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async () => {})
    await DB.transaction(async () => {
      registerListener(defineListener({
        name: 'sync.audit',
        listensTo: ['user.registered'],
        async handle() {
          await handled()
        },
      }))

      const result = await dispatchEvent('user.registered', {
        userId: 'usr-1',
      }).afterCommit()

      expect(result).toMatchObject({
        deferred: true,
        syncListeners: 1,
        queuedListeners: 0,
      })
      expect(handled).toHaveBeenCalledTimes(0)
    })

    expect(handled).toHaveBeenCalledTimes(1)
  })

  it('defers only listeners marked afterCommit and runs them immediately outside transactions', async () => {
    await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const immediate = vi.fn(async () => {})
    const deferred = vi.fn(async () => {})
    registerListener(defineListener({
      name: 'sync.immediate',
      listensTo: ['user.registered'],
      async handle() {
        await immediate()
      },
    }))
    registerListener(defineListener({
      name: 'sync.deferred',
      listensTo: ['user.registered'],
      afterCommit: true,
      async handle() {
        await deferred()
      },
    }))

    const outside = await dispatchEvent('user.registered', {
      userId: 'usr-outside',
    })
    expect(outside).toMatchObject({
      deferred: false,
      syncListeners: 2,
      queuedListeners: 0,
    })
    expect(immediate).toHaveBeenCalledTimes(1)
    expect(deferred).toHaveBeenCalledTimes(1)

    await DB.transaction(async () => {
      const inside = await dispatchEvent('user.registered', {
        userId: 'usr-inside',
      })

      expect(inside).toMatchObject({
        deferred: true,
        syncListeners: 2,
        queuedListeners: 0,
      })
      expect(immediate).toHaveBeenCalledTimes(2)
      expect(deferred).toHaveBeenCalledTimes(1)
    })

    expect(deferred).toHaveBeenCalledTimes(2)
  })

  it('supports mixed immediate and deferred sync and queued listeners in the same transaction', async () => {
    await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const immediateSync = vi.fn(async () => {})
    const deferredSync = vi.fn(async () => {})
    const queued = vi.fn(async () => {})
    configureEventsRuntime({
      dispatchQueuedListener: queued,
    })

    registerListener(defineListener({
      name: 'sync.immediate',
      listensTo: ['user.registered'],
      async handle() {
        await immediateSync()
      },
    }))
    registerListener(defineListener({
      name: 'sync.deferred',
      listensTo: ['user.registered'],
      afterCommit: true,
      async handle() {
        await deferredSync()
      },
    }))
    registerListener(defineListener({
      name: 'queue.immediate',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {},
    }))
    registerListener(defineListener({
      name: 'queue.deferred',
      listensTo: ['user.registered'],
      queue: true,
      afterCommit: true,
      async handle() {},
    }))

    await DB.transaction(async () => {
      const result = await dispatchEvent('user.registered', {
        userId: 'usr-1',
      })

      expect(result).toMatchObject({
        deferred: true,
        syncListeners: 2,
        queuedListeners: 2,
      })
      expect(immediateSync).toHaveBeenCalledTimes(1)
      expect(deferredSync).toHaveBeenCalledTimes(0)
      expect(queued).toHaveBeenCalledTimes(1)
      expect(queued).toHaveBeenNthCalledWith(1, expect.objectContaining({
        listenerId: 'queue.immediate',
      }))
    })

    expect(deferredSync).toHaveBeenCalledTimes(1)
    expect(queued).toHaveBeenCalledTimes(2)
    expect(queued).toHaveBeenNthCalledWith(2, expect.objectContaining({
      listenerId: 'queue.deferred',
    }))
  })

  it('runs deferred sync and queued listeners interleaved in registration order after commit', async () => {
    await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const order: string[] = []
    configureEventsRuntime({
      dispatchQueuedListener: async (dispatch) => {
        order.push(`queued:${dispatch.listenerId}`)
      },
    })
    registerListener(defineListener({
      name: 'sync.first',
      listensTo: ['user.registered'],
      async handle() {
        order.push('sync:first')
      },
    }))
    registerListener(defineListener({
      name: 'queued.second',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {},
    }))
    registerListener(defineListener({
      name: 'sync.third',
      listensTo: ['user.registered'],
      async handle() {
        order.push('sync:third')
      },
    }))

    await DB.transaction(async () => {
      await dispatchEvent('user.registered', {
        userId: 'usr-1',
      }).afterCommit()
      expect(order).toEqual([])
    })

    expect(order).toEqual(['sync:first', 'queued:queued.second', 'sync:third'])
  })

  it('propagates the first deferred listener failure after commit and skips later listeners', async () => {
    await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const later = vi.fn(async () => {})
    registerListener(defineListener({
      name: 'sync.fails',
      listensTo: ['user.registered'],
      afterCommit: true,
      async handle() {
        throw new Error('deferred listener failed')
      },
    }))
    registerListener(defineListener({
      name: 'sync.after',
      listensTo: ['user.registered'],
      afterCommit: true,
      async handle() {
        await later()
      },
    }))

    await expect(DB.transaction(async () => {
      await dispatchEvent('user.registered', {
        userId: 'usr-1',
      })
    })).rejects.toThrow('deferred listener failed')
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps deferred work isolated across nested savepoints and rollbacks', async () => {
    const db = await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async () => {})
    registerListener(defineListener({
      name: 'sync.deferred',
      listensTo: ['user.registered'],
      afterCommit: true,
      async handle() {
        await handled()
      },
    }))

    await DB.transaction(async () => {
      await DB.transaction(async () => {
        await db.table('event_records').insert({ user_id: 'usr-nested' })
        const nested = await dispatchEvent('user.registered', {
          userId: 'usr-nested',
        }).afterCommit()
        expect(nested.deferred).toBe(true)
        expect(handled).toHaveBeenCalledTimes(0)
      })

      expect(handled).toHaveBeenCalledTimes(0)
    })
    expect(handled).toHaveBeenCalledTimes(1)

    await expect(DB.transaction(async () => {
      await expect(DB.transaction(async () => {
        await db.table('event_records').insert({ user_id: 'usr-rolled-back' })
        await dispatchEvent('user.registered', {
          userId: 'usr-rolled-back',
        }).afterCommit()
        throw new Error('nested rollback')
      })).rejects.toThrow('nested rollback')
    })).resolves.toBeUndefined()

    expect(handled).toHaveBeenCalledTimes(1)
    expect(await db.table('event_records').pluck('user_id')).toEqual(['usr-nested'])
  })

  it('does not leak deferred work after rollback and handles repeated dispatches in one transaction', async () => {
    await configureTestDB()
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async () => {})
    registerListener(defineListener({
      name: 'sync.deferred',
      listensTo: ['user.registered'],
      afterCommit: true,
      async handle() {
        await handled()
      },
    }))

    await expect(DB.transaction(async () => {
      await dispatchEvent('user.registered', {
        userId: 'usr-rollback',
      }).afterCommit()
      throw new Error('rollback transaction')
    })).rejects.toThrow('rollback transaction')

    expect(handled).toHaveBeenCalledTimes(0)

    await DB.transaction(async () => {
      await dispatchEvent('user.registered', {
        userId: 'usr-1',
      }).afterCommit()
      await dispatchEvent('user.registered', {
        userId: 'usr-2',
      }).afterCommit()
      expect(handled).toHaveBeenCalledTimes(0)
    })

    expect(handled).toHaveBeenCalledTimes(2)

    const outside = await dispatchEvent('user.registered', {
      userId: 'usr-outside',
    }).afterCommit()
    expect(outside.deferred).toBe(false)
    expect(handled).toHaveBeenCalledTimes(3)
  })
})
