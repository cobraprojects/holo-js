import { describe, it } from 'vitest'
import type { HoloAdapterProjectAccessors } from '../src'

type CustomConfig = {
  services: {
    mailgun: {
      secret: string
    }
  }
}

describe('@holo-js/core adapter typing', () => {
  it('preserves inference for shared adapter accessors', () => {
    type ServicesResult = HoloAdapterProjectAccessors<CustomConfig> extends {
      useConfig: (key: 'services') => Promise<infer TResult>
    }
      ? TResult
      : never
    type NestedUseConfigResult = HoloAdapterProjectAccessors<CustomConfig> extends {
      useConfig: (path: 'services.mailgun.secret') => Promise<infer TResult>
    }
      ? TResult
      : never
    type SecretResult = HoloAdapterProjectAccessors<CustomConfig> extends {
      config: (path: 'services.mailgun.secret') => Promise<infer TResult>
    }
      ? TResult
      : never

    const services: ServicesResult = {
      mailgun: {
        secret: 'secret',
      },
    }
    const nestedUseConfigSecret: NestedUseConfigResult = 'secret'
    const secret: SecretResult = 'secret'

    void services
    void nestedUseConfigSecret
    void secret
  })
})
