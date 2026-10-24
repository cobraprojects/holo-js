import { describe, it } from 'vitest'
import { createNextHoloHelpers } from '../src'

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    services: {
      mailgun: {
        secret: string
      }
    }
  }
}

describe('@holo-js/adapter-next typing', () => {
  it('preserves inference for helper accessors', () => {
    const helpers = createNextHoloHelpers()

    type Helpers = typeof helpers
    type ServicesResult = Helpers extends {
      useConfig: (key: 'services') => Promise<infer TResult>
    }
      ? TResult
      : never
    type SecretResult = Helpers extends {
      config: (path: 'services.mailgun.secret') => Promise<infer TResult>
    }
      ? TResult
      : never

    const services: ServicesResult = {
      mailgun: {
        secret: 'secret',
      },
    }
    const secret: SecretResult = 'secret'

    void services
    void secret
  })
})
