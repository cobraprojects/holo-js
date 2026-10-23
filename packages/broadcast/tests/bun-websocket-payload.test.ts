import { afterEach, describe, expect, it } from 'vitest'
import { normalizeBroadcastConfig, startBroadcastWorker } from '../src'

type CapturedBunServeOptions = {
  readonly websocket: { readonly maxPayloadLength?: number }
}

const bunGlobal = globalThis as typeof globalThis & { Bun?: unknown }

afterEach(() => {
  delete bunGlobal.Bun
})

describe('Bun broadcast websocket payload limit', () => {
  it('caps inbound frames at the configured worker message size before buffering them', async () => {
    let captured: CapturedBunServeOptions | undefined
    bunGlobal.Bun = {
      serve(options: CapturedBunServeOptions) {
        captured = options
        return { port: 0, stop() {}, upgrade: () => false }
      },
    }

    const worker = await startBroadcastWorker({
      config: normalizeBroadcastConfig({
        default: 'main',
        connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } },
        worker: { host: '127.0.0.1', port: 6100, maxMessageBytes: 512 },
      }),
    })
    await worker.stop()

    expect(captured?.websocket.maxPayloadLength).toBe(512)
  })
})
