import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DB,
  configureDB,
  createConnectionManager,
  resetDB,
  type Dialect,
  type DriverAdapter,
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

class FakeAdapter implements DriverAdapter {
  connected = false
  readonly calls: string[] = []

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query() {
    return {
      rows: [],
      rowCount: 0,
    }
  }

  async execute() {
    return {
      affectedRows: 0,
      lastInsertId: undefined,
    }
  }

  async beginTransaction(): Promise<void> {
    this.calls.push('begin')
  }

  async commit(): Promise<void> {
    this.calls.push('commit')
  }

  async rollback(): Promise<void> {
    this.calls.push('rollback')
  }

  async createSavepoint(name: string): Promise<void> {
    this.calls.push(`savepoint:${name}`)
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    this.calls.push(`rollback-to:${name}`)
  }

  async releaseSavepoint(name: string): Promise<void> {
    this.calls.push(`release:${name}`)
  }
}

function createTestDialect(savepoints = false): Dialect {
  return {
    name: 'sqlite',
    capabilities: {
      returning: false,
      savepoints,
      concurrentQueries: false,
      workerThreadExecution: false,
      lockForUpdate: false,
      sharedLock: false,
      jsonValueQuery: true,
      jsonContains: false,
      jsonLength: true,
      schemaQualifiedIdentifiers: false,
      nativeUpsert: true,
      ddlAlterSupport: false,
      introspection: true,
    },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    },
  }
}

function configureTestDB(savepoints = true): FakeAdapter {
  const adapter = new FakeAdapter()
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: {
      default: {
        adapter,
        dialect: createTestDialect(savepoints),
        security: { allowUnsafeRawSql: true },
      },
    },
  }))
  return adapter
}

afterEach(() => {
  resetEventsRegistry()
  resetEventsRuntime()
  resetDB()
})

describe('@holo-js/events afterCommit integration', () => {
  it('keeps immediate dispatch behavior inside transactions when no afterCommit is requested', async () => {
    configureTestDB()
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
    configureTestDB()
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
    configureTestDB()
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
    configureTestDB()
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

  it('keeps deferred work isolated across nested savepoints and rollbacks', async () => {
    const adapter = configureTestDB(true)
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
        await dispatchEvent('user.registered', {
          userId: 'usr-rolled-back',
        }).afterCommit()
        throw new Error('nested rollback')
      })).rejects.toThrow('nested rollback')
    })).resolves.toBeUndefined()

    expect(handled).toHaveBeenCalledTimes(1)
    expect(adapter.calls.some(call => call.startsWith('savepoint:'))).toBe(true)
  })

  it('does not leak deferred work after rollback and handles repeated dispatches in one transaction', async () => {
    configureTestDB()
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
