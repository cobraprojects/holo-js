import { describe, expectTypeOf, it } from 'vitest'
import {
  createHoloProjectAccessors,
  type HoloAdapterProject,
  type HoloAdapterProjectAccessors,
  type HoloAuthRuntimeBinding,
  type HoloQueueRuntimeBinding,
} from '../src'
import type { getAuthRuntime } from '@holo-js/auth'

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

  it('infers custom config paths from the project resolver', () => {
    const resolveProject = async (): Promise<HoloAdapterProject<CustomConfig>> => ({
      runtime: {},
    } as HoloAdapterProject<CustomConfig>)
    const accessors = createHoloProjectAccessors(resolveProject, { cache: true })

    const readServices = (): Promise<CustomConfig['services']> => accessors.useConfig('services')
    const readNestedSecret = (): Promise<string> => accessors.useConfig('services.mailgun.secret')
    const readSecret = (): Promise<string> => accessors.config('services.mailgun.secret')
    const readInvalidPath = () => {
      // @ts-expect-error invalid config paths must be rejected without consumer type declarations
      return accessors.config('services.invalid')
    }

    expectTypeOf(readServices).returns.toEqualTypeOf<Promise<CustomConfig['services']>>()
    expectTypeOf(readNestedSecret).returns.toEqualTypeOf<Promise<string>>()
    expectTypeOf(readSecret).returns.toEqualTypeOf<Promise<string>>()
    void readInvalidPath
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

  it('preserves the complete auth facade on the public runtime binding', () => {
    expectTypeOf<HoloAuthRuntimeBinding>().toEqualTypeOf<ReturnType<typeof getAuthRuntime>>()
  })
})
