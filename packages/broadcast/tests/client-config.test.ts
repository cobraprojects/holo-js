import { describe, expect, it } from 'vitest'
import { normalizeBroadcastConfig } from '@holo-js/config'
import {
  renderBroadcastClientConfigResponse,
  resolveBroadcastClientConfig,
} from '../src/client-config'

describe('@holo-js/broadcast client config', () => {
  it('exposes only browser-safe Holo websocket options', async () => {
    const config = normalizeBroadcastConfig({
      default: 'holo',
      connections: {
        holo: {
          driver: 'holo',
          appId: 'app-id',
          key: 'app-key',
          secret: 'app-secret',
          options: {
            host: '127.0.0.1',
            port: 6100,
            scheme: 'http',
          },
        },
      },
    })

    expect(resolveBroadcastClientConfig(config)).toEqual({
      key: 'app-key',
      host: '127.0.0.1',
      port: 6100,
      path: '/app',
      scheme: 'http',
    })

    const response = renderBroadcastClientConfigResponse(config)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      key: 'app-key',
      host: '127.0.0.1',
      port: 6100,
      path: '/app',
      scheme: 'http',
    })
  })

  it('uses explicit public worker networking when configured', () => {
    const config = normalizeBroadcastConfig({
      default: 'holo',
      connections: {
        holo: {
          driver: 'holo',
          appId: 'app-id',
          key: 'app-key',
          secret: 'app-secret',
          options: {
            host: '127.0.0.1',
            port: 6100,
            scheme: 'http',
          },
        },
      },
      worker: {
        publicHost: 'ws.example.com',
        publicPort: 443,
        publicScheme: 'https',
      },
    })

    expect(resolveBroadcastClientConfig(config)).toEqual({
      key: 'app-key',
      host: 'ws.example.com',
      port: 443,
      path: '/app',
      scheme: 'https',
    })
  })

  it('rejects non-Holo default broadcast connections', () => {
    const config = normalizeBroadcastConfig({
      default: 'log',
      connections: {
        log: {
          driver: 'log',
        },
      },
    })

    expect(() => resolveBroadcastClientConfig(config)).toThrow('requires the default broadcast connection to use the "holo" driver')
  })
})
