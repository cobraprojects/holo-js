import { describe, it } from 'vitest'
import {
  createConfigAccessors,
  defineBroadcastConfig,
  type HoloConfigRegistry,
} from '../src'

describe('@holo-js/config broadcast typing', () => {
  it('preserves broadcast inference through config helpers and dot-path access', () => {
    const broadcast = defineBroadcastConfig({
      default: 'reverb',
      connections: {
        reverb: {
          driver: 'holo',
          key: 'app-key',
          secret: 'app-secret',
          appId: 'app-id',
          options: {
            host: 'ws.example.com',
            port: 443,
            scheme: 'https',
          },
        },
        null: {
          driver: 'null',
        },
      },
    })

    const accessors = createConfigAccessors({
      app: {} as HoloConfigRegistry['app'],
      database: {} as HoloConfigRegistry['database'],
      storage: {} as HoloConfigRegistry['storage'],
      queue: {} as HoloConfigRegistry['queue'],
      broadcast: broadcast as unknown as HoloConfigRegistry['broadcast'],
      mail: {} as HoloConfigRegistry['mail'],
      notifications: {} as HoloConfigRegistry['notifications'],
      media: {} as HoloConfigRegistry['media'],
      session: {} as HoloConfigRegistry['session'],
      auth: {} as HoloConfigRegistry['auth'],
      services: {} as HoloConfigRegistry['services'],
    })

    const defaultConnection: string = accessors.useConfig('broadcast.default')
    const reverbDriver = accessors.useConfig('broadcast.connections.reverb.driver') as string

    void defaultConnection
    void reverbDriver
  })
})
