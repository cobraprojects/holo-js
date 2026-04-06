import { afterEach, describe, expect, it } from 'vitest'
import type {
  QueueDriver,
  QueueDriverFactoryContext,
  QueueJsonValue,
} from '../../src'
import {
  queueRuntimeInternals,
  registerQueueJob,
  resetQueueRuntime,
} from '../../src'

type DriverContractOptions = {
  readonly label: string
  createDriver(context: QueueDriverFactoryContext): QueueDriver
}

export function runQueueDriverContractSuite(options: DriverContractOptions): void {
  describe(`${options.label} driver contract`, () => {
    afterEach(() => {
      resetQueueRuntime()
    })

    it('dispatches jobs with stable metadata and result propagation', async () => {
      registerQueueJob({
        tries: 4,
        async handle(payload, context) {
          return {
            attempt: context.attempt,
            connection: context.connection,
            maxAttempts: context.maxAttempts,
            payload,
            queue: context.queue,
          }
        },
      }, {
        name: 'contract.handle',
      })

      const driver = options.createDriver(queueRuntimeInternals.createQueueDriverFactoryContext())
      const result = await driver.dispatch<QueueJsonValue, {
        readonly attempt: number
        readonly connection: string
        readonly maxAttempts: number
        readonly payload: QueueJsonValue
        readonly queue: string
      }>({
        id: 'job-1',
        name: 'contract.handle',
        connection: 'sync',
        queue: 'critical',
        payload: {
          ok: true,
        },
        attempts: 1,
        maxAttempts: 4,
        createdAt: 100,
      })

      expect(driver.name).toBe('sync')
      expect(driver.driver).toBe('sync')
      expect(driver.mode).toBe('sync')
      expect(result).toEqual({
        jobId: 'job-1',
        synchronous: true,
        result: {
          attempt: 2,
          connection: 'sync',
          maxAttempts: 4,
          payload: {
            ok: true,
          },
          queue: 'critical',
        },
      })
    })

    it('does not retain pending jobs and propagates handler failures', async () => {
      registerQueueJob({
        async handle() {
          throw new Error('driver failure')
        },
      }, {
        name: 'contract.fail',
      })

      const driver = options.createDriver(queueRuntimeInternals.createQueueDriverFactoryContext())

      await expect(driver.clear()).resolves.toBe(0)
      await expect(driver.clear({
        queueNames: ['default'],
      })).resolves.toBe(0)
      await expect(driver.dispatch({
        id: 'job-2',
        name: 'contract.fail',
        connection: 'sync',
        queue: 'default',
        payload: {
          ok: false,
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: 200,
      })).rejects.toThrow('driver failure')
    })
  })
}
