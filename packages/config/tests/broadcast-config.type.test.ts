import { describe, it } from 'vitest'
import type {
  HoloConfigRegistry,
} from '../src'
import { defineBroadcastConfig } from '@holo-js/broadcast'
import { createConfigAccessorFixture } from './support/configAccessors'

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

    const accessors = createConfigAccessorFixture({
      broadcast: broadcast as unknown as HoloConfigRegistry['broadcast'],
      services: {
        mailgun: {
          secret: 'secret',
        },
      },
    })

    const defaultConnection: string = accessors.useConfig('broadcast.default')
    const reverbDriver = accessors.useConfig('broadcast.connections.reverb.driver') as string

    void defaultConnection
    void reverbDriver
  })
})
