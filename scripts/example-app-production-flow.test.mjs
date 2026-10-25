import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertFailedProductionInitialization } from '../tests/example-app-production-flow.mjs'

const driverError = 'Unsupported Holo database driver "invalid"'

async function availablePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

// A production app whose `start` script runs a server that answers every request with a 500 naming the driver error.
async function createFailingProductionApp(context, { logs }) {
  const cwd = await mkdtemp(join(tmpdir(), 'holo-production-init-'))
  context.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }))
  await writeFile(join(cwd, 'server.mjs'), `
import { createServer } from 'node:http'
const port = Number(process.argv.find(argument => argument.startsWith('--port=')).slice('--port='.length))
createServer((request, response) => {
  response.statusCode = 500
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ message: ${JSON.stringify(driverError)} }), () => {
    ${logs ? `console.error(${JSON.stringify(`[holo] ${driverError}`)})` : ''}
  })
}).listen(port, '127.0.0.1')
`)
  const port = await availablePort()
  return { cwd, baseUrl: `http://127.0.0.1:${port}`, portArguments: [`--port=${port}`] }
}

test('a failed production initialization passes when the server logs the error after its 500 response', async context => {
  const app = await createFailingProductionApp(context, { logs: true })

  await assertFailedProductionInitialization(app.cwd, app.baseUrl, {}, app.portArguments)
})

test('a failed production initialization fails when only the 500 response names the error', { timeout: 30000 }, async context => {
  const app = await createFailingProductionApp(context, { logs: false })

  await assert.rejects(assertFailedProductionInitialization(app.cwd, app.baseUrl, {}, app.portArguments), /must log why database initialization failed/)
})

test('a failed production initialization passes when the server logs the error just before it exits', { timeout: 10000 }, async context => {
  const cwd = await mkdtemp(join(tmpdir(), 'holo-production-init-'))
  context.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }))
  // The server never listens: it logs why initialization failed and exits, which can finish before its output drains.
  await writeFile(join(cwd, 'server.mjs'), `process.stderr.write(${JSON.stringify(`[holo] ${driverError}\n`)}, () => process.exit(1))\n`)
  const port = await availablePort()

  await assertFailedProductionInitialization(cwd, `http://127.0.0.1:${port}`, {}, [`--port=${port}`])
})

test('a failed production initialization fails at once when the server exits without logging the error', { timeout: 10000 }, async context => {
  const cwd = await mkdtemp(join(tmpdir(), 'holo-production-init-'))
  context.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }))
  await writeFile(join(cwd, 'server.mjs'), 'process.exit(1)\n')
  const port = await availablePort()

  await assert.rejects(assertFailedProductionInitialization(cwd, `http://127.0.0.1:${port}`, {}, [`--port=${port}`]), /must log why database initialization failed/)
})
