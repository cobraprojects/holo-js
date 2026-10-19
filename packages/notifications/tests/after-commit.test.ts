import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DB,
  configureDB,
  connectionAsyncContext,
  createConnectionManager,
  createDatabase,
  createDialect,
  createSchemaService,
  resetDB,
} from '@holo-js/db'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import {
  configureNotificationsRuntime,
  notify,
  registerNotificationChannel,
  resetNotificationChannelRegistry,
  resetNotificationsRuntime,
} from '../src'

async function configureTestDB() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  await createSchemaService(db).createTable('users', table => {
    table.id()
  })
  return adapter
}

const definition = {
  via: () => ['flaky', 'slack'],
  build: {
    flaky: () => ({ text: 'Deployed' }),
    slack: () => ({ text: 'Deployed' }),
  },
} as never

const target = {
  id: 'user-1',
  routeNotificationFor(channel: string) {
    return channel === 'flaky' || channel === 'slack' ? { webhook: `https://hooks.test/${channel}` } : undefined
  },
} as never

afterEach(() => {
  errorReportingInternals.configure(undefined)
  resetNotificationsRuntime()
  resetNotificationChannelRegistry()
  resetDB()
})

describe('@holo-js/notifications after-commit delivery', () => {
  it('reports channel failures after commit through the error-reporting hook and still delivers the other channels', async () => {
    const adapter = await configureTestDB()
    const failure = new Error('webhook unreachable')
    const reports: Array<{ error: unknown, context: HoloErrorReportContext }> = []
    errorReportingInternals.configure({
      report(error, context) {
        reports.push({ error, context })
      },
    })
    const slackSend = vi.fn(async () => 'delivered')
    registerNotificationChannel('flaky', {
      send: async () => {
        throw failure
      },
    })
    registerNotificationChannel('slack', {
      send: slackSend,
    })
    configureNotificationsRuntime({
      deferAfterCommit(callback) {
        const connection = connectionAsyncContext.getActive()?.connection
        if (!connection || connection.getScope().kind === 'root') {
          return false
        }

        connection.afterCommit(callback)
        return true
      },
    })

    await DB.transaction(async () => {
      const result = await notify(target, definition).afterCommit()

      expect(result).toMatchObject({ deferred: true })
      expect(slackSend).not.toHaveBeenCalled()
      expect(reports).toEqual([])
    })

    expect(slackSend).toHaveBeenCalledTimes(1)
    expect(reports).toEqual([{
      error: failure,
      context: { capability: 'notifications', operation: 'channel.afterCommit' },
    }])
    await adapter.disconnect()
  })

  it('does not report anything when a deferred dispatch rolls back', async () => {
    const adapter = await configureTestDB()
    const reports: unknown[] = []
    errorReportingInternals.configure({
      report(error) {
        reports.push(error)
      },
    })
    const flakySend = vi.fn(async () => {
      throw new Error('never delivered')
    })
    registerNotificationChannel('flaky', { send: flakySend })
    registerNotificationChannel('slack', { send: vi.fn(async () => 'delivered') })
    configureNotificationsRuntime({
      deferAfterCommit(callback) {
        const connection = connectionAsyncContext.getActive()?.connection
        if (!connection || connection.getScope().kind === 'root') {
          return false
        }

        connection.afterCommit(callback)
        return true
      },
    })

    await expect(DB.transaction(async () => {
      await notify(target, definition).afterCommit()
      throw new Error('rollback transaction')
    })).rejects.toThrow('rollback transaction')

    expect(flakySend).not.toHaveBeenCalled()
    expect(reports).toEqual([])
    await adapter.disconnect()
  })
})
