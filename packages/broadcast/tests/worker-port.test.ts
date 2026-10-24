import { expect, it, onTestFinished } from 'vitest'
import { normalizeBroadcastConfig, startBroadcastWorker } from '../src'

const connection = { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } as const

function configWithWorkerPort(port: number | string) {
  return normalizeBroadcastConfig({
    default: 'main',
    connections: { main: connection },
    worker: { host: '127.0.0.1', port },
  })
}

it('binds an operating-system assigned port when the worker port is 0 and reports the bound port', async () => {
  const config = configWithWorkerPort(0)
  expect(config.worker.port).toBe(0)
  const worker = await startBroadcastWorker({ config })
  onTestFinished(() => worker.stop())
  expect(worker.port).toBeGreaterThan(0)
  expect((await fetch(`http://127.0.0.1:${worker.port}/health`)).status).toBe(200)
})

it.each([-1, 1.5, 'abc', 65_536])('rejects the worker port %s', (port) => {
  expect(() => configWithWorkerPort(port)).toThrow('[Holo Broadcast] Broadcast worker port must be an integer between 0 and 65535.')
})

it('keeps requiring a non-zero public and connection port within range', () => {
  for (const port of [0, 65_536]) {
    expect(() => normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { ...connection, options: { port } } },
    })).toThrow('[Holo Broadcast] Broadcast connection "main" options port must be an integer between 1 and 65535.')
  }
  expect(() => normalizeBroadcastConfig({
    default: 'main',
    connections: { main: connection },
    worker: { publicPort: 0 },
  })).toThrow('[Holo Broadcast] Broadcast worker public port must be an integer between 1 and 65535.')
})

it('reports the port Bun bound when the worker port is 0', async () => {
  const bunGlobal = globalThis as typeof globalThis & { Bun?: unknown }
  bunGlobal.Bun = { serve: () => ({ port: 43_210, stop() {}, upgrade: () => false }) }
  onTestFinished(() => { delete bunGlobal.Bun })
  const worker = await startBroadcastWorker({ config: configWithWorkerPort(0) })
  onTestFinished(() => worker.stop())
  expect(worker.port).toBe(43_210)
})
