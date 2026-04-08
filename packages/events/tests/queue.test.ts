import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueueDriverFactory, QueueJobEnvelope, QueueJsonValue } from '@holo-js/queue'
import {
  configureQueueRuntime,
  getRegisteredQueueJob,
  normalizeQueueConfig,
  queueRuntimeInternals,
  resetQueueRegistry,
  resetQueueRuntime,
} from '@holo-js/queue'
import {
  EVENTS_INVOKE_LISTENER_JOB,
  Event,
  defineEvent,
  defineListener,
  dispatchEvent,
  ensureEventsQueueJobRegistered,
  eventQueueInternals,
  registerEvent,
  registerListener,
  resetEventsRegistry,
  resetEventsRuntime,
  unregisterListener,
} from '../src'

function createAsyncDriverFactory(
  driverName: 'redis' | 'database',
  dispatched: ReturnType<typeof vi.fn>,
): QueueDriverFactory {
  return {
    driver: driverName,
    create(connection) {
      return {
        name: connection.name,
        driver: connection.driver,
        mode: 'async' as const,
        async dispatch(job) {
          dispatched({
            connection,
            job,
          })

          return {
            jobId: job.id,
            synchronous: false,
          }
        },
        async clear() {
          return 0
        },
        async close() {},
        async reserve() {
          return null
        },
        async acknowledge() {},
        async release() {},
        async delete() {},
      }
    },
  }
}

afterEach(() => {
  resetEventsRegistry()
  resetEventsRuntime()
  resetQueueRegistry()
  resetQueueRuntime()
  vi.useRealTimers()
})

