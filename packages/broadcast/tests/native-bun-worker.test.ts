import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'
import { expect, it, onTestFinished } from 'vitest'

async function reservePort(): Promise<number> {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No worker port available')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function connectionCount(baseUrl: string): Promise<number> {
  return (await (await fetch(`${baseUrl}/stats`)).json() as { connectionCount: number }).connectionCount
}

async function startBunWorker(options: { readonly port: number, readonly worker?: Record<string, unknown>, readonly heartbeatIntervalMs?: number }) {
  const workerModule = new URL('../src/index.ts', import.meta.url).href
  const workerConfig = JSON.stringify({ host: '127.0.0.1', port: options.port, statsEnabled: true, ...options.worker })
  const child = spawn('bun', ['--eval', `
    import { normalizeBroadcastConfig, startBroadcastWorker } from ${JSON.stringify(workerModule)}
    const worker = await startBroadcastWorker({ config: normalizeBroadcastConfig({
      default: 'main', connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } },
      worker: ${workerConfig}
    }), heartbeatIntervalMs: ${JSON.stringify(options.heartbeatIntervalMs)} })
    console.log('ready')
    for await (const chunk of Bun.stdin.stream()) { await worker.stop(); break }
  `], { stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const lines = createInterface({ input: child.stdout })
  onTestFinished(async () => {
    lines.close()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
  })
  const readiness = await Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    once(child, 'exit').then(() => { throw new Error(errors || 'Bun worker exited before startup') }),
  ])
  expect(readiness).toBe('ready')
  return {
    stop: async () => {
      const exited = once(child, 'exit')
      child.stdin.end('stop')
      expect((await exited)[0], errors).toBe(0)
    },
  }
}

it('serves HTTP and WebSockets with the real Bun runtime, enforcing origins and message limits', async () => {
  const port = await reservePort()
  const worker = await startBunWorker({ port, worker: { allowedOrigins: ['https://app.example.test'], maxMessageBytes: 512 } })
  const baseUrl = `http://127.0.0.1:${port}`
  expect((await fetch(`${baseUrl}/health`)).status).toBe(200)
  expect((await fetch(`${baseUrl}/app/unknown`)).status).toBe(401)
  expect((await fetch(`${baseUrl}/app/main-key`, { headers: { Origin: 'https://evil.example.test' } })).status).toBe(403)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/app/main-key`, { origin: 'https://app.example.test' })
  onTestFinished(() => socket.terminate())
  const frames: Array<{ event: string; channel?: string }> = []
  socket.on('message', data => frames.push(JSON.parse(data.toString())))
  await once(socket, 'open')
  await expect.poll(() => frames.some(frame => frame.event === 'pusher:connection_established')).toBe(true)
  socket.send(Buffer.from(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'public.news' } })))
  await expect.poll(() => frames.some(frame => frame.event === 'pusher_internal:subscription_succeeded' && frame.channel === 'public.news')).toBe(true)
  socket.send(JSON.stringify({ event: 'pusher:ping', data: {} }))
  await expect.poll(() => frames.some(frame => frame.event === 'pusher:pong')).toBe(true)
  const closed = once(socket, 'close')
  socket.send('x'.repeat(513))
  expect((await closed)[0]).toBe(1009)
  await expect.poll(() => connectionCount(baseUrl)).toBe(0)
  await worker.stop()
}, 15_000)

it('pings Bun sockets and terminates the ones that stop answering, while sockets that answer stay open', async () => {
  const heartbeatIntervalMs = 100
  const port = await reservePort()
  const worker = await startBunWorker({ port, heartbeatIntervalMs })
  const baseUrl = `http://127.0.0.1:${port}`
  const silent = new WebSocket(`ws://127.0.0.1:${port}/app/main-key`, { autoPong: false })
  onTestFinished(() => silent.terminate())
  const answering = new WebSocket(`ws://127.0.0.1:${port}/app/main-key`)
  onTestFinished(() => answering.terminate())
  await Promise.all([once(silent, 'open'), once(answering, 'open')])
  const silentClosed = once(silent, 'close')

  expect((await silentClosed)[0]).toBe(1006)
  await expect.poll(() => connectionCount(baseUrl)).toBe(1)
  await new Promise(resolve => setTimeout(resolve, heartbeatIntervalMs * 5))
  expect(answering.readyState).toBe(WebSocket.OPEN)
  await expect.poll(() => connectionCount(baseUrl)).toBe(1)
  answering.terminate()
  await worker.stop()
}, 15_000)
