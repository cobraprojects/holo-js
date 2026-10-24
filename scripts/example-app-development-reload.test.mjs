import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertExampleAppDevelopmentReload } from '../tests/example-app-development-reload.mjs'

const appConfig = "export default defineAppConfig({\n  name: env('APP_NAME', 'fake-app'),\n})\n"

// A development app that reads its name from config/app.ts and .env.local on every request, like a reloaded server.
async function startFakeDevelopmentApp(context, respond = () => undefined) {
  const cwd = await mkdtemp(join(tmpdir(), 'holo-dev-reload-'))
  context.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, 'config'))
  await writeFile(join(cwd, 'config/app.ts'), appConfig)
  const readName = async () => {
    const config = await readFile(join(cwd, 'config/app.ts'), 'utf8')
    const configured = config.match(/name: '([^']+)'/)?.[1]
    if (configured) return configured
    const local = await readFile(join(cwd, '.env.local'), 'utf8').catch(() => '')
    return local.match(/^APP_NAME=(.+)$/gm)?.at(-1)?.slice('APP_NAME='.length) ?? 'fake-app'
  }
  const server = createServer(async (request, response) => {
    const name = await readName()
    if (respond(name, request, response) === 'handled') return
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ name }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise(resolve => server.close(resolve)))
  return { cwd, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

test('a development reload passes through restart answers and names written earlier', async context => {
  const requests = new Map([['fake-app', 4]])
  let served = 'fake-app'
  const app = await startFakeDevelopmentApp(context, (name, request, response) => {
    // Each new name is first answered by the server still running the previous one, which then drops a request
    // as it stops, before and after sending headers, and then by a starting server.
    const count = (requests.get(name) ?? 0) + 1
    requests.set(name, count)
    if (count === 1) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name: served }))
      return 'handled'
    }
    if (count === 2) {
      request.socket.destroy()
      return 'handled'
    }
    if (count === 3) {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' })
      response.write('{"na', () => request.socket.destroy())
      return 'handled'
    }
    if (count === 4) {
      response.statusCode = 503
      response.end('<title>Starting Nuxt... | Nuxt</title>')
      return 'handled'
    }
    served = name
    return undefined
  })

  await assertExampleAppDevelopmentReload(app)
  assert.equal(await readFile(join(app.cwd, 'config/app.ts'), 'utf8'), appConfig)
  await assert.rejects(readFile(join(app.cwd, '.env.local')), { code: 'ENOENT' })
})

test('a development reload reports another server answering on its port at once', { timeout: 10000 }, async context => {
  const app = await startFakeDevelopmentApp(context, (name, request, response) => {
    if (!name.startsWith('holo-dev-first-')) return undefined
    response.statusCode = 404
    response.end('Cannot GET /api/framework/config')
    return 'handled'
  })

  await assert.rejects(assertExampleAppDevelopmentReload(app), error => {
    assert.match(error.message, /404/)
    assert.match(error.message, /Cannot GET \/api\/framework\/config/)
    return true
  })
})

test('a development reload reports an answer that is not the app config at once', { timeout: 10000 }, async context => {
  const app = await startFakeDevelopmentApp(context, (name, request, response) => {
    if (!name.startsWith('holo-dev-first-')) return undefined
    response.end('<!doctype html><title>Another app</title>')
    return 'handled'
  })

  await assert.rejects(assertExampleAppDevelopmentReload(app), error => {
    assert.match(error.message, /Another app/)
    return true
  })
})
