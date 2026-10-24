import { spawn } from 'node:child_process'
import { expect, inject, it, onTestFinished } from 'vitest'
import { nextBin, nextEnv } from './support/next-first-visit-app'

it('uses the proxy session for the first route token and submission in native Next', async () => {
  const server = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: inject('nextFirstVisitRoot'),
    env: nextEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onTestFinished(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return
    const closed = new Promise<void>(resolve => server.once('exit', () => resolve()))
    server.kill('SIGTERM')
    await closed
  })
  let output = ''
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const inspect = (chunk: Buffer) => {
      output += chunk.toString()
      const url = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]
      if (url) resolve(url)
    }
    server.stdout.on('data', inspect)
    server.stderr.on('data', inspect)
    server.once('exit', () => reject(new Error(`Next exited before it was listening:\n${output}`)))
  })
  const first = await fetch(`${baseUrl}/api/token`)
  expect(first.status, output).toBe(200)
  const payload: unknown = await first.json()
  if (!payload || typeof payload !== 'object' || !('token' in payload) || typeof payload.token !== 'string') {
    throw new Error('Expected the token endpoint response')
  }
  const cookies = first.headers.getSetCookie()
  expect(cookies.filter(cookie => cookie.startsWith('holo_session='))).toHaveLength(1)
  const submitted = await fetch(`${baseUrl}/api/submit`, {
    method: 'POST',
    headers: { cookie: cookies.map(cookie => cookie.split(';', 1)[0]).join('; '), 'X-CSRF-TOKEN': payload.token },
  })
  expect(submitted.status, output).toBe(200)
  await expect(submitted.json()).resolves.toEqual({ ok: true })
}, 120_000)
