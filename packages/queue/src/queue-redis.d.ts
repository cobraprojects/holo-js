declare module '@holo-js/queue-redis' {
  import type { NormalizedQueueRedisConnectionConfig, QueueDriverFactory } from './contracts'

  export const redisQueueDriverFactory: QueueDriverFactory<NormalizedQueueRedisConnectionConfig>
}
