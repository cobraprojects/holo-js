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

  it('reports the same job ID to the awaited result and onComplete on the database driver', async () => {
    const harness = await openHarness()
    const completed: QueueDispatchResult[] = []

    const awaited = await DB.transaction(async () => dispatch('receipt-sent', {})
      .afterCommit()
      .onComplete(result => {
        completed.push(result)
      })
      .dispatch())

    expect(completed).toEqual([awaited])
    expect((await harness.readJobRows()).map(row => row.id)).toEqual([awaited.jobId])
  })

  it('rejects afterCommit on a driver that does not accept a caller-supplied job ID, naming the connection', async () => {
    const harness = await openHarness()
    configureCustomDriverRuntime(ownIdDriver(), { afterCommit: false })

    await expect(DB.transaction(async () => dispatch('receipt-sent', {}).afterCommit().dispatch())).rejects.toThrow(
      'Queue connection "custom" uses driver "assigns-ids", which does not accept a caller-supplied job ID, so afterCommit needs a driver that accepts the job ID.',
    )
    expect(await harness.readJobRows()).toEqual([])
  })

  it('rejects a connection afterCommit default on such a driver at dispatch, even outside a transaction', async () => {
    await openHarness()
    configureCustomDriverRuntime(ownIdDriver(), { afterCommit: true })

    await expect(dispatch('receipt-sent', {}).dispatch()).rejects.toThrow(
      'Queue connection "custom" uses driver "assigns-ids", which does not accept a caller-supplied job ID',
    )
  })

  it('rejects the committing transaction when an afterCommit dispatch returns a job ID other than the one it accepted', async () => {
    await openHarness()
    configureCustomDriverRuntime(ownIdDriver({ acceptsJobId: true, returnedJobId: 'elsewhere' }), { afterCommit: false })
    const completed: QueueDispatchResult[] = []
    const failures: unknown[] = []

    await expect(DB.transaction(async () => dispatch('receipt-sent', {})
      .afterCommit()
      .onComplete(result => {
        completed.push(result)
      })
      .onFailed(error => {
        failures.push(error)
      })
      .dispatch())).rejects.toThrow('returned job ID "elsewhere"')

    expect(completed).toEqual([])
    expect(failures).toEqual([expect.objectContaining({
      message: expect.stringContaining('returned job ID "elsewhere"'),
    })])
  })

  it('rejects the committing transaction with the enqueue error when queuing fails at commit', async () => {
    await openHarness()
    const enqueueError = new Error('broker unavailable')
    configureCustomDriverRuntime(ownIdDriver({ acceptsJobId: true, dispatchError: enqueueError }), { afterCommit: false })
    const failures: unknown[] = []

    const committed = DB.transaction(async () => dispatch('receipt-sent', {})
      .afterCommit()
      .onFailed(error => {
        failures.push(error)
      })
      .dispatch())

    await expect(committed).rejects.toBe(enqueueError)
    expect(failures).toEqual([enqueueError])
  })
})

function configureCustomDriverRuntime(driver: QueueDriver, connection: { readonly afterCommit: boolean }): void {
  configureQueueRuntime({
    config: {
      default: 'custom',
      failed: false,
      connections: {
        custom: { driver: 'assigns-ids', queue: 'default', afterCommit: connection.afterCommit },
      },
    },
    driverFactories: [{ driver: 'assigns-ids', create: () => driver }],
  })
}

function ownIdDriver(options: {
  readonly acceptsJobId?: boolean
  readonly returnedJobId?: string
  readonly dispatchError?: Error
} = {}): QueueDriver {
  return {
    name: 'custom',
    driver: 'assigns-ids',
    mode: 'sync',
    ...(typeof options.acceptsJobId === 'undefined' ? {} : { acceptsJobId: options.acceptsJobId }),
    async dispatch() {
      if (options.dispatchError) throw options.dispatchError
      return { jobId: options.returnedJobId ?? 'assigned-by-driver', synchronous: true }
    },
    async clear() {
      return 0
    },
    async close() {},
  }
}
