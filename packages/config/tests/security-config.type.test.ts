import { describe, it } from 'vitest'
import {
  createConfigAccessors,
  defineSecurityConfig,
  type HoloConfigRegistry,
} from '../src'

describe('@holo-js/config security typing', () => {
  it('preserves security inference through config helpers and dot-path access', () => {
    const security = defineSecurityConfig({
      csrf: {
        enabled: true,
      },
      rateLimit: {
        driver: 'redis',
        redis: {
          connection: 'cache',
          prefix: 'holo:rate-limit:',
        },
        limiters: {
          login: {
            maxAttempts: 5,
            decaySeconds: 60,
            key({ request, values }) {
              return `${request.method}:${String(values?.email ?? 'guest')}`
            },
          },
        },
      },
    })

    const accessors = createConfigAccessors({
      app: {} as HoloConfigRegistry['app'],
      database: {} as HoloConfigRegistry['database'],
      redis: {} as HoloConfigRegistry['redis'],
      storage: {} as HoloConfigRegistry['storage'],
      queue: {} as HoloConfigRegistry['queue'],
      broadcast: {} as HoloConfigRegistry['broadcast'],
      mail: {} as HoloConfigRegistry['mail'],
      notifications: {} as HoloConfigRegistry['notifications'],
      media: {} as HoloConfigRegistry['media'],
      session: {} as HoloConfigRegistry['session'],
      security: security as unknown as HoloConfigRegistry['security'],
      auth: {} as HoloConfigRegistry['auth'],
      services: {} as HoloConfigRegistry['services'],
    })

    const csrfField: string = accessors.useConfig('security.csrf.field')
    const rateLimitDriver: string = accessors.useConfig('security.rateLimit.driver')
    const redisPrefix = accessors.useConfig('security.rateLimit.redis.prefix') as string

    void csrfField
    void rateLimitDriver
    void redisPrefix
  })
})
