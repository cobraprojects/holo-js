import { describe, expect, it } from 'vitest'
import { createManagedResources, holdOperations } from '../src/managedResources'
import { errorReportingInternals } from '../src/errorReporting'

function createRecordingResource(name: string, closed: string[]): { readonly name: string, close(): Promise<void> } {
  return {
    name,
    async close() {
      closed.push(name)
    },
  }
}

describe('managed resources', () => {
  it('keeps a replaced resource open while an operation holds it and closes it when that operation settles', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const first = await resources.acquire('first', config => createRecordingResource(config, closed))
    await resources.commit()
    let settle: () => void = () => undefined
    const operation = first.hold(() => new Promise<void>(resolve => { settle = resolve }))

    await resources.acquire('second', config => createRecordingResource(config, closed))
    await resources.commit()
    expect(closed).toEqual([])

    settle()
    await operation
    await expect.poll(() => closed).toEqual(['first'])
  })

  it('keeps no replaced resource after repeated reconfigurations with nothing in flight', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()

    for (const config of ['first', 'second', 'third', 'fourth']) {
      await resources.acquire(config, value => createRecordingResource(value, closed))
      await resources.commit()
    }

    expect(closed).toEqual(['first', 'second', 'third'])
    await resources.dispose()
    expect(closed.sort()).toEqual(['first', 'fourth', 'second', 'third'].sort())
  })

  it('reuses a retained resource when its config returns and keeps it open when the pass that revived it is discarded', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const first = await resources.acquire('first', config => createRecordingResource(config, closed))
    await resources.commit()
    let settle: () => void = () => undefined
    const operation = first.hold(() => new Promise<void>(resolve => { settle = resolve }))
    await resources.acquire('second', config => createRecordingResource(config, closed))
    await resources.commit()

    const revived = await resources.acquire('first', config => createRecordingResource(config, closed))
    await resources.discard()
    expect(revived.value.name).toBe('first')
    expect(closed).toEqual([])

    settle()
    await operation
    await resources.dispose()
    expect(closed.sort()).toEqual(['first', 'second'])
  })

  it('keeps a revived resource open when its replaced operation settles before the pass that revived it commits', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const first = await resources.acquire('first', config => createRecordingResource(config, closed))
    await resources.commit()
    let settle: () => void = () => undefined
    const operation = first.hold(() => new Promise<void>(resolve => { settle = resolve }))
    await resources.acquire('second', config => createRecordingResource(config, closed))
    await resources.commit()

    await resources.acquire('first', config => createRecordingResource(config, closed))
    settle()
    await operation
    await Promise.resolve()
    expect(closed).toEqual([])

    await resources.commit()
    await resources.dispose()
    expect(closed.sort()).toEqual(['first', 'second'])
  })

  it('closes a discarded revival once the operation that still holds it settles', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const first = await resources.acquire('first', config => createRecordingResource(config, closed))
    await resources.commit()
    let settle: () => void = () => undefined
    const operation = first.hold(() => new Promise<void>(resolve => { settle = resolve }))
    await resources.acquire('second', config => createRecordingResource(config, closed))
    await resources.commit()
    await resources.acquire('first', config => createRecordingResource(config, closed))
    await resources.discard()
    expect(closed).toEqual([])

    settle()
    await operation
    await expect.poll(() => closed).toEqual(['first'])
  })

  it('waits for a replaced resource that is still closing when the runtime disposes', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, { readonly name: string, close(): Promise<void> }>()
    let finishClose: () => void = () => undefined
    const slowClose = new Promise<void>(resolve => { finishClose = resolve })
    const first = await resources.acquire('first', name => ({
      name,
      async close() {
        await slowClose
        closed.push(name)
      },
    }))
    await resources.commit()
    let settle: () => void = () => undefined
    const operation = first.hold(() => new Promise<void>(resolve => { settle = resolve }))
    await resources.acquire('second', config => createRecordingResource(config, closed))
    await resources.commit()

    settle()
    await operation
    let disposed = false
    const dispose = resources.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(disposed).toBe(false)

    finishClose()
    await dispose
    expect(closed.sort()).toEqual(['first', 'second'])
  })

  it('disposes a resource acquired but never committed once its held operation settles', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const only = await resources.acquire('only', config => createRecordingResource(config, closed))
    let settle: () => void = () => undefined
    const operation = only.hold(() => new Promise<void>(resolve => { settle = resolve }))

    const disposing = resources.dispose()
    settle()
    await operation
    await disposing
    expect(closed).toEqual(['only'])
  })

  it('keeps an active resource open during dispose until its held operation settles', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const only = await resources.acquire('only', config => createRecordingResource(config, closed))
    await resources.commit()
    let settle: () => void = () => undefined
    const operation = only.hold(() => new Promise<void>(resolve => { settle = resolve }))

    const disposing = resources.dispose()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(closed).toEqual([])

    settle()
    await operation
    await disposing
    expect(closed).toEqual(['only'])
  })

  it('rejects an acquisition once dispose has started', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const disposing = resources.dispose()
    await expect(resources.acquire('late', config => createRecordingResource(config, closed))).rejects.toThrow(/disposed/)
    await disposing
    expect(closed).toEqual([])
  })

  it('never closes a resource while a hold that starts during dispose is still running', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const only = await resources.acquire('only', config => createRecordingResource(config, closed))
    await resources.commit()

    const disposing = resources.dispose()
    let closedWhileRunning: boolean | undefined
    let outcome: Promise<string> | Error
    try {
      outcome = only.hold(() => new Promise<string>(resolve => {
        setTimeout(() => {
          closedWhileRunning = closed.includes('only')
          resolve('done')
        }, 10)
      }))
    } catch (error) {
      outcome = error instanceof Error ? error : new Error(String(error))
    }
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/closed|disposed/)
    } else {
      await expect(outcome).resolves.toBe('done')
      expect(closedWhileRunning).toBe(false)
    }
    await disposing
    expect(closed).toEqual(['only'])
  })

  it('rejects dispose when a held resource fails to close during disposal', async () => {
    const resources = createManagedResources<string, { readonly name: string, close(): Promise<void> }>()
    const failing = await resources.acquire('failing', name => ({
      name,
      async close() {
        throw new Error('close failed during disposal')
      },
    }))
    await resources.commit()
    let settle: () => void = () => undefined
    const operation = failing.hold(() => new Promise<void>(resolve => { settle = resolve }))

    const disposing = resources.dispose()
    settle()
    await operation

    await expect(disposing).rejects.toThrow('close failed during disposal')
  })

  it('rejects a hold through a replaced idle resource while its close is running', async () => {
    let finishClose: () => void = () => undefined
    const closing = new Promise<void>(resolve => { finishClose = resolve })
    const resources = createManagedResources<string, { readonly name: string, close(): Promise<void> }>()
    const first = await resources.acquire('first', name => ({
      name,
      async close() {
        await closing
      },
    }))
    await resources.commit()
    await resources.acquire('second', config => createRecordingResource(config, []))

    const committing = resources.commit()
    let ran = false
    expect(() => first.hold(() => { ran = true })).toThrow(/closed/)
    expect(ran).toBe(false)

    finishClose()
    await committing
  })

  it('resolves a reconfiguration whose replaced idle resource fails to close, keeps the new resource active, and reports the failure', async () => {
    const reported: unknown[] = []
    const previous = errorReportingInternals.configure({ report: error => { reported.push(error) } })
    try {
      const resources = createManagedResources<string, { readonly name: string, close(): Promise<void> }>()
      await resources.acquire('old', name => ({
        name,
        async close() {
          throw new Error('old close failed')
        },
      }))
      await resources.commit()
      const next = await resources.acquire('new', config => createRecordingResource(config, []))

      await expect(resources.commit()).resolves.toBeUndefined()

      expect(next.hold(() => 'serving')).toBe('serving')
      expect(reported).toEqual([expect.objectContaining({ message: 'old close failed' })])
      await resources.dispose()
    } finally {
      errorReportingInternals.configure(previous)
    }
  })

  it('holds a resource for each store operation through a held store until the operation settles', async () => {
    const closed: string[] = []
    const resources = createManagedResources<string, ReturnType<typeof createRecordingResource>>()
    const lease = await resources.acquire('only', config => createRecordingResource(config, closed))
    await resources.commit()
    let settle: () => void = () => undefined
    const store = {
      hit: () => new Promise<string>(resolve => { settle = () => resolve('counted') }),
    }
    const heldStore = holdOperations(store, lease)
    const pending = heldStore.hit()

    await resources.acquire('replacement', config => createRecordingResource(config, closed))
    await resources.commit()
    expect(closed).toEqual([])

    settle()
    await expect(pending).resolves.toBe('counted')
    await expect.poll(() => closed).toEqual(['only'])
  })
})
