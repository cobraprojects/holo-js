import { describe, expect, it, vi } from 'vitest'

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
}))

describe('@holo-js/queue-redis', () => {
  it('exports the redis driver factory and helpers', async () => {
    const {
      RedisQueueDriverError,
      redisQueueDriverFactory,
      redisQueueDriverInternals,
    } = await import('../src')

    expect(redisQueueDriverFactory.driver).toBe('redis')
    expect(redisQueueDriverInternals.resolveBullConnectionOptions({
      name: 'redis',
      driver: 'redis',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })).toEqual({
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
      maxRetriesPerRequest: null,
    })
    expect(redisQueueDriverInternals.resolveAttempts({
      attemptsStarted: 3,
      attemptsMade: 1,
    } as never)).toBe(2)
    expect(
      redisQueueDriverInternals.wrapRedisError('redis', 'reserve job', new Error('boom')),
    ).toBeInstanceOf(RedisQueueDriverError)
  })
})
