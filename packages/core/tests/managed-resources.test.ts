import { describe, expect, it } from 'vitest'
import { createManagedResources, holdOperations } from '../src/portable/managedResources'

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
