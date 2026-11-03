import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { test } from 'node:test'
import { sendFetchThroughConnectionResetSafeDispatcher } from './example-app-fetch.mjs'

const resettingServer = `
  const server = require('node:net').createServer(socket => socket.resetAndDestroy())
  server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)))
`

function blockEventLoop(milliseconds) {
  const until = Date.now() + milliseconds
  while (Date.now() < until);
}

test('a journey fetch whose connection is reset before its first write rejects instead of crashing the journey', async (t) => {
  sendFetchThroughConnectionResetSafeDispatcher()
  const server = spawn(process.execPath, ['-e', resettingServer], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => server.kill())
  const [port] = await once(server.stdout, 'data')
  const connected = []
  const resetBeforeFirstWrite = () => {
    connected.push(Date.now())
    blockEventLoop(200)
  }
  subscribe('undici:client:connected', resetBeforeFirstWrite)
  t.after(() => unsubscribe('undici:client:connected', resetBeforeFirstWrite))

  const error = await fetch(`http://127.0.0.1:${port}/`).then(() => undefined, rejection => rejection)

  assert.equal(connected.length, 1, 'The connection must open before the server resets it')
  assert.ok(error instanceof TypeError, `The fetch must reject, but it resolved or threw ${error}`)
  assert.ok(['ECONNRESET', 'EPIPE'].includes(error.cause?.code), `The fetch must reject with the dropped connection, not ${error.cause?.code ?? error.cause}`)
})
