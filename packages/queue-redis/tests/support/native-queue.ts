import { Queue } from 'bullmq'
import { onTestFinished } from 'vitest'
import { startRedisService } from '../../../session/tests/support/redis'
import { redisQueueDriverFactory, type QueueJobEnvelope } from '../../src'

export async function createNativeRedisQueue() {
  const service = await startRedisService()
  const port = service.ports[0]
  const client = service.clients[0]
  if (port === undefined || !client) throw new Error('Expected an owned Redis service')
  const queue = new Queue<QueueJobEnvelope>('media', { connection: { host: '127.0.0.1', port } })
  onTestFinished(() => queue.close())
  return {
    factory: redisQueueDriverFactory,
    redisConfig: { default: 'default', connections: { default: { name: 'default', host: '127.0.0.1', port, db: 0 } } },
    async jobs() { return (await queue.getJobs(['wait', 'delayed'])).map(job => job.data) },
    async clear() { await queue.drain(true) },
    async failWrites() { await client.config('SET', 'maxmemory', '1') },
  }
}
