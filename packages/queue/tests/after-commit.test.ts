import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB } from '@holo-js/db'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'
import { configureQueueRuntime, dispatch, dispatchSync, registerQueueJob, resetQueueRegistry, type QueueDispatchResult, type QueueDriver } from '../src'

async function openHarness(connectionAfterCommit?: boolean) {
  const harness = await createSQLiteQueueHarness({
    queueConfig: {
      default: 'database',
      failed: false,
      connections: {
        database: {
          driver: 'database',
          connection: 'default',
          table: 'jobs',
          queue: 'default',
          ...(typeof connectionAfterCommit === 'undefined' ? {} : { afterCommit: connectionAfterCommit }),
        },
      },
    },
  })
  onTestFinished(() => harness.cleanup())
  registerQueueJob({ handle() {} }, { name: 'receipt-sent' })
  return harness
}

afterEach(() => {
  resetQueueRegistry()
})

describe('@holo-js/queue after-commit dispatch', () => {
  it('enqueues a pending dispatch marked afterCommit only once the enclosing transaction commits', async () => {
    const harness = await openHarness()

    const result = await DB.transaction(async () => {
      const dispatched = await dispatch('receipt-sent', {}).afterCommit().dispatch()
      expect(await harness.readJobRows()).toEqual([])
      return dispatched
    })

    expect(result).toMatchObject({ synchronous: false })
    expect(await harness.readJobRows()).toEqual([expect.objectContaining({ id: result.jobId })])
  })

  it('discards an afterCommit dispatch when the enclosing transaction rolls back', async () => {
    const harness = await openHarness()

    await expect(DB.transaction(async () => {
      await dispatch('receipt-sent', {}).afterCommit().dispatch()
      throw new Error('rollback requested')
    })).rejects.toThrow('rollback requested')

    expect(await harness.readJobRows()).toEqual([])
  })

  it('enqueues an afterCommit dispatch immediately when no transaction is open', async () => {
    const harness = await openHarness()

    const result = await dispatch('receipt-sent', {}).afterCommit().dispatch()

    expect(result).toMatchObject({ synchronous: false })
    expect(await harness.readJobRows()).toEqual([expect.objectContaining({ id: result.jobId })])
  })

  it('defers every dispatch on a connection configured with afterCommit true', async () => {
    const harness = await openHarness(true)

    await DB.transaction(async () => {
      await dispatch('receipt-sent', {}).dispatch()
      expect(await harness.readJobRows()).toEqual([])
    })

    expect(await harness.readJobRows()).toHaveLength(1)
  })

  it('keeps dispatching immediately inside a transaction unless afterCommit is requested', async () => {
    const harness = await openHarness()

    await DB.transaction(async () => {
      await dispatch('receipt-sent', {}).dispatch()
      expect(await harness.readJobRows()).toHaveLength(1)
    })
  })

  it('serializes an afterCommit payload as it was when dispatched, not as it is at commit', async () => {
    const harness = await openHarness()
    const payload = { orderId: 0 }

    await DB.transaction(async () => {
      for (const orderId of [1, 2, 3]) {
        payload.orderId = orderId
        await dispatch('receipt-sent', payload).afterCommit().dispatch()
      }
    })

    const payloads = (await harness.readJobRows()).map(row => JSON.parse(String(row.payload)) as { orderId: number })
    expect(payloads.map(entry => entry.orderId).sort()).toEqual([1, 2, 3])
  })

  it('runs onComplete for an afterCommit dispatch only once it is enqueued at commit', async () => {
    const harness = await openHarness()
    const completed: unknown[] = []

    await DB.transaction(async () => {
      await dispatch('receipt-sent', {}).afterCommit().onComplete(result => {
        completed.push(result)
      }).dispatch()
      expect(completed).toEqual([])
    })

    expect(completed).toEqual([expect.objectContaining({ synchronous: false })])
    expect(await harness.readJobRows()).toHaveLength(1)
  })

  it('does not run onComplete for an afterCommit dispatch whose transaction rolls back', async () => {
    const harness = await openHarness()
    const completed: unknown[] = []

    await expect(DB.transaction(async () => {
      await dispatch('receipt-sent', {}).afterCommit().onComplete(result => {
        completed.push(result)
      }).dispatch()
      throw new Error('rollback requested')
    })).rejects.toThrow('rollback requested')

    expect(completed).toEqual([])
    expect(await harness.readJobRows()).toEqual([])
  })

  it('runs a job inline without checking its timeout against the connection retryAfter', async () => {
    const harness = await openHarness()
    registerQueueJob({ timeout: 120, handle() {} }, { name: 'slow-inline' })

    await expect(dispatchSync('slow-inline', {})).resolves.toBeUndefined()
    expect(await harness.readJobRows()).toEqual([])
  })

  it('reports the same synchronous flag and job id to the awaited result and onComplete on the sync driver', async () => {
    const harness = await createSQLiteQueueHarness({
      queueConfig: {
        default: 'sync',
        failed: false,
        connections: {
          database: { driver: 'database', connection: 'default', table: 'jobs', queue: 'default' },
          sync: { driver: 'sync', queue: 'default', afterCommit: true },
        },
      },
    })
    onTestFinished(() => harness.cleanup())
    registerQueueJob({ handle() {} }, { name: 'receipt-sent' })
    const completed: QueueDispatchResult[] = []

    const awaited = await DB.transaction(async () => dispatch('receipt-sent', {})
      .onComplete(result => {
        completed.push(result)
      })
      .dispatch())

    expect(completed).toEqual([awaited])
  })

  // Known gap: the awaited result must return the caller's job ID before commit, but a driver that assigns its own ID
  // only reports it at commit. Fixing this changes QueueDispatchResult.jobId, so this stays a failing expectation until then.
  it.fails('reports the job id a driver assigns to the awaited result and onComplete', async () => {
    await openHarness()
    const driver: QueueDriver = {
      name: 'assigns-ids',
      driver: 'assigns-ids',
      mode: 'sync',
      async dispatch() {
        return { jobId: 'assigned-by-driver', synchronous: true }
      },
      async clear() {
        return 0
      },
      async close() {},
    }
    configureQueueRuntime({
      config: {
        default: 'assigns',
        failed: false,
        connections: {
          assigns: { driver: 'assigns-ids', queue: 'default', afterCommit: true },
        },
      },
      driverFactories: [{ driver: 'assigns-ids', create: () => driver }],
    })
    const completed: QueueDispatchResult[] = []

    const awaited = await DB.transaction(async () => dispatch('receipt-sent', {})
      .onComplete(result => {
        completed.push(result)
      })
      .dispatch())

    expect(completed).toEqual([awaited])
  })
})
