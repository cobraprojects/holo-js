import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redisQueueDriverFactory } from '../src'

describe('@holo-js/queue-redis real Redis usage', () => {
  it('dispatches, reserves, and acknowledges a job through a local Redis server', async () => {
    const queueName = `holo-real-${randomUUID()}`
    const driver = redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: queueName,
      retryAfter: 30,
      blockFor: 1,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    }, {
      async execute() {
        throw new Error('The Redis queue test reserves jobs without executing them.')
      },
    })

    try {
      const job = {
        id: randomUUID(),
        name: 'RealRedisJob',
        connection: 'redis',
        queue: queueName,
        payload: {
          ok: true,
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: Date.now(),
      } as const

      const dispatched = await driver.dispatch(job)
      const reserved = await driver.reserve<typeof job.payload>({
        queueNames: [queueName],
        workerId: 'worker-real',
      })

      expect(dispatched.synchronous).toBe(false)
      expect(dispatched.jobId).toBe(job.id)
      expect(reserved?.envelope).toMatchObject({
        id: job.id,
        name: job.name,
        connection: job.connection,
        queue: job.queue,
        payload: job.payload,
      })

      if (reserved) {
        await driver.acknowledge(reserved)
      }
    } finally {
      await driver.clear({ queueNames: [queueName] })
      await driver.close()
    }
  }, 30_000)
})
