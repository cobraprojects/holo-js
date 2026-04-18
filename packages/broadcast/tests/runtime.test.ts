import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeBroadcastConfig } from '@holo-js/config'
import {
  broadcast,
  broadcastRaw,
  broadcastRuntimeInternals,
  channel,
  configureBroadcastRuntime,
  defineBroadcast,
  presenceChannel,
  privateChannel,
  registerBroadcastDriver,
  resetBroadcastDriverRegistry,
  resetBroadcastRuntime,
} from '../src'

function createConfig() {
  return normalizeBroadcastConfig({
    default: 'reverb',
    connections: {
      reverb: {
        driver: 'holo',
        key: 'reverb-key',
        secret: 'reverb-secret',
        appId: 'reverb-app',
        options: {
          host: 'ws.example.com',
          port: 443,
          scheme: 'https',
        },
      },
      pusher: {
        driver: 'pusher',
        key: 'pusher-key',
        secret: 'pusher-secret',
        appId: 'pusher-app',
        options: {
          host: 'api.pusher.test',
          port: 443,
          scheme: 'https',
        },
      },
      log: {
        driver: 'log',
      },
      null: {
        driver: 'null',
      },
      custom: {
        driver: 'custom',
      },
    },
  })
}

afterEach(() => {
  resetBroadcastRuntime()
  resetBroadcastDriverRegistry()
  vi.restoreAllMocks()
  broadcastRuntimeInternals.setLoadQueueModuleForTesting(undefined)
  broadcastRuntimeInternals.setLoadDbModuleForTesting(undefined)
})

