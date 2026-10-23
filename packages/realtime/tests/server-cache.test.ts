import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
const temporaryDirectories: string[] = []
const realtimeEntry = JSON.stringify(resolve(import.meta.dirname, '../dist/index.mjs'))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function createProject() {
  const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-cache-'))
  temporaryDirectories.push(projectRoot)
  const realtimeRoot = join(projectRoot, 'server/realtime')
  await mkdir(realtimeRoot, { recursive: true })
  const definitionPath = join(realtimeRoot, 'definition.ts')
  const dependencyPath = join(realtimeRoot, 'value.ts')
  const definition = (handler: string, imports = '') => `
    import { defineRealtimeQuery } from ${realtimeEntry}
    ${imports}
    export default defineRealtimeQuery({ name: 'cache.consistent', access: 'public', handler: ${handler} })
  `
  await writeFile(dependencyPath, "export const version = '1'")
  await writeFile(definitionPath, definition('() => [{ version }]', "import { version } from './value'"))
  const serverModule = new URL('../dist/server.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createServer } from 'node:http'
    import { once } from 'node:events'
    import { createDatabase, createDialect } from '@holo-js/db'
    import { createSQLiteAdapter } from '@holo-js/db-sqlite'
    import { configureRealtimeRuntime, handleRealtimeQueryRequest, resetRealtimeRuntime } from ${JSON.stringify(serverModule)}
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
    configureRealtimeRuntime({ db: () => db })
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const result = await handleRealtimeQueryRequest(new Request('https://app.test/realtime/query', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks)
      }), { projectRoot: ${JSON.stringify(projectRoot)} })
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(await result.text())
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    console.log(server.address().port)
    for await (const chunk of process.stdin) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      resetRealtimeRuntime()
      await db.disconnect()
      break
    }
  `], { cwd: resolve(import.meta.dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const lines = createInterface({ input: child.stdout })
  onTestFinished(async () => {
    lines.close()
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.stdin.end('stop')
      await exited
    }
    expect(child.exitCode, errors).toBe(0)
  })
  const port = await Promise.race([
    once(lines, 'line').then(([line]) => Number(line)),
    once(child, 'exit').then(() => { throw new Error(errors || 'Native realtime server exited before startup') }),
  ])
  return {
    projectRoot, definitionPath, dependencyPath, definition,
    async query() {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST', body: JSON.stringify({ name: 'cache.consistent', args: {} }),
      })
      return { status: response.status, body: await response.json() as { data?: Array<{ version: string }>; message?: string } }
    },
  }
}

it('serves newly edited realtime dependencies consistently through the public query handler and removes obsolete bundles', async () => {
  const app = await createProject()
  const initial = await app.query()
  expect(initial.status, JSON.stringify(initial.body)).toBe(200)
  expect(initial.body.data).toEqual([{ version: '1' }])
  const runtimeRoot = join(app.projectRoot, '.holo-js/runtime')
  const initialBundles = await readdir(runtimeRoot)
  await writeFile(app.dependencyPath, "export const version = 'updated'")
  const results = await Promise.all(Array.from({ length: 4 }, () => app.query()))
  for (const result of results) {
    expect(result.status).toBe(200)
    expect(result.body.data).toEqual([{ version: 'updated' }])
  }
  for (const bundle of initialBundles) await expect(stat(join(runtimeRoot, bundle))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports an actually missing dependency and recovers after the application removes that import', async () => {
  const app = await createProject()
  expect((await app.query()).status).toBe(200)
  await rm(app.dependencyPath)
  const missing = await app.query()
  expect(missing.status, JSON.stringify(missing.body)).toBe(400)
  expect(missing.body.message).toContain('Could not resolve')
  await writeFile(app.definitionPath, app.definition("() => [{ version: 'removed' }]"))
  const recovered = await app.query()
  expect(recovered.status).toBe(200)
  expect(recovered.body.data).toEqual([{ version: 'removed' }])
})

it('cleans abandoned realtime bundles while preserving live process bundles and unrelated files', async () => {
  const app = await createProject()
  const runtimeRoot = join(app.projectRoot, '.holo-js/runtime')
  const dead = join(runtimeRoot, 'realtime-2147483647-dead')
  const live = join(runtimeRoot, `realtime-${process.pid}-live`)
  const legacy = join(runtimeRoot, 'realtime-legacy')
  const unrelated = join(runtimeRoot, 'unrelated')
  await Promise.all([dead, live, legacy, unrelated].map(path => mkdir(path, { recursive: true })))
  const response = await app.query()
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.data).toEqual([{ version: '1' }])
  for (const path of [dead, legacy]) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const path of [live, unrelated]) await expect(stat(path)).resolves.toBeDefined()
})

it('keeps native module-relative resources usable by application package handlers after loading and caching', async () => {
  const app = await createProject()
  const resourcePackage = join(app.projectRoot, 'node_modules/native-realtime-resource')
  await mkdir(resourcePackage, { recursive: true })
  await writeFile(join(resourcePackage, 'package.json'), JSON.stringify({ name: 'native-realtime-resource', type: 'module', exports: './index.mjs' }))
  await writeFile(join(resourcePackage, 'index.mjs'), "import { readFile } from 'node:fs/promises'; export async function readResource() { return await readFile(new URL('./resource.txt', import.meta.url), 'utf8') }")
  await writeFile(join(resourcePackage, 'resource.txt'), 'native resource')
  await writeFile(app.definitionPath, app.definition('async () => [{ version: await readResource() }]', "import { readResource } from 'native-realtime-resource'"))
  for (let request = 0; request < 2; request++) {
    const response = await app.query()
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.data).toEqual([{ version: 'native resource' }])
  }
})
