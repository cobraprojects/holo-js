import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB } from '@holo-js/db'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'
import { dispatch, registerQueueJob, resetQueueRegistry } from '../src'

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
})
