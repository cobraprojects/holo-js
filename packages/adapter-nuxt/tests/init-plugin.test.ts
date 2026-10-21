import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HoloCoreModule from '@holo-js/core'
import { errorReportingInternals } from '@holo-js/kernel/error-reporting'

type CloseHandler = () => Promise<void>

const initializeHoloAdapterProject = vi.hoisted(() => vi.fn())

vi.mock('@holo-js/core', async importOriginal => ({
  ...await importOriginal<typeof HoloCoreModule>(),
  initializeHoloAdapterProject,
}))

vi.mock('#imports', () => ({
  createError: (error: unknown) => error,
  defineNitroPlugin: (plugin: unknown) => plugin,
  useEvent: () => ({ node: { req: { socket: undefined } } }),
  useRuntimeConfig: () => ({ holo: { projectRoot: '/holo-nuxt-init-plugin' } }),
}))

async function startPlugin(): Promise<{ readonly close: CloseHandler }> {
  const { default: initPlugin } = await import('../src/runtime/plugins/init')
  let closeHandler: CloseHandler | undefined
  const nitroApp = {
    h3App: { options: {} },
    hooks: {
      hook(name: 'close', handler: CloseHandler) {
        if (name === 'close') closeHandler = handler
      },
    },
  }

  initPlugin(nitroApp as Parameters<typeof initPlugin>[0])
  if (!closeHandler) throw new Error('The init plugin did not register a close hook.')
  return { close: closeHandler }
}

describe('nuxt init plugin shutdown', () => {
  afterEach(() => {
    errorReportingInternals.configure(undefined)
    initializeHoloAdapterProject.mockReset()
    vi.resetModules()
  })

  it('reports a failed runtime shutdown through the error-reporting hook', async () => {
    const failure = new Error('Redis connection refused during shutdown')
    const reports: Array<{ error: unknown, context: { capability: string, operation: string } }> = []
    errorReportingInternals.configure({
      report(error, context) {
        reports.push({ error, context })
      },
    })
    initializeHoloAdapterProject.mockResolvedValue({
      runtime: { shutdown: vi.fn().mockRejectedValue(failure) },
    })

    const plugin = await startPlugin()
    await expect(plugin.close()).resolves.toBeUndefined()

    expect(reports).toEqual([{
      error: failure,
      context: { capability: 'nuxt', operation: 'shutdown' },
    }])
  })

  it('reports through the app reporter even when teardown removes it first', async () => {
    const failure = new Error('database pool closed during shutdown')
    const reports: unknown[] = []
    errorReportingInternals.configure({
      report(error) {
        reports.push(error)
      },
    })
    initializeHoloAdapterProject.mockResolvedValue({
      runtime: {
        shutdown: vi.fn(async () => {
          errorReportingInternals.configure(undefined)
          throw failure
        }),
      },
    })

    const plugin = await startPlugin()
    await plugin.close()

    expect(reports).toEqual([failure])
  })

  it('reports a failed shutdown during initialization through the reporter that initialization configures', async () => {
    const failure = new Error('database pool closed during startup shutdown')
    const reports: unknown[] = []
    let finishInitialization: (value: unknown) => void = () => {}
    initializeHoloAdapterProject.mockReturnValue(new Promise((resolve) => {
      finishInitialization = resolve
    }))

    const plugin = await startPlugin()
    const closing = plugin.close()
    errorReportingInternals.configure({
      report(error) {
        reports.push(error)
      },
    })
    finishInitialization({
      runtime: { shutdown: vi.fn().mockRejectedValue(failure) },
    })
    await closing
    await vi.waitFor(() => expect(reports).toEqual([failure]))
  })

  it('stays silent when the runtime shuts down cleanly', async () => {
    const reports: unknown[] = []
    errorReportingInternals.configure({
      report(error) {
        reports.push(error)
      },
    })
    initializeHoloAdapterProject.mockResolvedValue({
      runtime: { shutdown: vi.fn().mockResolvedValue(undefined) },
    })

    const plugin = await startPlugin()
    await plugin.close()

    expect(reports).toEqual([])
  })
})