describe('@holo-js/events queue integration', () => {
  it('auto-registers the internal listener job and executes queued listeners through the sync queue driver', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async () => {})
    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      queue: true,
      async handle(event) {
        await handled(event)
      },
    }))

    const result = await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })

    expect(result).toMatchObject({
      eventName: 'user.registered',
      syncListeners: 0,
      queuedListeners: 1,
    })
    expect(getRegisteredQueueJob(EVENTS_INVOKE_LISTENER_JOB)?.name).toBe(EVENTS_INVOKE_LISTENER_JOB)
    expect(handled).toHaveBeenCalledTimes(1)
    expect(handled).toHaveBeenCalledWith(expect.objectContaining({
      name: 'user.registered',
      payload: {
        userId: 'usr-1',
      },
      occurredAt: expect.any(Number),
    }))
  })

  it('runs mixed sync and queued listeners through the real queue path with sync-first ordering', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const order: string[] = []
    registerListener(defineListener({
      name: 'sync.audit',
      listensTo: ['user.registered'],
      async handle() {
        order.push('sync')
      },
    }))
    registerListener(defineListener({
      name: 'queued.welcome',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {
        order.push('queued')
      },
    }))

    const result = await Event.dispatch('user.registered', {
      userId: 'usr-1',
    })

    expect(result).toMatchObject({
      syncListeners: 1,
      queuedListeners: 1,
    })
    expect(order).toEqual(['sync', 'queued'])
  })

  it('applies listener queue defaults and dispatch-time overrides to the internal queue job envelope', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T10:00:00.000Z'))

    const dispatched = vi.fn()
    configureQueueRuntime({
      config: normalizeQueueConfig({
        default: 'redis',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
            queue: 'default-events',
          },
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'db-events',
          },
        },
      }),
      driverFactories: [
        createAsyncDriverFactory('redis', dispatched),
        createAsyncDriverFactory('database', dispatched),
      ],
    })

    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      queue: true,
      connection: 'redis',
      queueName: 'emails',
      delay: 5,
      async handle() {},
    }))

    await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })
    await dispatchEvent('user.registered', {
      userId: 'usr-2',
    })
      .onConnection(' database ')
      .onQueue(' high ')
      .delay(10)

    const firstEnvelope = dispatched.mock.calls[0]?.[0]?.job as QueueJobEnvelope
    const secondEnvelope = dispatched.mock.calls[1]?.[0]?.job as QueueJobEnvelope

    expect(firstEnvelope.name).toBe(EVENTS_INVOKE_LISTENER_JOB)
    expect(firstEnvelope.connection).toBe('redis')
    expect(firstEnvelope.queue).toBe('emails')
    expect(firstEnvelope.availableAt).toBe(new Date('2026-04-03T10:00:05.000Z').getTime())
    expect(firstEnvelope.payload).toMatchObject({
      listenerId: 'send.welcome',
      eventName: 'user.registered',
      payload: {
        userId: 'usr-1',
      },
    })

    expect(secondEnvelope.connection).toBe('database')
    expect(secondEnvelope.queue).toBe('high')
    expect(secondEnvelope.availableAt).toBe(new Date('2026-04-03T10:00:10.000Z').getTime())
    expect(secondEnvelope.payload).toMatchObject({
      listenerId: 'send.welcome',
      eventName: 'user.registered',
      payload: {
        userId: 'usr-2',
      },
    })
  })

  it('fails queued listener execution clearly when the listener is removed before worker execution', async () => {
    const dispatched = vi.fn()
    configureQueueRuntime({
      config: normalizeQueueConfig({
        default: 'redis',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
            queue: 'events',
          },
        },
      }),
      driverFactories: [createAsyncDriverFactory('redis', dispatched)],
    })

    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    const handled = vi.fn(async () => {})
    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      queue: true,
      async handle(event) {
        await handled(event)
      },
    }))

    await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })

    const job = dispatched.mock.calls[0]?.[0]?.job as QueueJobEnvelope<QueueJsonValue>
    expect(unregisterListener('send.welcome')).toBe(true)

    await expect(queueRuntimeInternals.executeRegisteredQueueJob(job)).rejects.toThrow(
      'Queued listener "send.welcome" is not registered.',
    )
    expect(handled).not.toHaveBeenCalled()
  })

  it('surfaces listener failures through the internal queue job so queue-native retries can occur', async () => {
    const dispatched = vi.fn()
    configureQueueRuntime({
      config: normalizeQueueConfig({
        default: 'redis',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
            queue: 'events',
          },
        },
      }),
      driverFactories: [createAsyncDriverFactory('redis', dispatched)],
    })

    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {
        throw new Error('listener failed')
      },
    }))

    await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })

    const job = dispatched.mock.calls[0]?.[0]?.job as QueueJobEnvelope<QueueJsonValue>
    await expect(queueRuntimeInternals.executeRegisteredQueueJob(job)).rejects.toThrow('listener failed')
  })

  it('fails queued listener execution clearly when the listener no longer targets the queued event', async () => {
    const dispatched = vi.fn()
    configureQueueRuntime({
      config: normalizeQueueConfig({
        default: 'redis',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
            queue: 'events',
          },
        },
      }),
      driverFactories: [createAsyncDriverFactory('redis', dispatched)],
    })

    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    registerEvent(defineEvent<{ userId: string }, 'user.deleted'>({
      name: 'user.deleted',
    }))
    registerListener(defineListener({
      name: 'audit.lifecycle',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {},
    }))

    await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })

    const job = dispatched.mock.calls[0]?.[0]?.job as QueueJobEnvelope<QueueJsonValue>
    registerListener(defineListener({
      name: 'audit.lifecycle',
      listensTo: ['user.deleted'],
      queue: true,
      async handle() {},
    }), {
      replaceExisting: true,
    })

    await expect(queueRuntimeInternals.executeRegisteredQueueJob(job)).rejects.toThrow(
      'Queued listener "audit.lifecycle" is not registered for event "user.registered".',
    )
  })

  it('exposes queued-listener helpers for internal consumers', () => {
    const envelope = eventQueueInternals.createQueuedListenerEventEnvelope({
      listenerId: 'send.welcome',
      eventName: 'user.registered',
      occurredAt: 123,
      payload: {
        userId: 'usr-1',
      },
    })

    expect(envelope).toEqual({
      name: 'user.registered',
      payload: {
        userId: 'usr-1',
      },
      occurredAt: 123,
    })
    expect(() => eventQueueInternals.requireQueuedListener('missing.listener')).toThrow(
      'Queued listener "missing.listener" is not registered.',
    )
    expect(() => eventQueueInternals.assertQueuedListenerMatchesEvent({
      id: 'listener',
      eventNames: ['user.deleted'],
      definition: defineListener({
        name: 'listener',
        listensTo: ['user.deleted'],
        queue: true,
        async handle() {},
      }),
    }, 'user.registered')).toThrow(
      'Queued listener "listener" is not registered for event "user.registered".',
    )
  })

  it('supports the synchronous registration wrapper', () => {
    ensureEventsQueueJobRegistered()
    expect(getRegisteredQueueJob(EVENTS_INVOKE_LISTENER_JOB)?.name).toBe(EVENTS_INVOKE_LISTENER_JOB)
  })
})
