import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveGeneratedProjectRegistryPath } from '@holo-js/core'
import { installNextShutdown } from '../src/shutdown'

const shutdownSource = pathToFileURL(resolve(import.meta.dirname, '../src/shutdown.ts')).href
const runtimeSource = pathToFileURL(resolve(import.meta.dirname, '../src/runtime.ts')).href
const blogNextRoot = resolve(import.meta.dirname, '../../../apps/blog-next')
const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const databaseConfigEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/databaseConfig.ts'))
const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function createHeldBootProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-next-held-boot-'))
  tempRoots.push(root)
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../../config'), join(root, 'node_modules/@holo-js/config'))
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Next App',
  key: 'base64:key',
  url: 'https://next.test',
  debug: false,
  env: 'production',
  plugins: ['holo-plugin-held-boot'],
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databaseConfigEntry}

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: ':memory:',
      logging: false,
    },
  },
})
`, 'utf8')
  const registryPath = resolveGeneratedProjectRegistryPath(root)
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  await writeFile(registryPath, `${JSON.stringify({
    version: 1,
    generatedAt: '2026-03-31T00:00:00.000Z',
    paths: {
      models: 'server/models',
      migrations: 'server/db/migrations',
      seeders: 'server/db/seeders',
      commands: 'server/commands',
      jobs: 'server/jobs',
      events: 'server/events',
      listeners: 'server/listeners',
      generatedSchema: 'server/db/schema.ts',
    },
    models: [],
    migrations: [],
    seeders: [],
    commands: [],
    jobs: [],
    events: [],
    listeners: [],
  }, null, 2)}\n`, 'utf8')
  const packageRoot = join(root, 'node_modules/holo-plugin-held-boot')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'holo-plugin-held-boot',
    type: 'module',
    holo: { plugin: './plugin.mjs' },
  }, null, 2), 'utf8')
  await writeFile(join(packageRoot, 'plugin.mjs'), `
export default {
  id: 'held-boot',
  name: 'Held Boot',
  contributes: {
    runtime: {
      boot: './boot.mjs',
    },
  },
}
`, 'utf8')
  await writeFile(join(packageRoot, 'boot.mjs'), `
export default async function boot() {
  const outcome = await globalThis.__holoBootGate__
  if (outcome === 'fail') throw new Error('held boot failed')
  globalThis.__holoBooted__ = true
}
`, 'utf8')
  return root
}

function heldInitScript(projectRoot: string, outcome: 'ok' | 'fail'): string {
  return `
    const { createNextHoloHelpers } = await import(${JSON.stringify(runtimeSource)})
    const { peekHolo } = await import('@holo-js/core/runtime')
    globalThis.__holoBootGate__ = new Promise(resolve => { globalThis.__holoRelease__ = resolve })
    const listenersBefore = process.listenerCount('SIGTERM')
    const holo = createNextHoloHelpers({ projectRoot: ${JSON.stringify(projectRoot)} })
    holo.getApp().then(() => console.log('init:resolved'), error => console.log('init:rejected', error.message))
    void holo.getApp().catch(() => {})
    console.log('listeners:' + (process.listenerCount('SIGTERM') - listenersBefore))
    console.log('ready')
    process.on('SIGTERM', () => {
      console.log('signal')
      setTimeout(() => {
        console.log('released')
        globalThis.__holoRelease__(${JSON.stringify(outcome)})
      }, 50)
      setTimeout(() => process.exit(143), 20)
    })
    process.on('exit', () => console.log('exit booted:' + Boolean(globalThis.__holoBooted__) + ' open:' + Boolean(peekHolo())))
    setInterval(() => {}, 1000)
  `
}

type ChildResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

function runChild(script: string, options: { readonly signalAfterReady?: NodeJS.Signals } = {}): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, DB_DRIVER: 'sqlite', DB_URL: ':memory:', DB_SQLITE_URL: ':memory:' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let signalled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!signalled && options.signalAfterReady && stdout.includes('ready\n')) {
        signalled = true
        child.kill(options.signalAfterReady)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => resolvePromise({ code, stdout, stderr, durationMs: Date.now() - startedAt }))
  })
}

const prelude = `
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const { installNextShutdown } = await import(${JSON.stringify(shutdownSource)})
  const holdOpen = () => setInterval(() => {}, 1000)
