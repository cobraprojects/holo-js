import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Event,
  configureEventsRuntime,
  defineEvent,
  defineListener,
  dispatchEvent,
  eventRuntimeInternals,
  getEventsRuntime,
  registerEvent,
  registerListener,
  resetEventsRegistry,
  resetEventsRuntime,
} from '../src'

afterEach(() => {
  resetEventsRegistry()
  resetEventsRuntime()
})

describe('@holo-js/events runtime', () => {
  it('dispatches through the helper and facade for registered events with no listeners', async () => {
    const userRegistered = registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const helperResult = await dispatchEvent(userRegistered.definition, {
      userId: 'usr-1',
    })
    const facadeResult = await Event.dispatch(' user.registered ', {
      userId: 'usr-2',
    })

    expect(helperResult).toMatchObject({
      eventName: 'user.registered',
      deferred: false,
      syncListeners: 0,
      queuedListeners: 0,
    })
    expect(facadeResult).toMatchObject({
      eventName: 'user.registered',
      deferred: false,
      syncListeners: 0,
      queuedListeners: 0,
    })
    expect(typeof helperResult.occurredAt).toBe('number')
    expect(helperResult.occurredAt).toBeGreaterThan(0)
  })

  it('executes synchronous listeners inline in registration order', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const order: string[] = []
    registerListener(defineListener({
      name: 'audit.first',
      listensTo: ['user.registered'],
      async handle() {
        order.push('first')
      },
    }))
    registerListener(defineListener({
      name: 'audit.second',
      listensTo: ['user.registered'],
      async handle() {
        order.push('second')
      },
    }))

    const result = await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })

    expect(order).toEqual(['first', 'second'])
    expect(result).toMatchObject({
      eventName: 'user.registered',
      deferred: false,
      syncListeners: 2,
      queuedListeners: 0,
    })
  })

  it('dispatches queued listeners through the configured runtime hook with listener defaults and fluent overrides', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const queued = vi.fn(async () => {})
    configureEventsRuntime({
      dispatchQueuedListener: queued,
    })

    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      queue: true,
      connection: 'redis',
      queueName: 'emails',
      delay: 5,
      async handle() {},
    }))
    registerListener(defineListener({
      name: 'sync.audit',
      listensTo: ['user.registered'],
      async handle() {},
    }))

    const defaultResult = await dispatchEvent('user.registered', {
      userId: 'usr-1',
    }).dispatch()
    const overrideResult = await dispatchEvent('user.registered', {
      userId: 'usr-2',
    })
      .onConnection(' database ')
      .onQueue(' high ')
      .delay(10)

    expect(defaultResult).toMatchObject({
      syncListeners: 1,
      queuedListeners: 1,
    })
    expect(overrideResult).toMatchObject({
      syncListeners: 1,
      queuedListeners: 1,
    })
    expect(queued).toHaveBeenNthCalledWith(1, {
      listenerId: 'send.welcome',
      event: expect.objectContaining({
        name: 'user.registered',
        payload: {
          userId: 'usr-1',
        },
      }),
      connection: 'redis',
      queueName: 'emails',
      delay: 5,
    })
    expect(queued).toHaveBeenNthCalledWith(2, {
      listenerId: 'send.welcome',
      event: expect.objectContaining({
        name: 'user.registered',
        payload: {
          userId: 'usr-2',
        },
      }),
      connection: 'database',
      queueName: 'high',
      delay: 10,
    })
  })

  it('supports queued-only and mixed listener sets', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const queued = vi.fn(async () => {})
    const handled = vi.fn(async () => {})
    configureEventsRuntime({
      dispatchQueuedListener: queued,
    })

    registerListener(defineListener({
      name: 'only.queued',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {},
    }))

    const queuedOnly = await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })

    resetEventsRegistry()
    resetEventsRuntime()

    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    configureEventsRuntime({
      dispatchQueuedListener: queued,
    })
    registerListener(defineListener({
      name: 'mixed.sync',
      listensTo: ['user.registered'],
      async handle() {
        await handled()
      },
    }))
    registerListener(defineListener({
      name: 'mixed.queued',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {},
    }))

    const mixed = await dispatchEvent('user.registered', {
      userId: 'usr-2',
    })

    expect(queuedOnly).toMatchObject({
      syncListeners: 0,
      queuedListeners: 1,
    })
    expect(mixed).toMatchObject({
      syncListeners: 1,
      queuedListeners: 1,
    })
    expect(handled).toHaveBeenCalledTimes(1)
  })

  it('stops dispatch and skips queued fan-out when a sync listener throws', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const queued = vi.fn(async () => {})
    configureEventsRuntime({
      dispatchQueuedListener: queued,
    })

    registerListener(defineListener({
      name: 'sync.fail',
      listensTo: ['user.registered'],
      async handle() {
        throw new Error('sync failed')
      },
    }))
    registerListener(defineListener({
      name: 'queue.after',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {},
    }))

    await expect(dispatchEvent('user.registered', {
      userId: 'usr-1',
    })).rejects.toThrow('sync failed')
    expect(queued).not.toHaveBeenCalled()
  })

  it('validates queued payload serialization only when queued listeners exist', async () => {
    registerEvent(defineEvent<unknown, 'audit.logged'>({
      name: 'audit.logged',
    }))
    registerListener(defineListener({
      name: 'sync.audit',
      listensTo: ['audit.logged'],
      async handle() {},
    }))

    await expect(dispatchEvent('audit.logged', {
      perform() {},
    })).resolves.toMatchObject({
      syncListeners: 1,
      queuedListeners: 0,
    })

    registerListener(defineListener({
      name: 'queue.audit',
      listensTo: ['audit.logged'],
      queue: true,
      async handle() {},
    }))
    configureEventsRuntime({
      dispatchQueuedListener: vi.fn(async () => {}),
    })

    await expect(dispatchEvent('audit.logged', {
      perform() {},
    })).rejects.toThrow('Event payload at "payload.perform" must be JSON-serializable for queued listeners.')

    await expect(dispatchEvent('audit.logged', Number.POSITIVE_INFINITY)).rejects.toThrow(
      'Event payload at "payload" must be JSON-serializable for queued listeners.',
    )

    await expect(dispatchEvent('audit.logged', new Date())).rejects.toThrow(
      'Event payload at "payload" must be a plain JSON object, array, or primitive for queued listeners.',
    )

    const circular: { self?: unknown } = {}
    circular.self = circular
    await expect(dispatchEvent('audit.logged', circular)).rejects.toThrow(
      'Event payload at "payload.self" contains a circular reference.',
    )

    const circularArray: unknown[] = []
    circularArray.push(circularArray)
    await expect(dispatchEvent('audit.logged', circularArray)).rejects.toThrow(
      'Event payload at "payload[0]" contains a circular reference.',
    )
  })

  it('rejects invalid event names, unknown events, and unnamed definitions', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    await expect(dispatchEvent('   ', {})).rejects.toThrow('Event names must be non-empty strings.')
    await expect(dispatchEvent('missing.event', {})).rejects.toThrow('Event "missing.event" is not registered.')
    await expect(dispatchEvent(defineEvent<object>({}), {})).rejects.toThrow(
      'Dispatching an event definition requires an explicit event name.',
    )
    expect(() => eventRuntimeInternals.resolveDispatchedEventName(null as never)).toThrow('Events must be plain objects.')
  })

  it('supports afterCommit deferral and falls back to immediate dispatch when no deferral hook is active', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async () => {})
    const deferredCallbacks: Array<() => Promise<void>> = []
    const defer = vi.fn((callback: () => Promise<void>) => {
      deferredCallbacks.push(callback)
      return true
    })
    configureEventsRuntime({
      defer,
    })
    registerListener(defineListener({
      name: 'sync.audit',
      listensTo: ['user.registered'],
      async handle() {
        await handled()
      },
    }))

    const deferred = await dispatchEvent('user.registered', {
      userId: 'usr-1',
    }).afterCommit()
    expect(handled).toHaveBeenCalledTimes(0)
    expect(deferredCallbacks).toHaveLength(1)
    await deferredCallbacks[0]?.()

    resetEventsRuntime()
    const immediate = await dispatchEvent('user.registered', {
      userId: 'usr-2',
    }).afterCommit()

    expect(deferred).toMatchObject({
      deferred: true,
      syncListeners: 1,
      queuedListeners: 0,
    })
    expect(immediate).toMatchObject({
      deferred: false,
      syncListeners: 1,
      queuedListeners: 0,
    })
    expect(defer).toHaveBeenCalledTimes(1)
    expect(defer).toHaveBeenCalledWith(expect.any(Function), {
      eventName: 'user.registered',
      afterCommit: true,
    })
    expect(handled).toHaveBeenCalledTimes(2)
  })

  it('is awaitable and executes the same pending dispatch only once', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async () => {})
    registerListener(defineListener({
      name: 'sync.audit',
      listensTo: ['user.registered'],
      async handle() {
        await handled()
      },
    }))

    const pending = Event.dispatch('user.registered', {
      userId: 'usr-1',
    })

    const viaThen = await pending.then(result => result.eventName)
    const viaCatch = await pending.catch(() => 'failed')
    let finalized = false
    const viaFinally = await pending.finally(() => {
      finalized = true
    })
    const viaNullFinally = await pending.finally(null)

    expect(viaThen).toBe('user.registered')
    expect(viaCatch).toMatchObject({
      eventName: 'user.registered',
    })
    expect(viaFinally).toMatchObject({
      syncListeners: 1,
      queuedListeners: 0,
    })
    expect(viaNullFinally).toMatchObject({
      syncListeners: 1,
      queuedListeners: 0,
    })
    expect(finalized).toBe(true)
    expect(handled).toHaveBeenCalledTimes(1)
  })

  it('exposes runtime helpers and configured hooks for internal consumers', async () => {
    const queued = vi.fn(async () => {})
    configureEventsRuntime({
      dispatchQueuedListener: queued,
    })
    registerEvent(defineEvent<{ auditId: string }, 'audit.logged'>({
      name: 'audit.logged',
    }))

    const binding = getEventsRuntime()
    const envelope = eventRuntimeInternals.createEventEnvelope('audit.logged', {
      auditId: 'aud-1',
    }, 123)
    const syncListener = registerListener(defineListener({
      name: 'sync.audit',
      listensTo: ['audit.logged'],
      async handle() {},
    }))
    const queuedListener = registerListener(defineListener({
      name: 'queue.audit',
      listensTo: ['audit.logged'],
      queue: true,
      async handle() {},
    }))
    const grouped = eventRuntimeInternals.splitRegisteredListeners([syncListener, queuedListener])

    expect(binding.hooks.dispatchQueuedListener).toBe(queued)
    expect(eventRuntimeInternals.normalizeEventName(' audit.logged ')).toBe('audit.logged')
    expect(eventRuntimeInternals.requireRegisteredEvent.bind(null, 'missing.event')).toThrow(
      'Event "missing.event" is not registered.',
    )
    expect(eventRuntimeInternals.isPlainObject(null)).toBe(false)
    expect(eventRuntimeInternals.isPlainObject(['audit'])).toBe(false)
    expect(eventRuntimeInternals.isPlainObject({ ok: true })).toBe(true)
    expect(eventRuntimeInternals.isPlainObject(new Date())).toBe(false)
    expect(envelope).toEqual({
      name: 'audit.logged',
      payload: {
        auditId: 'aud-1',
      },
      occurredAt: 123,
    })
    expect(grouped.syncListeners.map(listener => listener.id)).toEqual(['sync.audit'])
    expect(grouped.queuedListeners.map(listener => listener.id)).toEqual(['queue.audit'])
    expect(() => eventRuntimeInternals.validateQueuedEventPayload(5)).not.toThrow()
    expect(() => eventRuntimeInternals.validateQueuedEventPayload(['ok', 1, false])).not.toThrow()
    await expect(eventRuntimeInternals.dispatchQueuedListeners([], envelope, {})).resolves.toBe(0)
    await expect(eventRuntimeInternals.executeListenerGroups([], [], envelope, {})).resolves.toEqual({
      syncCount: 0,
      queuedCount: 0,
    })
  })
})
