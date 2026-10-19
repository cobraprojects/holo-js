import { afterEach, describe, expect, it } from 'vitest'
import { defineChannel, configureBroadcastRuntime, normalizeBroadcastConfig, renderBroadcastAuthResponse, resetBroadcastRuntime, startBroadcastWorker } from '../src'

const credentialsMessage = /BROADCAST_APP_ID.*BROADCAST_APP_KEY.*BROADCAST_APP_SECRET/

afterEach(() => {
  resetBroadcastRuntime()
})

function holoConfigWithoutCredentials() {
  return normalizeBroadcastConfig({
    default: 'main',
    connections: {
      main: { driver: 'holo', options: { host: '127.0.0.1', port: 8080, scheme: 'http', useTLS: false } },
    },
    worker: { host: '127.0.0.1', port: 8080 },
  })
}

describe('broadcast credentials are required at first use', () => {
  it('loads a holo connection without credentials', () => {
    expect(holoConfigWithoutCredentials().connections.main).toMatchObject({ key: '', secret: '', appId: '' })
  })

  it('fails channel authorization that needs a signature and names the missing variables', async () => {
    configureBroadcastRuntime({
      channelAuth: {
        definitions: [
          defineChannel('orders.{orderId}', {
            type: 'private',
            authorize: () => true,
          }),
        ],
      },
    })

    await expect(renderBroadcastAuthResponse(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({ channel_name: 'private-orders.ord_5', socket_id: '123.456' }),
    }), {
      user: { id: 'ord_5' },
      appKey: '',
      appSecret: '',
    })).rejects.toThrow(credentialsMessage)
  })

  it('fails worker startup for a holo connection without credentials and names the missing variables', async () => {
    await expect(startBroadcastWorker({ config: holoConfigWithoutCredentials() })).rejects.toThrow(credentialsMessage)
  })
})