describe('@holo-js/broadcast runtime', () => {
  it('dispatches lazily through built-in transport drivers and raw send path', async () => {
    const publish = vi.fn(async (input, context) => ({
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
      provider: {
        event: input.event,
      },
    }))

    configureBroadcastRuntime({
      config: createConfig(),
      publish,
    })

    const pending = broadcast(defineBroadcast({
      name: 'orders.updated',
      channels: [privateChannel('orders.{orderId}', { orderId: 'ord_1' })],
      payload: {
        orderId: 'ord_1',
      },
    }))

    expect(publish).not.toHaveBeenCalled()

    const result = await pending
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenNthCalledWith(1, {
      connection: 'reverb',
      event: 'orders.updated',
      channels: ['private-orders.ord_1'],
      payload: {
        orderId: 'ord_1',
      },
    }, expect.objectContaining({
      connection: 'reverb',
      driver: 'holo',
      queued: false,
      delayed: false,
    }))
    expect(result).toMatchObject({
      connection: 'reverb',
      driver: 'holo',
      queued: false,
      publishedChannels: ['private-orders.ord_1'],
      provider: {
        event: 'orders.updated',
      },
    })

    const raw = await broadcastRaw({
      connection: 'pusher',
      event: 'orders.shipped',
      channels: ['orders.ord_2'],
      payload: {
        orderId: 'ord_2',
      },
    })

    expect(raw.driver).toBe('pusher')
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('dispatches presence channel definitions with the presence- prefix', async () => {
    const publish = vi.fn(async (input, context) => ({
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
    }))

    configureBroadcastRuntime({
      config: createConfig(),
      publish,
    })

    const result = await broadcast(defineBroadcast({
      name: 'chat.joined',
      channels: [presenceChannel('chat.{roomId}', { roomId: 'room_1' })],
      payload: { userId: 'user_1' },
    }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenNthCalledWith(1, {
      connection: 'reverb',
      event: 'chat.joined',
      channels: ['presence-chat.room_1'],
      payload: { userId: 'user_1' },
    }, expect.objectContaining({
      connection: 'reverb',
      driver: 'holo',
    }))
    expect(result).toMatchObject({
      publishedChannels: ['presence-chat.room_1'],
    })
  })

  it('resolves queue defaults, fluent precedence, and after-commit deferral', async () => {
    const dispatchCalls: Array<{
      readonly jobName: string
      readonly payload: unknown
      readonly connection?: string
      readonly queue?: string
      readonly delay?: number | Date
    }> = []
    let afterCommitCallback: (() => Promise<void>) | undefined
    const publish = vi.fn(async (input, context) => ({
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
    }))

    configureBroadcastRuntime({
      config: createConfig(),
      publish,
    })
    broadcastRuntimeInternals.setLoadQueueModuleForTesting(async () => {
      let connection: string | undefined
      let queue: string | undefined
      let delay: number | Date | undefined

      return {
        defineJob(definition) {
          return definition
        },
        getRegisteredQueueJob() {
          return undefined
        },
        registerQueueJob() {},
        dispatch(jobName, payload) {
          return {
            onConnection(name) {
              connection = name
              return this
            },
            onQueue(name) {
              queue = name
              return this
            },
            delay(value) {
              delay = value
              return this
            },
            async dispatch() {
              dispatchCalls.push({
                jobName,
                payload,
                connection,
                queue,
                delay,
              })
            },
          }
        },
      }
    })
    broadcastRuntimeInternals.setLoadDbModuleForTesting(async () => ({
      connectionAsyncContext: {
        getActive() {
          return {
            connection: {
              getScope() {
                return { kind: 'transaction' }
              },
              afterCommit(callback) {
                afterCommitCallback = callback
              },
            },
          }
        },
      },
    }))

    const result = await broadcast(defineBroadcast({
      name: 'orders.updated',
      channels: [privateChannel('orders.{orderId}', { orderId: 'ord_9' })],
      payload: {
        orderId: 'ord_9',
      },
      queue: {
        queued: true,
        connection: 'redis-default',
        queue: 'broadcasts',
      },
      delay: 10,
    }))
      .using('null')
      .onConnection('redis-override')
      .onQueue('realtime')
      .delay(25)
      .afterCommit()

    expect(result).toMatchObject({
      connection: 'null',
      driver: 'null',
      queued: true,
      publishedChannels: ['private-orders.ord_9'],
    })
    expect(dispatchCalls).toHaveLength(0)
    expect(publish).not.toHaveBeenCalled()

    await afterCommitCallback?.()

    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchCalls[0]).toMatchObject({
      jobName: 'holo.broadcast.deliver',
      connection: 'redis-override',
      queue: 'realtime',
      delay: 25,
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('supports custom drivers, built-in log/null drivers, and immutable inputs/results', async () => {
    const send = vi.fn((input, context) => {
      expect(Object.isFrozen(input)).toBe(true)
      expect(Object.isFrozen(input.channels)).toBe(true)
      expect(Object.isFrozen(input.payload)).toBe(true)
      expect(Object.isFrozen(context)).toBe(true)
      expect(input.socketId).toBe('socket-1')

      return {
        connection: ` ${context.connection} `,
        driver: ` ${context.driver} `,
        queued: undefined,
        publishedChannels: input.channels,
        messageId: 'custom-msg',
        provider: {
          ok: true,
        },
      }
    })

    registerBroadcastDriver('custom', { send })
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    configureBroadcastRuntime({
      config: createConfig(),
    })

    const custom = await broadcastRaw({
      connection: 'custom',
      event: 'orders.updated',
      channels: ['orders.1'],
      payload: {
        ok: true,
      },
      socketId: 'socket-1',
    })

    const logged = await broadcastRaw({
      connection: 'log',
      event: 'orders.logged',
      channels: ['orders.2'],
      payload: {
        ok: true,
      },
    })

    const nulled = await broadcastRaw({
      connection: 'null',
      event: 'orders.ignored',
      channels: ['orders.3'],
      payload: {
        ok: true,
      },
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(custom).toMatchObject({
      connection: 'custom',
      driver: 'custom',
      queued: false,
      publishedChannels: ['orders.1'],
      messageId: 'custom-msg',
      provider: {
        ok: true,
      },
    })
    expect(Object.isFrozen(custom)).toBe(true)
    expect(Object.isFrozen(custom.provider)).toBe(true)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logged.driver).toBe('log')
    expect(nulled.driver).toBe('null')

    await expect(broadcastRaw({
      event: 'orders.bad',
      channels: [],
      payload: {
        ok: true,
      },
    })).rejects.toThrow('at least one channel')
  })

  it('covers pending helpers and runtime error branches', async () => {
    configureBroadcastRuntime({
      config: createConfig(),
      publish: vi.fn(async (input, context) => ({
        connection: context.connection,
        driver: context.driver,
        queued: context.queued,
        publishedChannels: input.channels,
      })),
    })

    const queueMissing = Object.assign(new Error('missing queue'), {
      code: 'ERR_MODULE_NOT_FOUND',
    })
    broadcastRuntimeInternals.setLoadQueueModuleForTesting(async () => {
      throw queueMissing
    })

    await expect(
      broadcast(defineBroadcast({
        name: 'orders.updated',
        channels: [privateChannel('orders.{orderId}', { orderId: 'ord_11' })],
        payload: {
          orderId: 'ord_11',
        },
        queue: {
          queued: true,
        },
      })),
    ).rejects.toThrow('@holo-js/queue')

    broadcastRuntimeInternals.setLoadQueueModuleForTesting(undefined)

    await expect(
      broadcastRaw({
        event: '   ',
        channels: ['orders.1'],
        payload: {
          ok: true,
        },
      }).catch(error => error.message),
    ).resolves.toContain('Broadcast event must be a non-empty string')

    await expect(
      broadcastRaw({
        connection: 'missing',
        event: 'orders.updated',
        channels: ['orders.1'],
        payload: {
          ok: true,
        },
      }),
    ).rejects.toThrow('is not configured')
    await expect(
      broadcastRaw({
        connection: 'custom',
        event: 'orders.updated',
        channels: ['orders.1'],
        payload: {
          ok: true,
        },
      }),
    ).rejects.toThrow('is not registered')
    configureBroadcastRuntime({
      config: createConfig(),
    })
    broadcastRuntimeInternals.setLoadDbModuleForTesting(async () => null)
    await expect(
      broadcastRaw({
        connection: 'reverb',
        event: 'orders.updated',
        channels: ['orders.1'],
        payload: {
          ok: true,
        },
      }),
    ).rejects.toThrow('requires a publish runtime binding')
    configureBroadcastRuntime({
      config: createConfig(),
      publish: vi.fn(async (input, context) => ({
        connection: context.connection,
        driver: context.driver,
        queued: context.queued,
        publishedChannels: input.channels,
      })),
    })

    await expect(
      broadcast({
        name: 'orders.inline',
        channels: [privateChannel('orders.{orderId}', { orderId: 'ord_inline' })],
        payload: {
          items: [1, true, null],
        },
      }),
    ).resolves.toMatchObject({
      publishedChannels: ['private-orders.ord_inline'],
    })

    await expect(
      broadcastRaw({
        event: 'orders.updated',
        channels: ['orders.1'],
        payload: 'invalid' as never,
      }).catch(error => error.message),
    ).resolves.toContain('payload must be a plain object')
    await expect(
      broadcastRaw({
        event: 'orders.updated',
        channels: ['orders.1'],
        payload: {
          ok: true,
        },
        socketId: '   ',
      }).catch(error => error.message),
    ).resolves.toContain('socket id must be a non-empty string')

    await expect(
      broadcast(defineBroadcast({
        channels: [privateChannel('orders.{orderId}', { orderId: 'ord_12' })],
        payload: {
          orderId: 'ord_12',
        },
      })),
    ).rejects.toThrow('must resolve a public event name')

    await expect(
      broadcastRaw({
        event: 'orders.updated',
        channels: ['orders.1'],
        payload: {
          broken: new Map(),
        } as never,
      }).catch(error => error.message),
    ).resolves.toContain('JSON-serializable')

    expect(() => broadcastRaw({
      event: 'orders.updated',
      channels: ['orders.1'],
      payload: {
        ok: true,
      },
    }).delay(-1 as never)).toThrow('greater than or equal to 0')
    expect(broadcastRuntimeInternals.normalizeDelayValue(new Date(0), 'Broadcast delay')).toEqual(new Date(0))
    expect(() => broadcastRaw({
      event: 'orders.updated',
      channels: ['orders.1'],
      payload: {
        ok: true,
      },
    }).delay(new Date('invalid') as never)).toThrow('dates must be valid Date instances')

    expect(() => broadcastRaw({
      event: 'orders.updated',
      channels: ['orders.1'],
      payload: {
        ok: true,
      },
    }).using('   ' as never)).toThrow('must be a non-empty string')
    expect(() => broadcastRuntimeInternals.createRawInputFromDefinition({
      name: 'orders.updated',
      channels: [{
        type: 'private',
        pattern: 'orders.{orderId}',
        params: Object.freeze({}) as never,
      }],
      payload: Object.freeze({
        ok: true,
      }),
      queue: Object.freeze({
        queued: false,
        afterCommit: false,
      }),
    } as never)).toThrow('missing param "orderId"')

    let deferredCalled = false
    configureBroadcastRuntime({
      config: createConfig(),
      publish: vi.fn(async (input, context) => ({
        connection: context.connection,
        driver: context.driver,
        queued: context.queued,
        publishedChannels: input.channels,
      })),
    })
    broadcastRuntimeInternals.setLoadDbModuleForTesting(async () => null)
    await broadcastRaw({
      event: 'orders.updated',
      channels: ['orders.1'],
      payload: {
        ok: true,
      },
    })
      .afterCommit()
      .finally(() => {
        deferredCalled = true
      })
    await broadcastRaw({
      event: 'orders.updated',
      channels: ['orders.1'],
      payload: {
        ok: true,
      },
    }).finally(null)

    expect(deferredCalled).toBe(true)

    let syncAfterCommitCallback: (() => Promise<void>) | undefined
    const syncPublish = vi.fn(async (input, context) => ({
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
    }))
    configureBroadcastRuntime({
      config: createConfig(),
      publish: syncPublish,
    })
    broadcastRuntimeInternals.setLoadDbModuleForTesting(async () => ({
      connectionAsyncContext: {
        getActive() {
          return {
            connection: {
              getScope() {
                return { kind: 'transaction' }
              },
              afterCommit(callback) {
                syncAfterCommitCallback = callback
              },
            },
          }
        },
      },
    }))

    const syncDeferred = await broadcastRaw({
      event: 'orders.deferred',
      channels: ['orders.2'],
      payload: {
        ok: true,
      },
    }).afterCommit()

    expect(syncDeferred).toMatchObject({
      queued: false,
      publishedChannels: ['orders.2'],
    })
    expect(syncPublish).not.toHaveBeenCalled()
    await syncAfterCommitCallback?.()
    expect(syncPublish).toHaveBeenCalledTimes(1)

    const queueModule = {
      registered: undefined as unknown,
      defineJob(definition: { handle(payload: unknown): Promise<unknown> | unknown }) {
        return definition
      },
      getRegisteredQueueJob() {
        return this.registered
      },
      registerQueueJob: vi.fn(function (definition: unknown) {
        queueModule.registered = definition
      }),
      dispatch: vi.fn(),
    }

    queueModule.registered = {}
    expect(await broadcastRuntimeInternals.ensureBroadcastQueueJobRegistered(queueModule as never)).toBe(queueModule)
    expect(queueModule.registerQueueJob).not.toHaveBeenCalled()

    queueModule.registered = undefined
    await broadcastRuntimeInternals.ensureBroadcastQueueJobRegistered(queueModule as never)
    expect(queueModule.registerQueueJob).toHaveBeenCalledTimes(1)
    await expect((queueModule.registered as { handle(payload: unknown): Promise<unknown> }).handle({
      messageId: 'msg_2',
      raw: Object.freeze({
        connection: 'reverb',
        event: 'orders.queued',
        channels: Object.freeze(['orders.queued']),
        payload: Object.freeze({
          ok: true,
        }),
      }),
      context: Object.freeze({
        connection: 'reverb',
        driver: 'holo',
      }),
    })).resolves.toMatchObject({
      queued: true,
      publishedChannels: ['orders.queued'],
    })

    const published = await broadcastRuntimeInternals.runQueuedBroadcastDelivery({
      messageId: 'msg_1',
      raw: Object.freeze({
        connection: 'reverb',
        event: 'orders.updated',
        channels: Object.freeze(['orders.1']),
        payload: Object.freeze({
          ok: true,
        }),
      }),
      context: Object.freeze({
        connection: 'reverb',
        driver: 'holo',
      }),
    } as never)

    expect(published).toMatchObject({
      connection: 'reverb',
      driver: 'holo',
      queued: true,
      publishedChannels: ['orders.1'],
      messageId: 'msg_1',
    })

    const concurrentQueueModule = {
      registered: undefined as unknown,
      defineJob(definition: { handle(payload: unknown): Promise<unknown> | unknown }) {
        return definition
      },
      getRegisteredQueueJob() {
        return this.registered
      },
      registerQueueJob: vi.fn(function (definition: unknown) {
        concurrentQueueModule.registered = definition
      }),
      dispatch: vi.fn(),
    }
    const loadQueueModule = vi.fn(async () => concurrentQueueModule as never)
    broadcastRuntimeInternals.setLoadQueueModuleForTesting(loadQueueModule)

    const [firstQueueModule, secondQueueModule] = await Promise.all([
      broadcastRuntimeInternals.ensureBroadcastQueueJobRegistered(),
      broadcastRuntimeInternals.ensureBroadcastQueueJobRegistered(),
    ])

    expect(loadQueueModule).toHaveBeenCalledTimes(1)
    expect(concurrentQueueModule.registerQueueJob).toHaveBeenCalledTimes(1)
    expect(firstQueueModule).toBe(concurrentQueueModule)
    expect(secondQueueModule).toBe(concurrentQueueModule)

    let failOnce = true
    const retryQueueModule = {
      registered: undefined as unknown,
      defineJob(definition: { handle(payload: unknown): Promise<unknown> | unknown }) {
        return definition
      },
      getRegisteredQueueJob() {
        return this.registered
      },
      registerQueueJob: vi.fn(function () {
        if (failOnce) {
          failOnce = false
          throw new Error('register failed')
        }
        retryQueueModule.registered = {}
      }),
      dispatch: vi.fn(),
    }
    broadcastRuntimeInternals.setLoadQueueModuleForTesting(async () => retryQueueModule as never)
    await expect(broadcastRuntimeInternals.ensureBroadcastQueueJobRegistered()).rejects.toThrow('register failed')
    await expect(broadcastRuntimeInternals.ensureBroadcastQueueJobRegistered()).resolves.toBe(retryQueueModule)

    configureBroadcastRuntime({
      config: createConfig(),
    })
    registerBroadcastDriver('custom', {
      send(_input, context) {
        return {
          connection: context.connection,
          driver: context.driver,
          queued: context.queued,
        } as never
      },
    })
    const fallbackChannels = await broadcastRaw({
      connection: 'custom',
      event: 'orders.partial',
      channels: ['orders.partial'],
      payload: {
        ok: true,
      },
    })
    expect(fallbackChannels.publishedChannels).toEqual(['orders.partial'])
    resetBroadcastRuntime()
    expect(broadcastRuntimeInternals.resolveBroadcastConnection('null')).toMatchObject({
      name: 'null',
      driver: 'null',
    })
    configureBroadcastRuntime({
      config: createConfig(),
    })
    registerBroadcastDriver('custom', {
      send(input) {
        return {
          publishedChannels: input.channels,
        } as never
      },
    }, { replace: true })
    await expect(
      broadcastRaw({
        connection: 'custom',
        event: 'orders.context-fallback',
        channels: ['orders.context-fallback'],
        payload: {
          ok: true,
        },
      }),
    ).resolves.toMatchObject({
      connection: 'custom',
      driver: 'custom',
      queued: false,
      publishedChannels: ['orders.context-fallback'],
    })

    try {
      broadcastRuntimeInternals.setLoadQueueModuleForTesting(async () => {
        throw Object.assign(new Error('missing optional module'), { code: 'ERR_MODULE_NOT_FOUND' })
      })
      broadcastRuntimeInternals.setLoadDbModuleForTesting(undefined)

      await expect(
        broadcast(defineBroadcast({
          name: 'orders.default-queue',
          channels: [privateChannel('orders.{orderId}', { orderId: 'ord_13' })],
          payload: {
            orderId: 'ord_13',
          },
          queue: {
            queued: true,
          },
        })),
      ).rejects.toThrow('@holo-js/queue')

      configureBroadcastRuntime({
        config: createConfig(),
      })
      broadcastRuntimeInternals.setLoadDbModuleForTesting(async () => null)
      await expect(
        broadcastRaw({
          event: 'orders.default-db',
          channels: ['orders.13'],
          payload: {
            ok: true,
          },
        }).afterCommit(),
      ).rejects.toThrow('requires a publish runtime binding')

      const queueFailure = new Error('queue exploded')
      broadcastRuntimeInternals.setLoadQueueModuleForTesting(async () => {
        throw queueFailure
      })
      await expect(
        broadcast(defineBroadcast({
          name: 'orders.queue-error',
          channels: [channel('orders.queue-error')],
          payload: {
            ok: true,
          },
          queue: {
            queued: true,
          },
        })),
      ).rejects.toThrow(queueFailure)
      broadcastRuntimeInternals.setLoadQueueModuleForTesting(undefined)

      broadcastRuntimeInternals.setLoadDbModuleForTesting(async () => {
        throw new Error('db exploded')
      })
      broadcastRuntimeInternals.setLoadQueueModuleForTesting(async () => ({
        defineJob(definition) {
          return definition
        },
        dispatch() {
          throw new Error('queue dispatch should not be reached')
        },
        getRegisteredQueueJob() {
          return {}
        },
        registerQueueJob() {},
      }))
      await expect(
        broadcast(defineBroadcast({
          name: 'orders.queue-generic',
          channels: [channel('orders.queue-generic')],
          payload: {
            ok: true,
          },
          queue: {
            queued: true,
          },
        })).afterCommit(),
      ).rejects.toThrow('db exploded')
      broadcastRuntimeInternals.setLoadQueueModuleForTesting(undefined)
      await expect(
        broadcastRaw({
          event: 'orders.db-error',
          channels: ['orders.14'],
          payload: {
            ok: true,
          },
        }).afterCommit(),
      ).rejects.toThrow('db exploded')
    } finally {
      broadcastRuntimeInternals.setLoadDbModuleForTesting(undefined)
      broadcastRuntimeInternals.setLoadQueueModuleForTesting(undefined)
    }
  })
})
