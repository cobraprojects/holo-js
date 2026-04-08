import { describe, it } from 'vitest'
import type { HoloAdapterProjectAccessors, HoloQueueRuntimeBinding } from '../src'

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

  it('preserves a typed queue driver surface on the public runtime binding', () => {
    type DriverValue = HoloQueueRuntimeBinding['drivers'] extends ReadonlyMap<string, infer TResult>
      ? TResult
      : never

    const mode: DriverValue['mode'] = 'sync'
    const asyncMode: DriverValue['mode'] = 'async'
    const name: DriverValue['name'] = 'default'
    const driver: DriverValue['driver'] = 'redis'

    void mode
    void asyncMode
    void name
    void driver
  })
})
