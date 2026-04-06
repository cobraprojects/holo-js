import { describe, it } from 'vitest'
import { createConfigAccessors, defineConfig, defineQueueConfig, type DotPath, type HoloAppEnv, type HoloConfigRegistry } from '../src'

declare module '../src/types' {
  interface HoloConfigRegistry {
    services: {
      mailgun: {
        secret: string
      }
    }
  }
}

describe('@holo-js/config typing', () => {
  it('preserves inference for file-level and string-path access', () => {
    const services = defineConfig({
      mailgun: {
        secret: 'secret',
      },
    })
    const queue = defineQueueConfig({
      default: 'sync',
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })
    const accessors = createConfigAccessors({
      app: {} as HoloConfigRegistry['app'],
      database: {} as HoloConfigRegistry['database'],
      storage: {} as HoloConfigRegistry['storage'],
      queue: queue as unknown as HoloConfigRegistry['queue'],
      media: {} as HoloConfigRegistry['media'],
      services,
    })

    const loadedServices: {
      mailgun: {
        secret: string
      }
    } = accessors.useConfig('services')
    const nestedSecret: string = accessors.useConfig('services.mailgun.secret')
    const secret: string = accessors.config('services.mailgun.secret')
    const nestedPath: DotPath<{
      app: HoloConfigRegistry['app']
      database: HoloConfigRegistry['database']
      storage: HoloConfigRegistry['storage']
      queue: HoloConfigRegistry['queue']
      media: HoloConfigRegistry['media']
      services: typeof services
    }> = 'services.mailgun.secret'
    const queueDefault: string = accessors.useConfig('queue.default')
    const testEnv: HoloAppEnv = 'test'

    // @ts-expect-error Arrays should be treated as terminal values for dot-path autocomplete.
    const arrayMethodPath: DotPath<HoloConfigRegistry['app']> = 'models.length'

    void loadedServices
    void nestedSecret
    void secret
    void nestedPath
    void queueDefault
    void testEnv
    void arrayMethodPath
  })
})
