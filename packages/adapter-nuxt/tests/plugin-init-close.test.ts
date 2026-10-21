import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({
  initializeHoloAdapterProject: vi.fn(),
}))

vi.mock('@holo-js/core', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  initializeHoloAdapterProject: core.initializeHoloAdapterProject,
}))

vi.mock('#imports', () => ({
  defineNitroPlugin: <TPlugin>(plugin: TPlugin): TPlugin => plugin,
  useEvent: () => undefined,
  useRuntimeConfig: () => ({ holo: { projectRoot: '/holo-project' } }),
}))

type Deferred<TValue> = {
  promise: Promise<TValue>
  resolve(value: TValue): void
  reject(error: unknown): void
}

function deferred<TValue>(): Deferred<TValue> {
  let resolve!: (value: TValue) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<TValue>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function withTimeout<TValue>(promise: Promise<TValue>, ms: number): Promise<TValue> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function createNitroApp() {
  let closeHandler: (() => Promise<void>) | undefined
  const nitroApp = {
    h3App: { options: {} as { onRequest?: () => Promise<void> } },
    hooks: {
      hook(_name: 'close', handler: () => Promise<void>) {
        closeHandler = handler
      },
    },
  }
  return {
    nitroApp,
    close: async () => {
      if (!closeHandler) throw new Error('close hook was not registered')
      await closeHandler()
    },
  }
}

async function loadInitPlugin() {
  const { default: init } = await import('../src/runtime/plugins/init')
  return init as unknown as (nitroApp: ReturnType<typeof createNitroApp>['nitroApp']) => void
}

describe('Nuxt init plugin close hook', () => {
  beforeEach(() => {
    core.initializeHoloAdapterProject.mockReset()
  })

  it('returns from close without waiting for a pending initialization that a boot hook is waiting on', async () => {
    const initialization = deferred<unknown>()
    const shutdown = vi.fn(async () => undefined)
    core.initializeHoloAdapterProject.mockReturnValue(initialization.promise)
    const app = createNitroApp()

    ;(await loadInitPlugin())(app.nitroApp)

    await expect(withTimeout(app.close(), 1000)).resolves.toBeUndefined()
    expect(shutdown).not.toHaveBeenCalled()

    initialization.resolve({ runtime: { shutdown } })

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
  })

  it('runs shutdown once a pending initialization resolves, not before', async () => {
    const initialization = deferred<unknown>()
    const shutdown = vi.fn(async () => undefined)
    core.initializeHoloAdapterProject.mockReturnValue(initialization.promise)
    const app = createNitroApp()

    ;(await loadInitPlugin())(app.nitroApp)
    await app.close()

    expect(shutdown).not.toHaveBeenCalled()

    initialization.resolve({ runtime: { shutdown } })

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
  })

  it('does not shut down or throw when a pending initialization rejects', async () => {
    const initialization = deferred<unknown>()
    core.initializeHoloAdapterProject.mockReturnValue(initialization.promise)
    const app = createNitroApp()

    ;(await loadInitPlugin())(app.nitroApp)
    await expect(withTimeout(app.close(), 1000)).resolves.toBeUndefined()

    initialization.reject(new Error('boot failed'))
    await expect(initialization.promise).rejects.toThrow('boot failed')
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('awaits shutdown when close runs after initialization has settled', async () => {
    const initialization = deferred<unknown>()
    const shutdownDone = deferred<void>()
    const shutdown = vi.fn(() => shutdownDone.promise)
    core.initializeHoloAdapterProject.mockReturnValue(initialization.promise)
    const app = createNitroApp()

    ;(await loadInitPlugin())(app.nitroApp)
    initialization.resolve({ runtime: { shutdown } })
    await initialization.promise

    let closed = false
    const closing = app.close().then(() => {
      closed = true
    })

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closed).toBe(false)

    shutdownDone.resolve()
    await closing
    expect(closed).toBe(true)
  })
})