`

describe('Next termination shutdown', () => {
  it('closes Holo and lets the process end when a server drains on SIGTERM without calling exit', async () => {
    const result = await runChild(`
      const http = await import('node:http')
      const { installNextShutdown } = await import(${JSON.stringify(shutdownSource)})
      const server = http.createServer((request, response) => response.end('ok')).listen(0)
      const databaseHandle = setInterval(() => {}, 1000)
      installNextShutdown({
        close: async () => {
          clearInterval(databaseHandle)
          console.log('close:done')
        },
        report: error => console.log('reported', error),
      })
      process.on('SIGTERM', () => {
        console.log('server:drain')
        server.close()
      })
      console.log('ready')
    `, { signalAfterReady: 'SIGTERM' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'server:drain', 'close:done'])
    expect(result.code).toBe(143)
    expect(result.durationMs).toBeLessThan(10_000)
  }, 20_000)

  it('closes a runtime that a request re-initializes while the server is still draining', async () => {
    const result = await runChild(`
      const { installNextShutdown } = await import(${JSON.stringify(shutdownSource)})
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
      const closeRuntime = (name) => async () => {
        console.log('close:' + name)
      }
      const holdOpen = setInterval(() => {}, 1000)
      installNextShutdown({ close: closeRuntime('A'), report: error => console.log('reported', error) })
      process.on('SIGTERM', async () => {
        console.log('drain:start')
        await delay(20)
        console.log('drain:reinitialize')
        installNextShutdown({ close: closeRuntime('B'), report: error => console.log('reported', error) })
        await delay(40)
        process.exit(143)
      })
      process.on('exit', () => console.log('exit'))
      console.log('ready')
    `, { signalAfterReady: 'SIGTERM' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'drain:start', 'close:A', 'drain:reinitialize', 'close:B', 'exit'])
    expect(result.code).toBe(143)
  }, 20_000)

  it('restores process.exit and signal listeners when uninstalled', () => {
    const originalExit = process.exit
    const sigtermListeners = process.listenerCount('SIGTERM')
    const uninstall = installNextShutdown({ close: async () => {}, report: () => {} })

    expect(process.exit).not.toBe(originalExit)
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners + 1)
    uninstall()

    expect(process.exit).toBe(originalExit)
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners)
  })

  it('closes Holo resources after the server drains and before the process exits', async () => {
    const result = await runChild(`
      ${prelude}
      installNextShutdown({
        close: async () => {
          console.log('close:start')
          await delay(20)
          console.log('close:done')
        },
        report: error => console.log('reported', error),
      })
      process.on('SIGTERM', async () => {
        console.log('server:drain')
        await delay(20)
        process.exit(143)
      })
      console.log('ready')
      holdOpen()
    `, { signalAfterReady: 'SIGTERM' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'server:drain', 'close:start', 'close:done'])
    expect(result.code).toBe(143)
  })

  it('closes at the signal even while another SIGTERM listener is still draining', async () => {
    const result = await runChild(`
      ${prelude}
      process.once('SIGTERM', async () => {
        console.log('host:drain')
        await delay(20)
        console.log('host:drained')
        process.exit(143)
      })
      installNextShutdown({
        close: async () => {
          console.log('close:done')
        },
        report: error => console.log('reported', error),
      })
      console.log('ready')
      holdOpen()
    `, { signalAfterReady: 'SIGTERM' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'host:drain', 'close:done', 'host:drained'])
    expect(result.code).toBe(143)
  })

  it('exits with the signal exit code once close releases the open handles when no other handler is installed', async () => {
    const result = await runChild(`
      ${prelude}
      const databaseHandle = holdOpen()
      installNextShutdown({
        close: async () => {
          clearInterval(databaseHandle)
          console.log('close:done')
        },
        report: error => console.log('reported', error),
      })
      console.log('ready')
    `, { signalAfterReady: 'SIGTERM' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'close:done'])
    expect(result.code).toBe(143)
    expect(result.durationMs).toBeLessThan(10_000)
  })

  it('reports a failed close through the injected reporter and still exits', async () => {
    const result = await runChild(`
      ${prelude}
      const databaseHandle = holdOpen()
      installNextShutdown({
        close: async () => {
          clearInterval(databaseHandle)
          throw new Error('redis closed during shutdown')
        },
        report: (error, context) => console.log('reported', context.capability, context.operation, error.message),
      })
      console.log('ready')
    `, { signalAfterReady: 'SIGINT' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'reported next shutdown redis closed during shutdown'])
    expect(result.code).toBe(130)
    expect(result.durationMs).toBeLessThan(10_000)
  }, 20_000)

  it('leaves exits that are not caused by a termination signal alone', async () => {
    const result = await runChild(`
      ${prelude}
      installNextShutdown({
        close: async () => {
          console.log('close:called')
        },
        report: error => console.log('reported', error),
      })
      process.exit(3)
      console.log('after-exit')
    `)

    expect(result.stdout).toBe('')
    expect(result.code).toBe(3)
  })

  it('releases the Holo runtime when a Next server process is terminated', async () => {
    const result = await runChild(`
      const { createNextHoloHelpers } = await import(${JSON.stringify(runtimeSource)})
      const { peekHolo } = await import('@holo-js/core/runtime')
      const holo = createNextHoloHelpers({ projectRoot: ${JSON.stringify(blogNextRoot)} })
      await holo.getApp()
      console.log(peekHolo() ? 'runtime:open' : 'runtime:missing')
      process.on('SIGTERM', async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        process.on('exit', () => console.log(peekHolo() ? 'runtime:open-at-exit' : 'runtime:closed-at-exit'))
        process.exit(143)
      })
      console.log('ready')
      setInterval(() => {}, 1000)
    `, { signalAfterReady: 'SIGTERM' })

    expect(result.stdout).toContain('runtime:open')
    expect(result.stdout).toContain('runtime:closed-at-exit')
    expect(result.code).toBe(143)
  }, 60_000)

  it('shuts the runtime down when a termination signal arrives while initialization is still held open', async () => {
    const root = await createHeldBootProject()
    const result = await runChild(heldInitScript(root, 'ok'), { signalAfterReady: 'SIGTERM' })

    expect(result.stdout.trim().split('\n').filter(line => !line.startsWith('init:'))).toEqual([
      'listeners:1',
      'ready',
      'signal',
      'released',
      'exit booted:true open:false',
    ])
    expect(result.code).toBe(143)
  }, 20_000)

  it('exits cleanly when a termination signal arrives while initialization is held open and then rejects', async () => {
    const root = await createHeldBootProject()
    const result = await runChild(heldInitScript(root, 'fail'), { signalAfterReady: 'SIGTERM' })

    expect(result.stdout).toContain('init:rejected held boot failed')
    expect(result.stdout.trim().split('\n').filter(line => !line.startsWith('init:'))).toEqual([
      'listeners:1',
      'ready',
      'signal',
      'released',
      'exit booted:false open:false',
    ])
    expect(result.stderr).not.toContain('Unhandled')
    expect(result.code).toBe(143)
  }, 20_000)
})
