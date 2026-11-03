import assert from 'node:assert/strict'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { sendFetchThroughConnectionResetSafeDispatcher } from './example-app-fetch.mjs'

const serverResettingOnRequest = `
  const { parentPort, workerData: resetSignal } = require('node:worker_threads')
  const server = require('node:net').createServer()
  const accepted = new Promise(resolve => server.once('connection', resolve))
  parentPort.on('message', async () => {
    const socket = await accepted
    socket.resetAndDestroy()
    Atomics.store(resetSignal, 0, 1)
    Atomics.notify(resetSignal, 0)
  })
  server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port))
`

const resetConfirmationTimeoutMilliseconds = 10_000

test('a journey fetch whose connection is reset before its first write rejects instead of crashing the journey', async (t) => {
  sendFetchThroughConnectionResetSafeDispatcher()
  const resetSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const server = new Worker(serverResettingOnRequest, { eval: true, workerData: resetSignal })
  t.after(() => server.terminate())
  const [port] = await once(server, 'message')
  let connectionResetBeforeFirstWrite = false
  const resetBeforeFirstWrite = () => {
    server.postMessage('reset')
    connectionResetBeforeFirstWrite = Atomics.wait(resetSignal, 0, 0, resetConfirmationTimeoutMilliseconds) !== 'timed-out'
  }
  subscribe('undici:client:connected', resetBeforeFirstWrite)
  t.after(() => unsubscribe('undici:client:connected', resetBeforeFirstWrite))

  const error = await fetch(`http://127.0.0.1:${port}/`).then(() => undefined, rejection => rejection)

  assert.ok(connectionResetBeforeFirstWrite, 'The server must reset the connection after it opens and before the first write')
  assert.ok(error instanceof TypeError, `The fetch must reject, but it resolved or threw ${error}`)
  assert.ok(['ECONNRESET', 'EPIPE'].includes(error.cause?.code), `The fetch must reject with the dropped connection, not ${error.cause?.code ?? error.cause}`)
})
