import { describe, it } from 'vitest'
import type { HoloRuntime } from '../src/portable'

type CustomConfig = {
  services: {
    mailgun: {
      secret: string
    }
  }
}

describe('@holo-js/core runtime typing', () => {
  it('preserves inference for runtime config accessors', () => {
    type ServicesResult = HoloRuntime<CustomConfig> extends {
      useConfig: (key: 'services') => infer TResult
    }
      ? TResult
      : never
    type NestedUseConfigResult = HoloRuntime<CustomConfig> extends {
      useConfig: (path: 'services.mailgun.secret') => infer TResult
    }
      ? TResult
      : never
    type SecretResult = HoloRuntime<CustomConfig> extends {
      config: (path: 'services.mailgun.secret') => infer TResult
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
