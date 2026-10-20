import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { installNextShutdown } from '../src/shutdown'

const shutdownSource = pathToFileURL(resolve(import.meta.dirname, '../src/shutdown.ts')).href
const runtimeSource = pathToFileURL(resolve(import.meta.dirname, '../src/runtime.ts')).href
const blogNextRoot = resolve(import.meta.dirname, '../../../apps/blog-next')

type ChildResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function runChild(script: string, options: { readonly signalAfterReady?: NodeJS.Signals } = {}): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, DB_DRIVER: 'sqlite', DB_URL: ':memory:', DB_SQLITE_URL: ':memory:' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
  })
}

const prelude = `
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const { installNextShutdown } = await import(${JSON.stringify(shutdownSource)})
  const holdOpen = () => setInterval(() => {}, 1000)
`

describe('Next termination shutdown', () => {
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

  it('closes after a host listener that was registered before Holo has run to completion', async () => {
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

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'host:drain', 'host:drained', 'close:done'])
    expect(result.code).toBe(143)
  })

  it('exits with the signal exit code after closing when no other handler is installed', async () => {
    const result = await runChild(`
      ${prelude}
      installNextShutdown({
        close: async () => {
          console.log('close:done')
        },
        report: error => console.log('reported', error),
      })
      console.log('ready')
      holdOpen()
    `, { signalAfterReady: 'SIGTERM' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'close:done'])
    expect(result.code).toBe(143)
  })

  it('reports a failed close through the injected reporter and still exits', async () => {
    const result = await runChild(`
      ${prelude}
      installNextShutdown({
        close: async () => {
          throw new Error('redis closed during shutdown')
        },
        report: (error, context) => console.log('reported', context.capability, context.operation, error.message),
      })
      console.log('ready')
      holdOpen()
    `, { signalAfterReady: 'SIGINT' })

    expect(result.stdout.trim().split('\n')).toEqual(['ready', 'reported next shutdown redis closed during shutdown'])
    expect(result.code).toBe(130)
  })

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
})
