import { describe, expect, it, vi } from 'vitest'
import { createRuntimeLifecycle, type RuntimeContribution } from '../src'

describe('runtime lifecycle', () => {
  it('initializes dependencies first and disposes in reverse order', async () => {
    const calls: string[] = []
    const contribution = (name: string, dependsOn: readonly string[] = []): RuntimeContribution => ({
      name,
      dependsOn,
      initialize: () => { calls.push(`init:${name}`) },
      dispose: () => { calls.push(`dispose:${name}`) },
    })
    const lifecycle = createRuntimeLifecycle([
      contribution('http', ['database']),
      contribution('database'),
    ])

    await lifecycle.initialize({ projectRoot: '/app' })
    await lifecycle.dispose({ projectRoot: '/app' })

    expect(calls).toEqual(['init:database', 'init:http', 'dispose:http', 'dispose:database'])
  })

  it('rolls back initialized contributions when initialization fails', async () => {
    const dispose = vi.fn()
    const failure = new Error('boot failed')
    const lifecycle = createRuntimeLifecycle([
      { name: 'first', initialize: vi.fn(), dispose },
      { name: 'second', initialize: () => { throw failure } },
    ])

    await expect(lifecycle.initialize({ projectRoot: '/app' })).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('preserves initialization and rollback failures', async () => {
    const initializeFailure = new Error('initialize failed')
    const rollbackFailure = new Error('rollback failed')
    const lifecycle = createRuntimeLifecycle([{
      name: 'failing',
      initialize: () => { throw initializeFailure },
      dispose: () => { throw rollbackFailure },
    }])

    await expect(lifecycle.initialize({ projectRoot: '/app' })).rejects.toMatchObject({
      errors: [initializeFailure, rollbackFailure],
    })
  })

  it('rejects duplicate names, cycles, missing dependencies, and repeated initialization', async () => {
    const contribution = { name: 'same', initialize: vi.fn() }
    expect(() => createRuntimeLifecycle([contribution, contribution])).toThrow('must be unique')
    expect(() => createRuntimeLifecycle([
      { name: 'one', dependsOn: ['two'], initialize: vi.fn() },
      { name: 'two', dependsOn: ['one'], initialize: vi.fn() },
    ])).toThrow('Circular runtime dependency')
    expect(() => createRuntimeLifecycle([
      { name: 'one', dependsOn: ['missing'], initialize: vi.fn() },
    ])).toThrow('requires missing contribution')

    const lifecycle = createRuntimeLifecycle([contribution])
    await lifecycle.initialize({ projectRoot: '/app' })
    await expect(lifecycle.initialize({ projectRoot: '/app' })).rejects.toThrow('already initialized')
  })

  it('continues reverse disposal and reports every cleanup failure', async () => {
    const calls: string[] = []
    const firstFailure = new Error('first cleanup failed')
    const secondFailure = new Error('second cleanup failed')
    const lifecycle = createRuntimeLifecycle([
      {
        name: 'first',
        initialize: vi.fn(),
        dispose: () => {
          calls.push('first')
          throw firstFailure
        },
      },
      {
        name: 'second',
        initialize: vi.fn(),
        dispose: () => {
          calls.push('second')
          throw secondFailure
        },
      },
    ])
    await lifecycle.initialize({ projectRoot: '/app' })
    await expect(lifecycle.dispose({ projectRoot: '/app' })).rejects.toMatchObject({
      errors: [secondFailure, firstFailure],
    })
    expect(calls).toEqual(['second', 'first'])

    const singleFailureLifecycle = createRuntimeLifecycle([{
      name: 'only',
      initialize: vi.fn(),
      dispose: () => { throw firstFailure },
    }])
    await singleFailureLifecycle.initialize({ projectRoot: '/app' })
    await expect(singleFailureLifecycle.dispose({ projectRoot: '/app' })).rejects.toBe(firstFailure)
  })
})
