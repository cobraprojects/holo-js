import { describe, it } from 'vitest'
import type { HoloConfigRegistry } from '../src'
import { defineCorsConfig, defineSecurityConfig } from '@holo-js/security'
import { createConfigAccessorFixture } from './support/configAccessors'

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
    const cors = defineCorsConfig({
      origins: ['https://app.example.com'],
      statefulDomains: ['app.example.com'],
    })

    const accessors = createConfigAccessorFixture({
      cors: cors as unknown as HoloConfigRegistry['cors'],
      security: security as unknown as HoloConfigRegistry['security'],
      services: {
        mailgun: {
          secret: 'secret',
        },
      },
    })

    const csrfField: string = accessors.useConfig('security.csrf.field')
    const corsOrigin = accessors.useConfig('cors.origins') as readonly string[]
    const rateLimitDriver: string = accessors.useConfig('security.rateLimit.driver')
    const redisPrefix = accessors.useConfig('security.rateLimit.redis.prefix') as string

    void csrfField
    void corsOrigin
    void rateLimitDriver
    void redisPrefix
  })
})
