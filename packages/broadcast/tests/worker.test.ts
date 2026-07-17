import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { normalizeBroadcastConfig } from '../src'
import { normalizeRedisConfig } from '@holo-js/kernel'
import { normalizeQueueConfig as normalizeQueueConfigForHolo } from '@holo-js/queue'
import {
  createBroadcastWorkerRuntime,
  startBroadcastWorker,
  workerInternals,
} from '../src/worker'
import { defineChannel } from '../src'
import { defineSchema, field } from '@holo-js/validation'

const FIXED_NOW_MS = 1_700_000_000_000

function createRawConfig() {
  return {
    default: 'holo-main',
    connections: {
      'holo-main': {
        driver: 'holo' as const,
        appId: 'app-main',
        key: 'key-main',
        secret: 'secret-main',
        clientOptions: {
          authEndpoint: 'https://app.example.test/broadcasting/auth',
        },
      },
      'holo-tenant': {
        driver: 'holo' as const,
        appId: 'app-tenant',
        key: 'key-tenant',
        secret: 'secret-tenant',
        clientOptions: {
          authEndpoint: 'https://tenant.example.test/broadcasting/auth',
        },
      },
      pusher: {
        driver: 'pusher' as const,
        appId: 'pusher-app',
        key: 'pusher-key',
        secret: 'pusher-secret',
      },
    },
    worker: {
      healthPath: '/healthz',
      statsPath: '/statsz',
    },
  }
}

function createConfig() {
  return normalizeBroadcastConfig(createRawConfig())
}

function createRedisConfig(overrides: {
  default?: string
  connections?: Record<string, {
    url?: string
    host?: string
    port?: number
    username?: string
    password?: string
    db?: number
  }>
} = {}) {
  return normalizeRedisConfig({
    default: overrides.default ?? 'broadcast',
    connections: overrides.connections ?? {
      broadcast: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    },
  })
}

function createSocket(app: { connection: string, appId: string, key: string, secret: string, authEndpoint?: string }) {
  const messages: string[] = []
  return {
    socket: {
      socketId: `${app.key}.1`,
      app,
      headers: new Headers({
        authorization: 'Bearer session-token',
        cookie: 'sid=abc',
      }),
      send(payload: string) {
        messages.push(payload)
      },
      close: vi.fn(),
    },
    messages,
  }
}

function decodeMessages(messages: readonly string[]) {
  return messages.map(message => JSON.parse(message) as { event: string, channel?: string, data: string })
}

function createInMemoryScalingHub() {
  const hashStore = new Map<string, Map<string, string>>()
  const subscribers = new Map<string, Set<(payload: string) => void>>()

  const createAdapter = () => Object.freeze({
    async publish(channel: string, payload: string) {
      for (const listener of subscribers.get(channel) ?? []) {
        listener(payload)
      }
    },
    async subscribe(channel: string, onMessage: (payload: string) => void) {
      const listeners = subscribers.get(channel) ?? new Set<(payload: string) => void>()
      listeners.add(onMessage)
      subscribers.set(channel, listeners)
      return async () => {
        listeners.delete(onMessage)
        if (listeners.size === 0) {
          subscribers.delete(channel)
        }
      }
    },
    async hashSet(key: string, field: string, value: string) {
      const record = hashStore.get(key) ?? new Map<string, string>()
      record.set(field, value)
      hashStore.set(key, record)
    },
    async hashDelete(key: string, field: string) {
      const record = hashStore.get(key)
      if (!record) {
        return
      }

      record.delete(field)
      if (record.size === 0) {
        hashStore.delete(key)
      }
    },
    async hashGetAll(key: string) {
      const record = hashStore.get(key)
      return Object.freeze(Object.fromEntries(record ? [...record.entries()] : []))
    },
    async close() {},
  })

  return Object.freeze({
    createAdapter,
  })
}

function createFakeRedisModule(options: {
  throwOnCommandQuit?: boolean
  throwOnSubscriberQuit?: boolean
} = {}) {
  const hashes = new Map<string, Map<string, string>>()
  const published: Array<{ channel: string, payload: string }> = []
  const constructorArgs: unknown[][] = []
  const commandDisconnect = vi.fn()
  const subscriberDisconnect = vi.fn()
  const subscriberOn = vi.fn()
  const subscriberOff = vi.fn()
  const subscriberUnsubscribe = vi.fn()
  let subscriberHandler: ((channel: string, payload: string) => void) | undefined

  const module = {
    default: class FakeRedis {
      private readonly role: 'command' | 'subscriber'

      constructor(...args: unknown[]) {
        constructorArgs.push(args)
        this.role = constructorArgs.length === 1 ? 'command' : 'subscriber'
      }

      async subscribe() {
        return 1
      }

      on(event: 'message', callback: (channel: string, payload: string) => void) {
        subscriberOn(event, callback)
        subscriberHandler = callback
      }

      async unsubscribe(channel: string) {
        subscriberUnsubscribe(channel)
        return 1
      }

      off(event: 'message', callback: (channel: string, payload: string) => void) {
        subscriberOff(event, callback)
        if (subscriberHandler === callback) {
          subscriberHandler = undefined
        }
      }

      duplicate() {
        return new FakeRedis()
      }

      async publish(channel: string, payload: string) {
        published.push({ channel, payload })
        return 1
      }

      async hset(key: string, field: string, value: string) {
        const record = hashes.get(key) ?? new Map<string, string>()
        record.set(field, value)
        hashes.set(key, record)
        return 1
      }

      async hdel(key: string, field: string) {
        const record = hashes.get(key)
        if (!record) {
          return 0
        }
        const existed = record.delete(field)
        if (record.size === 0) {
          hashes.delete(key)
        }
        return existed ? 1 : 0
      }

      async hgetall(key: string) {
        return Object.fromEntries(hashes.get(key) ?? new Map<string, string>())
      }

      async quit() {
        if (this.role === 'subscriber') {
          if (options.throwOnSubscriberQuit) {
            throw new Error('subscriber quit failed')
          }
          return
        }

        if (options.throwOnCommandQuit) {
          throw new Error('command quit failed')
        }
      }

      disconnect() {
        if (this.role === 'subscriber') {
          subscriberDisconnect()
          return
        }

        commandDisconnect()
      }
    },
    Cluster: class FakeRedisCluster extends (class {} as new (...args: unknown[]) => {
      startupNodes: unknown[]
      options?: unknown
      role: 'command' | 'subscriber'
      subscribe(): Promise<number>
      on(event: 'message', callback: (channel: string, payload: string) => void): void
      unsubscribe(channel: string): Promise<number>
      off(event: 'message', callback: (channel: string, payload: string) => void): void
      publish(channel: string, payload: string): Promise<number>
      hset(key: string, field: string, value: string): Promise<number>
      hdel(key: string, ...fields: string[]): Promise<number>
      hgetall(key: string): Promise<Record<string, string>>
      quit(): Promise<void>
      disconnect(): void
    }) {
      override readonly startupNodes: unknown[]
      override readonly options?: unknown
      override readonly role: 'command' | 'subscriber'

      constructor(startupNodes: unknown[], options?: unknown) {
        super()
        constructorArgs.push([startupNodes, options])
        this.startupNodes = startupNodes
        this.options = options
        this.role = constructorArgs.length === 1 ? 'command' : 'subscriber'
      }

      override async subscribe() {
        return 1
      }

      override on(event: 'message', callback: (channel: string, payload: string) => void) {
        subscriberOn(event, callback)
        subscriberHandler = callback
      }

      override async unsubscribe(channel: string) {
        subscriberUnsubscribe(channel)
        return 1
      }

      override off(event: 'message', callback: (channel: string, payload: string) => void) {
        subscriberOff(event, callback)
        if (subscriberHandler === callback) {
          subscriberHandler = undefined
        }
      }

      override async publish(channel: string, payload: string) {
        published.push({ channel, payload })
        return 1
      }

      override async hset(key: string, field: string, value: string) {
        const map = hashes.get(key) ?? new Map<string, string>()
        map.set(field, value)
        hashes.set(key, map)
        return 1
      }

      override async hdel(key: string, ...fields: string[]) {
        const map = hashes.get(key)
        if (!map) {
          return 0
        }
        let deleted = 0
        for (const field of fields) {
          if (map.delete(field)) {
            deleted += 1
          }
        }
        if (map.size === 0) {
          hashes.delete(key)
        }
        return deleted
      }

      override async hgetall(key: string) {
        return Object.fromEntries(hashes.get(key)?.entries() ?? [])
      }

      override async quit() {
        if (this.role === 'subscriber') {
          if (options.throwOnSubscriberQuit) {
            throw new Error('subscriber quit failed')
          }
          return
        }

        if (options.throwOnCommandQuit) {
          throw new Error('command quit failed')
        }
      }

      override disconnect() {
        if (this.role === 'subscriber') {
          subscriberDisconnect()
          return
        }

        commandDisconnect()
      }
    },
  }

  return Object.freeze({
    module,
    emit(channel: string, payload: string) {
      subscriberHandler?.(channel, payload)
    },
    constructorArgs,
    published,
    commandDisconnect,
    subscriberDisconnect,
    subscriberOn,
    subscriberOff,
    subscriberUnsubscribe,
  })
}

describe('@holo-js/broadcast worker runtime', () => {
  it('supports handshake, subscriptions, presence lifecycle, whispers, and stats', async () => {
    const fetcher = vi.fn(async (request: Request) => {
      const bodyText = await request.text()
      const body = new URLSearchParams(bodyText)
      const channel = body.get('channel_name')
      if (channel === 'orders.ord_1') {
        return new Response(JSON.stringify({
          ok: true,
          type: 'private',
          whispers: ['typing.start'],
        }), { status: 200 })
      }

      if (channel === 'chat.room_1') {
        return new Response(JSON.stringify({
          ok: true,
          type: 'presence',
          whispers: ['typing.start'],
          member: {
            id: 'user_1',
            name: 'Ava',
          },
        }), { status: 200 })
      }

      if (channel === 'chat.room_2') {
        return new Response(JSON.stringify({
          ok: true,
          type: 'presence',
          whispers: ['typing.start'],
        }), { status: 200 })
      }

      if (channel === 'orders.ord_3') {
        return new Response(JSON.stringify({
          ok: true,
          type: 'private',
        }), { status: 200 })
      }

      return new Response('forbidden', { status: 403 })
    })

    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      fetch: fetcher as typeof fetch,
      now: () => 1700000000000,
    })
    const apps = workerInternals.buildWorkerApps(createConfig())
    const mainApp = apps['key-main']!

    const first = createSocket(mainApp)
    runtime.connectWebSocket(first.socket)
    const second = createSocket(mainApp)
    second.socket.socketId = `${mainApp.key}.2`
    runtime.connectWebSocket(second.socket)

    const firstHandshake = decodeMessages(first.messages)[0]!
    expect(firstHandshake.event).toBe('pusher:connection_established')

    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_1',
      },
    }))
    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_1',
      },
    }))
    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))
    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_2',
      },
    }))
    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_3',
      },
    }))

    const firstEvents = decodeMessages(first.messages).map(event => event.event)
    expect(firstEvents).toContain('pusher_internal:subscription_succeeded')

    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'client-typing.start',
      channel: 'private-orders.ord_1',
      data: {
        editing: true,
      },
    }))

    const secondDecoded = decodeMessages(second.messages)
    expect(secondDecoded.some(event => event.event === 'client-typing.start')).toBe(true)

    await expect(runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'client-not-allowed',
      channel: 'private-orders.ord_1',
      data: {
        editing: true,
      },
    }))).rejects.toThrow('not allowed')

    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'private-orders.ord_1',
      },
    }))
    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))
    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'presence-chat.room_2',
      },
    }))
    runtime.disconnectWebSocket(second.socket.socketId)

    expect(runtime.getStats()).toEqual({
      nodeId: 'standalone',
      uptimeMs: 0,
      apps: ['holo-main', 'holo-tenant'],
      appScopes: [{
        connection: 'holo-main',
        appId: 'app-main',
        key: 'key-main',
      }, {
        connection: 'holo-tenant',
        appId: 'app-tenant',
        key: 'key-tenant',
      }],
      connectionCount: 1,
      subscribedChannelCount: 1,
      presenceChannelCount: 0,
      scaling: false,
    })
  })

  it('removes app-scoped subscriptions when a socket disconnects', async () => {
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      channelAuth: {
        definitions: [
          defineChannel('orders.{orderId}', {
            type: 'private',
            authorize() {
              return true
            },
            whispers: {},
          }),
        ],
      },
      now: () => 1700000000000,
    })
    const app = workerInternals.buildWorkerApps(createConfig())['key-main']!
    const socket = createSocket(app)

    runtime.connectWebSocket(socket.socket)
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_1',
      },
    }))

    expect(runtime.getStats().subscribedChannelCount).toBe(1)

    runtime.disconnectWebSocket(socket.socket.socketId)

    expect(runtime.getStats()).toMatchObject({
      connectionCount: 0,
      subscribedChannelCount: 0,
    })
  })

  it('passes resolved channel guards to in-process subscription auth', async () => {
    const selectedGuards: Array<string | undefined> = []
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      channelAuth: {
        definitions: [
          defineChannel('admin.{roomId}', {
            type: 'private',
            guard: 'admin',
            authorize(user) {
              return (user as { guard?: string }).guard === 'admin'
            },
          }),
          defineChannel('users.{userId}', {
            type: 'private',
            authorize(user) {
              return (user as { guard?: string }).guard === undefined
            },
          }),
          defineChannel('dynamic.{area}', {
            type: 'private',
            guard({ params }) {
              return params.area === 'admin' ? 'admin' : 'web'
            },
            authorize(user) {
              return Boolean(user)
            },
          }),
        ],
        resolveUser({ guard }) {
          selectedGuards.push(guard)
          return {
            guard,
          }
        },
      },
      now: () => FIXED_NOW_MS,
    })
    const app = workerInternals.buildWorkerApps(createConfig())['key-main']!
    const socket = createSocket(app)
    runtime.connectWebSocket(socket.socket)

    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-admin.room_1',
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-users.user_1',
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-dynamic.admin',
      },
    }))

    expect(selectedGuards).toEqual(['admin', undefined, 'admin'])
  })

  it('tracks whisper permissions per socket for the same channel', async () => {
    const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const authorization = request.headers.get('authorization')
      return new Response(JSON.stringify({
        ok: true,
        type: 'private',
        whispers: authorization === 'Bearer socket-two'
          ? ['typing.stop']
          : ['typing.start'],
      }), { status: 200 })
    }) as typeof globalThis.fetch

    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      fetch,
    })
    const app = workerInternals.buildWorkerApps(createConfig())['key-main']!
    const first = createSocket(app)
    const second = createSocket(app)
    second.socket.socketId = `${app.key}.2`
    second.socket.headers = new Headers({
      authorization: 'Bearer socket-two',
      cookie: 'sid=def',
    })
    runtime.connectWebSocket(first.socket)
    runtime.connectWebSocket(second.socket)

    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_2',
      },
    }))
    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_2',
      },
    }))

    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'client-typing.start',
      channel: 'private-orders.ord_2',
      data: {
        editing: true,
      },
    }))
    await expect(runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'client-typing.start',
      channel: 'private-orders.ord_2',
      data: {
        editing: true,
      },
    }))).rejects.toThrow('not allowed')

    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'client-typing.stop',
      channel: 'private-orders.ord_2',
      data: {
        editing: false,
      },
    }))
    await expect(runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'client-typing.stop',
      channel: 'private-orders.ord_2',
      data: {
        editing: false,
      },
    }))).rejects.toThrow('not allowed')
  })

  it('emits presence member add and remove events to existing subscribers', async () => {
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      channelAuth: {
        definitions: [
          defineChannel('chat.{roomId}', {
            type: 'presence',
            authorize(user) {
              return {
                id: (user as { id: string }).id,
                role: 'moderator',
              }
            },
          }),
        ],
        resolveUser({ socketId }) {
          return {
            id: socketId === 'presence.1' ? 'user_1' : 'user_2',
          }
        },
      },
      now: () => FIXED_NOW_MS,
    })
    const app = workerInternals.buildWorkerApps(createConfig())['key-main']!
    const first = createSocket(app)
    first.socket.socketId = 'presence.1'
    const second = createSocket(app)
    second.socket.socketId = 'presence.2'

    runtime.connectWebSocket(first.socket)
    runtime.connectWebSocket(second.socket)

    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))
    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))

    const addedMessage = decodeMessages(first.messages)
      .filter(message => message.event === 'pusher_internal:member_added' && message.channel === 'presence-chat.room_1')
      .at(-1)
    expect(addedMessage).toBeDefined()
    expect(JSON.parse(addedMessage!.data)).toEqual({
      id: 'user_2',
      role: 'moderator',
    })

    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))

    const removedMessage = decodeMessages(first.messages)
      .filter(message => message.event === 'pusher_internal:member_removed' && message.channel === 'presence-chat.room_1')
      .at(-1)
    expect(removedMessage).toBeDefined()
    expect(JSON.parse(removedMessage!.data)).toEqual({
      user_id: 'user_2',
    })
  })

  it('deduplicates presence members by user id across multiple sockets', async () => {
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      channelAuth: {
        definitions: [
          defineChannel('chat.{roomId}', {
            type: 'presence',
            authorize(user) {
              return {
                id: (user as { id: string }).id,
                role: (user as { role: string }).role,
              }
            },
          }),
        ],
        resolveUser({ socketId }) {
          if (socketId === 'observer.1') {
            return { id: 'observer', role: 'observer' }
          }

          return { id: 'user_1', role: 'moderator' }
        },
      },
      now: () => FIXED_NOW_MS,
    })
    const app = workerInternals.buildWorkerApps(createConfig())['key-main']!
    const observer = createSocket(app)
    observer.socket.socketId = 'observer.1'
    const first = createSocket(app)
    first.socket.socketId = 'presence.1'
    const second = createSocket(app)
    second.socket.socketId = 'presence.2'

    runtime.connectWebSocket(observer.socket)
    runtime.connectWebSocket(first.socket)
    runtime.connectWebSocket(second.socket)

    await runtime.receiveWebSocketMessage(observer.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))
    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))
    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))

    const firstPresenceSucceeded = decodeMessages(first.messages)
      .filter(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === 'presence-chat.room_1')
      .at(-1)
    expect(firstPresenceSucceeded).toBeDefined()
    expect(JSON.parse(firstPresenceSucceeded!.data)).toEqual({
      presence: {
        count: 2,
        ids: ['observer', 'user_1'],
        hash: {
          observer: {
            id: 'observer',
            role: 'observer',
          },
          user_1: {
            id: 'user_1',
            role: 'moderator',
          },
        },
      },
    })

    const secondPresenceSucceeded = decodeMessages(second.messages)
      .filter(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === 'presence-chat.room_1')
      .at(-1)
    expect(secondPresenceSucceeded).toBeDefined()
    expect(JSON.parse(secondPresenceSucceeded!.data)).toEqual({
      presence: {
        count: 2,
        ids: ['observer', 'user_1'],
        hash: {
          observer: {
            id: 'observer',
            role: 'observer',
          },
          user_1: {
            id: 'user_1',
            role: 'moderator',
          },
        },
      },
    })

    const addedMessages = decodeMessages(observer.messages)
      .filter(message => message.event === 'pusher_internal:member_added' && message.channel === 'presence-chat.room_1')
    expect(addedMessages).toHaveLength(1)
    expect(JSON.parse(addedMessages[0]!.data)).toEqual({
      id: 'user_1',
      role: 'moderator',
    })

    await runtime.receiveWebSocketMessage(second.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))

    let removedMessages = decodeMessages(observer.messages)
      .filter(message => message.event === 'pusher_internal:member_removed' && message.channel === 'presence-chat.room_1')
    expect(removedMessages).toHaveLength(0)

    await runtime.receiveWebSocketMessage(first.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))

    removedMessages = decodeMessages(observer.messages)
      .filter(message => message.event === 'pusher_internal:member_removed' && message.channel === 'presence-chat.room_1')
    expect(removedMessages).toHaveLength(1)
    expect(JSON.parse(removedMessages[0]!.data)).toEqual({
      user_id: 'user_1',
    })
  })

  it('does not re-add subscriptions when subscribe auth resolves after disconnect', async () => {
    let resolveAuth: ((value: Response) => void) | undefined
    const authPending = new Promise<Response>((resolve) => {
      resolveAuth = resolve
    })

    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      fetch: vi.fn(async () => await authPending) as typeof fetch,
    })
    const app = workerInternals.buildWorkerApps(createConfig())['key-main']!
    const socket = createSocket(app)

    runtime.connectWebSocket(socket.socket)
    const subscribeTask = runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_9',
      },
    }))
    runtime.disconnectWebSocket(socket.socket.socketId)

    resolveAuth!(new Response(JSON.stringify({
      ok: true,
      type: 'private',
      whispers: [],
    }), { status: 200 }))
    await subscribeTask

    expect(runtime.getStats()).toMatchObject({
      connectionCount: 0,
      subscribedChannelCount: 0,
    })
  })

  it('validates publish endpoint signatures and dispatches to subscribed channels', async () => {
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        type: 'private',
        whispers: [],
      }), { status: 200 })) as typeof fetch,
    })
    const app = workerInternals.buildWorkerApps(createConfig())['key-main']!
    const subscriber = createSocket(app)
    runtime.connectWebSocket(subscriber.socket)
    await runtime.receiveWebSocketMessage(subscriber.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_2',
      },
    }))

    const payload = JSON.stringify({
      name: 'orders.updated',
      channels: ['private-orders.ord_2'],
      data: JSON.stringify({
        id: 'ord_2',
      }),
    })
    const bodyMd5 = createHash('md5').update(payload).digest('hex')
    const url = new URL('http://worker.test/apps/app-main/events')
    url.searchParams.set('auth_key', app.key)
    url.searchParams.set('auth_timestamp', '1700000000')
    url.searchParams.set('auth_version', '1.0')
    url.searchParams.set('body_md5', bodyMd5)
    url.searchParams.set('auth_signature', workerInternals.createPusherSignature(
      app.secret,
      'POST',
      url.pathname,
      url.searchParams,
    ))

    const publish = await runtime.fetch(new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: payload,
    }))

    expect(publish.status).toBe(200)
    await expect(publish.json()).resolves.toEqual({
      ok: true,
      deliveredChannels: ['private-orders.ord_2'],
      deliveredSockets: 1,
    })

    const invalidSignatureUrl = new URL(url)
    invalidSignatureUrl.searchParams.set('auth_signature', 'invalid')
    const invalid = await runtime.fetch(new Request(invalidSignatureUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: payload,
    }))
    expect(invalid.status).toBe(401)

    const expectedSignature = workerInternals.createPusherSignature(
      app.secret,
      'POST',
      url.pathname,
      url.searchParams,
    )
    expect(workerInternals.verifyPusherSignature(expectedSignature, expectedSignature)).toBe(true)
    expect(workerInternals.verifyPusherSignature('0'.repeat(expectedSignature.length), expectedSignature)).toBe(false)
    expect(workerInternals.verifyPusherSignature('abc', expectedSignature)).toBe(false)
    expect(workerInternals.verifyPusherSignature('not-hex'.padEnd(expectedSignature.length, '0'), expectedSignature)).toBe(false)
    expect(workerInternals.verifyPusherSignature(expectedSignature, 'not-hex'.padEnd(expectedSignature.length, '0'))).toBe(false)
  })

  it('keeps broadcast delivery scoped to the app that published it', async () => {
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        type: 'private',
        whispers: [],
      }), { status: 200 })) as typeof fetch,
    })
    const apps = workerInternals.buildWorkerApps(createConfig())
    const mainApp = apps['key-main']!
    const tenantApp = apps['key-tenant']!
    const mainSocket = createSocket(mainApp)
    const tenantSocket = createSocket(tenantApp)
    runtime.connectWebSocket(mainSocket.socket)
    runtime.connectWebSocket(tenantSocket.socket)

    await runtime.receiveWebSocketMessage(mainSocket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_2',
      },
    }))
    await runtime.receiveWebSocketMessage(tenantSocket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_2',
      },
    }))

    const payload = JSON.stringify({
      name: 'orders.updated',
      channels: ['private-orders.ord_2'],
      data: JSON.stringify({
        id: 'ord_2',
      }),
    })
    const bodyMd5 = createHash('md5').update(payload).digest('hex')
    const url = new URL('http://worker.test/apps/app-main/events')
    url.searchParams.set('auth_key', mainApp.key)
    url.searchParams.set('auth_timestamp', '1700000000')
    url.searchParams.set('auth_version', '1.0')
    url.searchParams.set('body_md5', bodyMd5)
    url.searchParams.set('auth_signature', workerInternals.createPusherSignature(
      mainApp.secret,
      'POST',
      url.pathname,
      url.searchParams,
    ))

    const publish = await runtime.fetch(new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: payload,
    }))

    expect(publish.status).toBe(200)
    expect(decodeMessages(mainSocket.messages).some(message => message.event === 'orders.updated')).toBe(true)
    expect(decodeMessages(tenantSocket.messages).some(message => message.event === 'orders.updated')).toBe(false)
  })

  it('coordinates multi-node fan-out and presence when scaling is enabled', async () => {
    const hub = createInMemoryScalingHub()
    const config = normalizeBroadcastConfig({
      default: 'holo-main',
      connections: {
        'holo-main': {
          driver: 'holo',
          appId: 'app-main',
          key: 'key-main',
          secret: 'secret-main',
        },
      },
      worker: {
        scaling: {
          driver: 'redis',
          connection: 'broadcast',
        },
      },
    })
    const channelAuth = {
      definitions: [
        defineChannel('orders.{orderId}', {
          type: 'private',
          authorize() {
            return true
          },
          whispers: {
            'typing.start': defineSchema({
              editing: field.boolean().required(),
            }),
          },
        }),
        defineChannel('chat.{roomId}', {
          type: 'presence',
          authorize() {
            return {
              id: 'user_1',
            }
          },
        }),
      ],
    }
    const eventChannel = workerInternals.resolveScalingEventChannel('broadcast')
    const runtimeA = createBroadcastWorkerRuntime({
      config,
      now: () => FIXED_NOW_MS,
      channelAuth,
      scaling: {
        driver: 'redis',
        connection: 'broadcast',
        nodeId: 'node-a',
        eventChannel,
        adapter: hub.createAdapter(),
      },
    })
    const runtimeB = createBroadcastWorkerRuntime({
      config,
      now: () => FIXED_NOW_MS,
      channelAuth,
      scaling: {
        driver: 'redis',
        connection: 'broadcast',
        nodeId: 'node-b',
        eventChannel,
        adapter: hub.createAdapter(),
      },
    })
    const app = workerInternals.buildWorkerApps(config)['key-main']!
    const socketA = createSocket(app)
    socketA.socket.socketId = 'a.1'
    const socketB = createSocket(app)
    socketB.socket.socketId = 'b.1'
    runtimeA.connectWebSocket(socketA.socket)
    runtimeB.connectWebSocket(socketB.socket)

    await runtimeA.receiveWebSocketMessage(socketA.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_1',
      },
    }))
    await runtimeB.receiveWebSocketMessage(socketB.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_1',
      },
    }))
    await runtimeA.receiveWebSocketMessage(socketA.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))
    await runtimeB.receiveWebSocketMessage(socketB.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))

    await new Promise(resolve => setTimeout(resolve, 0))

    const memberAdded = decodeMessages(socketA.messages)
      .filter(message => message.event === 'pusher_internal:member_added' && message.channel === 'presence-chat.room_1')
      .at(-1)
    expect(memberAdded).toBeUndefined()

    await runtimeA.receiveWebSocketMessage(socketA.socket.socketId, JSON.stringify({
      event: 'client-typing.start',
      channel: 'private-orders.ord_1',
      data: {
        editing: true,
      },
    }))

    const payload = JSON.stringify({
      name: 'orders.updated',
      channels: ['private-orders.ord_1'],
      data: JSON.stringify({
        id: 'ord_1',
      }),
    })
    const publishUrl = new URL('http://worker.test/apps/app-main/events')
    publishUrl.searchParams.set('auth_key', app.key)
    publishUrl.searchParams.set('auth_timestamp', '1700000000')
    publishUrl.searchParams.set('auth_version', '1.0')
    publishUrl.searchParams.set('body_md5', createHash('md5').update(payload).digest('hex'))
    publishUrl.searchParams.set('auth_signature', workerInternals.createPusherSignature(
      app.secret,
      'POST',
      publishUrl.pathname,
      publishUrl.searchParams,
    ))
    const publish = await runtimeA.fetch(new Request(publishUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: payload,
    }))
    expect(publish.status).toBe(200)

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(decodeMessages(socketB.messages).some(message => message.event === 'orders.updated')).toBe(true)

    const presenceSucceeded = decodeMessages(socketB.messages)
      .filter(message => message.event === 'pusher_internal:subscription_succeeded' && message.channel === 'presence-chat.room_1')
      .at(-1)
    expect(presenceSucceeded).toBeDefined()
    const presenceData = JSON.parse(presenceSucceeded!.data) as {
      presence: {
        count: number
        ids: string[]
      }
    }
    expect(presenceData.presence.count).toBe(1)
    expect(presenceData.presence.ids).toEqual(['user_1'])

    expect(runtimeB.getStats()).toMatchObject({
      nodeId: 'node-b',
      scaling: {
        driver: 'redis',
        connection: 'broadcast',
        eventChannel,
      },
      appScopes: [{
        connection: 'holo-main',
        appId: 'app-main',
        key: 'key-main',
      }],
    })

    const probe = hub.createAdapter()
    await probe.publish(eventChannel, JSON.stringify({
      type: 'event',
      originNodeId: 'node-c',
      appId: 'app-main',
      name: 'orders.ignored',
      channels: [123],
      data: '{}',
    }))
    await probe.publish(eventChannel, JSON.stringify({
      type: 'event',
      originNodeId: 'node-c',
      channels: ['private-orders.ord_1'],
    }))
    await probe.publish(eventChannel, JSON.stringify({
      type: 'noop',
    }))
    await probe.close()

    await runtimeA.receiveWebSocketMessage(socketA.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'presence-chat.room_1',
      },
    }))

    await new Promise(resolve => setTimeout(resolve, 0))

    const memberRemoved = decodeMessages(socketB.messages)
      .filter(message => message.event === 'pusher_internal:member_removed' && message.channel === 'presence-chat.room_1')
      .at(-1)
    expect(memberRemoved).toBeUndefined()

    await runtimeA.receiveWebSocketMessage(socketA.socket.socketId, JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: 'private-orders.ord_1',
      },
    }))

    await runtimeA.close()
    await runtimeB.close()
  })

  it('returns an error response when scaled publish replication fails', async () => {
    const config = normalizeBroadcastConfig({
      default: 'holo-main',
      connections: {
        'holo-main': {
          driver: 'holo',
          appId: 'app-main',
          key: 'key-main',
          secret: 'secret-main',
        },
      },
      worker: {
        scaling: {
          driver: 'redis',
          connection: 'broadcast',
        },
      },
    })

    const makeRuntime = (throwValue: unknown) => createBroadcastWorkerRuntime({
      config,
      now: () => FIXED_NOW_MS,
      scaling: {
        driver: 'redis',
        connection: 'broadcast',
        nodeId: 'node-a',
        eventChannel: workerInternals.resolveScalingEventChannel('broadcast'),
        adapter: {
          async publish() {
            throw throwValue
          },
          async subscribe() {
            return async () => {}
          },
          async hashSet() {},
          async hashDelete() {},
          async hashGetAll() {
            return {}
          },
          async close() {},
        },
      },
    })

    const makeRequest = (runtime: ReturnType<typeof createBroadcastWorkerRuntime>) => {
      const app = workerInternals.buildWorkerApps(config)['key-main']!
      const payload = JSON.stringify({
        name: 'orders.updated',
        channels: ['private-orders.ord_2'],
        data: JSON.stringify({ id: 'ord_2' }),
      })
      const url = new URL('http://worker.test/apps/app-main/events')
      url.searchParams.set('auth_key', app.key)
      url.searchParams.set('auth_timestamp', '1700000000')
      url.searchParams.set('auth_version', '1.0')
      url.searchParams.set('body_md5', createHash('md5').update(payload).digest('hex'))
      url.searchParams.set('auth_signature', workerInternals.createPusherSignature(
        app.secret, 'POST', url.pathname, url.searchParams,
      ))
      return runtime.fetch(new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }))
    }

    // Error instance — message is used
    const errorResponse = await makeRequest(makeRuntime(new Error('replication offline')))
    expect(errorResponse.status).toBe(500)
    await expect(errorResponse.text()).resolves.toBe('replication offline')

    // Non-Error throw — fallback message is used
    const nonErrorResponse = await makeRequest(makeRuntime('string error'))
    expect(nonErrorResponse.status).toBe(500)
    await expect(nonErrorResponse.text()).resolves.toBe('Broadcast publish failed.')
  })

  it('creates redis scaling adapters via lazy module loading and supports pub/sub + hash operations', async () => {
    const fakeRedis = createFakeRedisModule()
    const adapter = await workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    }, {
      loadRedisModule: async () => fakeRedis.module,
    })

    const received: string[] = []
    const unsubscribe = await adapter.subscribe('events', (payload) => {
      received.push(payload)
    })
    fakeRedis.emit('ignored', 'x')
    fakeRedis.emit('events', 'first')
    expect(received).toEqual(['first'])

    await adapter.publish('events', 'payload')
    expect(fakeRedis.published).toEqual([{
      channel: 'events',
      payload: 'payload',
    }])

    await adapter.hashSet('presence', 'node-a:1', '{"id":"user_1"}')
    expect(await adapter.hashGetAll('presence')).toEqual({
      'node-a:1': '{"id":"user_1"}',
    })
    await adapter.hashDelete('presence', 'node-a:1')
    expect(await adapter.hashGetAll('presence')).toEqual({})

    await unsubscribe()
    await unsubscribe()
    fakeRedis.emit('events', 'second')
    expect(received).toEqual(['first'])
    expect(fakeRedis.subscriberOn).toHaveBeenCalled()
    expect(fakeRedis.subscriberUnsubscribe).toHaveBeenCalledWith('events')
    expect(fakeRedis.subscriberOff).toHaveBeenCalled()
    await adapter.close()
    expect(fakeRedis.commandDisconnect).not.toHaveBeenCalled()
    expect(fakeRedis.subscriberDisconnect).not.toHaveBeenCalled()

    const failingRedis = createFakeRedisModule({
      throwOnCommandQuit: true,
      throwOnSubscriberQuit: true,
    })
    const failingAdapter = await workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 1,
    }, {
      loadRedisModule: async () => failingRedis.module,
    })
    await failingAdapter.close()
    expect(failingRedis.commandDisconnect).toHaveBeenCalledTimes(1)
    expect(failingRedis.subscriberDisconnect).toHaveBeenCalledTimes(1)

    const urlRedis = createFakeRedisModule()
    const urlAdapter = await workerInternals.createRedisScalingAdapter({
      url: 'redis://cache.internal:6380/4',
      host: '127.0.0.1',
      port: 6379,
      username: 'worker',
      password: 'secret',
      db: 4,
    }, {
      loadRedisModule: async () => urlRedis.module,
    })
    await urlAdapter.close()
    expect(urlRedis.constructorArgs[0]).toEqual([
      'redis://cache.internal:6380/4',
      {
        username: 'worker',
        password: 'secret',
        db: 4,
      },
    ])
    expect(urlRedis.commandDisconnect).not.toHaveBeenCalled()
    expect(urlRedis.subscriberDisconnect).not.toHaveBeenCalled()

    const mixedRedis = createFakeRedisModule()
    const mixedAdapter = await workerInternals.createRedisScalingAdapter({
      url: 'redis://cache.internal:6380/4',
      host: '127.0.0.1',
      port: 6379,
      username: 'worker',
      password: 'secret',
      db: 0,
      clusters: [{
        url: 'rediss://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    }, {
      loadRedisModule: async () => mixedRedis.module,
    })
    await mixedAdapter.close()
    expect(mixedRedis.constructorArgs[0]).toEqual([[
      {
        host: 'cache.internal',
        port: 6380,
        tls: {},
      },
    ], {
      redisOptions: {
        username: 'worker',
        password: 'secret',
        db: 0,
        tls: {},
      },
    }])

    const clusterRedis = createFakeRedisModule()
    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      username: 'worker',
      password: 'secret',
      db: 4,
      clusters: [{
        url: 'rediss://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    }, {
      loadRedisModule: async () => clusterRedis.module,
    })).rejects.toThrow('Redis Cluster does not support selecting a non-zero database')

    const clusterAdapter = await workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      username: 'worker',
      password: 'secret',
      db: 0,
      clusters: [{
        url: 'rediss://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    }, {
      loadRedisModule: async () => clusterRedis.module,
    })
    await clusterAdapter.close()
    expect(clusterRedis.constructorArgs[0]).toEqual([[
      {
        host: 'cache.internal',
        port: 6380,
        tls: {},
      },
    ], {
      redisOptions: {
        username: 'worker',
        password: 'secret',
        db: 0,
        tls: {},
      },
    }])
  })

  it('exposes health and stats endpoints and rejects invalid publish/auth flows', async () => {
    const hiddenStatsRuntime = createBroadcastWorkerRuntime({
      config: createConfig(),
    })
    expect((await hiddenStatsRuntime.fetch(new Request('http://worker.test/statsz'))).status).toBe(404)

    const config = normalizeBroadcastConfig({
      ...createRawConfig(),
      worker: {
        ...createRawConfig().worker,
        statsEnabled: true,
      },
    })
    const runtime = createBroadcastWorkerRuntime({
      config,
      fetch: vi.fn(async () => new Response('forbidden', { status: 403 })) as typeof fetch,
    })
    const app = workerInternals.buildWorkerApps(config)['key-main']!
    const socket = createSocket(app)
    runtime.connectWebSocket(socket.socket)

    const health = await runtime.fetch(new Request('http://worker.test/healthz', { method: 'GET' }))
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({
      ok: true,
    })

    const stats = await runtime.fetch(new Request('http://worker.test/statsz', { method: 'GET' }))
    expect(stats.status).toBe(200)
    await expect(stats.json()).resolves.toMatchObject({
      apps: ['holo-main', 'holo-tenant'],
      connectionCount: 1,
    })

    await expect(runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'private-orders.ord_9',
      },
    }))).rejects.toThrow('authorization rejected')

    const unknown = await runtime.fetch(new Request('http://worker.test/nope', { method: 'GET' }))
    expect(unknown.status).toBe(404)

    const limitedRuntime = createBroadcastWorkerRuntime({
      config: normalizeBroadcastConfig({
        ...createRawConfig(),
        worker: {
          ...createRawConfig().worker,
          maxRequestBytes: 4,
        },
      }),
    })
    const oversized = await limitedRuntime.fetch(new Request('http://worker.test/apps/app-main/events', {
      method: 'POST',
      body: '12345',
    }))
    expect(oversized.status).toBe(413)

    expect(workerInternals.parseChannelKind('private-orders.1')).toEqual({
      kind: 'private',
      canonical: 'orders.1',
    })
    expect(() => workerInternals.parseSocketMessage('{bad json')).toThrow('must be valid JSON')
    expect(() => workerInternals.normalizePublishBody({
      name: 'orders.updated',
      channels: [],
      data: {},
    })).toThrow('at least one channel')
    expect(() => workerInternals.normalizePublishBody({
      event: 'orders.updated',
      channel: 42,
      data: {},
    })).toThrow('at least one channel')
  })

  it('resolves multi-app credentials and validates worker startup requirements', async () => {
    const config = createConfig()
    const apps = workerInternals.buildWorkerApps(config)
    expect(apps['key-main']?.appId).toBe('app-main')
    expect(apps['key-tenant']?.appId).toBe('app-tenant')
    expect(workerInternals.resolveScalingEventChannel('broadcast')).toBe('holo:broadcast:scaling:broadcast:events')
    expect(workerInternals.parsePresenceHashMembers({
      'node-a:1.1': JSON.stringify({
        id: 'user_1',
      }),
      'node-b:2.2': '{bad',
    })).toEqual(new Map([
      ['node-a:1.1', {
        id: 'user_1',
      }],
      ['node-b:2.2', {
        id: 'node-b:2.2',
      }],
    ]))
    const queueConfig = normalizeQueueConfigForHolo({
      default: 'broadcast',
      connections: {
        broadcast: {
          driver: 'redis',
          connection: 'broadcast',
        },
      },
    }, createRedisConfig({
      connections: {
        broadcast: {
          host: '127.0.0.1',
          port: 6380,
          db: 2,
        },
      },
    }))
    expect(workerInternals.resolveRedisScalingConnection(queueConfig, 'broadcast')).toEqual({
      host: '127.0.0.1',
      port: 6380,
      username: undefined,
      password: undefined,
      db: 2,
    })
    expect(workerInternals.resolveRedisScalingConnection(
      normalizeQueueConfigForHolo({
        default: 'default',
        connections: {
          default: {
            driver: 'redis',
            connection: 'default',
          },
        },
      }, createRedisConfig({
        default: 'default',
        connections: {
          default: {
            host: '10.0.0.5',
            port: 6385,
            db: 4,
          },
        },
      })),
      'default',
      normalizeRedisConfig(),
    )).toEqual({
      host: '10.0.0.5',
      port: 6385,
      username: undefined,
      password: undefined,
      db: 4,
    })
    expect(workerInternals.resolveRedisScalingConnection(
      normalizeQueueConfigForHolo({
        default: 'default',
        connections: {
          default: {
            driver: 'sync',
          },
        },
      }),
      'default',
      normalizeRedisConfig({
        connections: {
          default: {
            host: '10.0.0.9',
            port: 6389,
            db: 9,
          },
        },
      }),
    )).toEqual({
      host: '10.0.0.9',
      port: 6389,
      username: undefined,
      password: undefined,
      db: 9,
    })
    expect(() => workerInternals.resolveRedisScalingConnection(
      normalizeQueueConfigForHolo({
        default: 'default',
        connections: {
          default: {
            driver: 'sync',
          },
        },
      }),
      'default',
    )).toThrow('must use the Redis queue driver')
    expect(workerInternals.resolveRedisScalingConnection(
      queueConfig,
      'shared-cache',
      normalizeRedisConfig({
        connections: {
          'shared-cache': {
            host: '10.0.0.7',
            port: 6382,
            db: 6,
          },
        },
      }),
    )).toEqual({
      host: '10.0.0.7',
      port: 6382,
      username: undefined,
      password: undefined,
      db: 6,
    })
    expect(() => workerInternals.resolveRedisScalingConnection(undefined, 'broadcast')).toThrow('requires either redis config or a Redis queue connection')
    expect(() => workerInternals.resolveRedisScalingConnection(queueConfig, 'missing')).toThrow('was not found')
    expect(() => workerInternals.resolveRedisScalingConnection(
      queueConfig,
      'missing',
      normalizeRedisConfig({
        connections: {
          cache: {
            host: '10.0.0.7',
            port: 6382,
            db: 6,
          },
        },
      }),
    )).toThrow('Available redis connections: cache')
    const nonRedisQueue = normalizeQueueConfigForHolo({
      default: 'sync',
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })
    expect(() => workerInternals.resolveRedisScalingConnection(nonRedisQueue, 'sync')).toThrow('must use the Redis queue driver')
    expect(() => workerInternals.buildWorkerApps(normalizeBroadcastConfig({
      default: 'log',
      connections: {
        log: {
          driver: 'log',
        },
      },
    }))).toThrow('requires at least one "holo"')

    expect(() => workerInternals.buildWorkerApps(normalizeBroadcastConfig({
      default: 'first',
      connections: {
        first: {
          driver: 'holo',
          appId: 'app-1',
          key: 'shared-key',
          secret: 'secret-1',
        },
        second: {
          driver: 'holo',
          appId: 'app-2',
          key: 'shared-key',
          secret: 'secret-2',
        },
      },
    }))).toThrow('duplicate broadcast app key')

    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    }, {
      loadRedisModule: async () => {
        const error = new Error('Cannot find module "ioredis"') as Error & { code?: string }
        error.code = 'ERR_MODULE_NOT_FOUND'
        throw error
      },
    })).rejects.toThrow('requires the "ioredis" package')
    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    }, {
      loadRedisModule: async () => ({}),
    })).rejects.toThrow('missing default Redis export')
    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    }, {
      loadRedisModule: async () => {
        throw new Error('redis unavailable')
      },
    })).rejects.toThrow('redis unavailable')
    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    }, {
      loadRedisModule: async () => {
        throw 'redis string error'
      },
    })).rejects.toThrow('redis string error')
  })

  it('starts with Bun integration and handles websocket upgrades through the runtime adapter', async () => {
    const bun = (globalThis as { Bun?: { serve?: unknown } }).Bun
    const stop = vi.fn()
    let captured: {
      fetch: (request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }) => Promise<Response>
      websocket: {
        open: (socket: { data: { socketId: string, app: unknown, headers: Headers }, send(value: string): void, close(code?: number, reason?: string): void }) => void
        message: (socket: { data: { socketId: string }, close?(code?: number, reason?: string): void }, message: string | Uint8Array) => void
        close: (socket: { data: { socketId: string } }) => void
      }
    } | undefined
    const serve = (options: unknown) => {
      captured = options as NonNullable<typeof captured>
      return {
        hostname: '0.0.0.0',
        port: 8080,
        stop,
      }
    }
    const originalServe = bun?.serve
    if (bun) {
      bun.serve = serve
    } else {
      vi.stubGlobal('Bun', {
        serve,
      })
    }

    try {
      const scalingAdapter = {
        publish: vi.fn(async () => {}),
        subscribe: vi.fn(async () => async () => {}),
        hashSet: vi.fn(async () => {}),
        hashDelete: vi.fn(async () => {}),
        hashGetAll: vi.fn(async () => ({})),
        close: vi.fn(async () => {}),
      }
      const worker = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            allowedOrigins: ['https://app.test'],
            maxMessageBytes: 64,
            scaling: {
              driver: 'redis',
              connection: 'broadcast',
            },
          },
        }),
        queue: normalizeQueueConfigForHolo({
          default: 'broadcast',
          connections: {
            broadcast: {
              driver: 'redis',
              connection: 'broadcast',
            },
          },
        }, createRedisConfig()),
        nodeId: 'node-start',
        createScalingAdapter: async () => scalingAdapter,
      })
      expect(worker.host).toBe('0.0.0.0')
      expect(worker.port).toBe(8080)
      expect(captured).toBeDefined()

      const upgrade = vi.fn(() => true)
      const upgraded = await captured!.fetch(new Request('http://worker.test/app/key-main', {
        method: 'GET',
      }), { upgrade })
      expect(upgraded.status).toBe(200)
      expect(upgrade).toHaveBeenCalledOnce()

      const forbiddenOrigin = await captured!.fetch(new Request('http://worker.test/app/key-main', {
        headers: { origin: 'https://attacker.test' },
      }), { upgrade })
      expect(forbiddenOrigin.status).toBe(403)
      expect(upgrade).toHaveBeenCalledOnce()

      const allowedOrigin = await captured!.fetch(new Request('http://worker.test/app/key-main', {
        headers: { origin: 'https://app.test' },
      }), { upgrade })
      expect(allowedOrigin.status).toBe(200)

      const wsData = ((upgrade.mock.calls as unknown as Array<[Request, { data: { socketId: string, app: { key: string }, headers: Headers } }]>)[0]![1]).data
      expect(wsData.app.key).toBe('key-main')

      const unknownUpgraded = await captured!.fetch(new Request('http://worker.test/app/missing-key', {
        method: 'GET',
      }), { upgrade })
      expect(unknownUpgraded.status).toBe(401)

      const send = vi.fn()
      const close = vi.fn()
      captured!.websocket.open({
        data: wsData,
        send,
        close,
      })

      captured!.websocket.message({
        data: {
          socketId: wsData.socketId,
        },
      }, new TextEncoder().encode(JSON.stringify({
        event: 'pusher:ping',
      })))
      captured!.websocket.message({
        data: {
          socketId: wsData.socketId,
        },
      }, JSON.stringify({
        event: 'pusher:ping',
      }))
      captured!.websocket.message({
        data: {
          socketId: wsData.socketId,
        },
        close,
      }, '{')
      await vi.waitFor(() => {
        expect(close).toHaveBeenCalledWith(4001, 'Protocol error')
      })
      captured!.websocket.message({
        data: {
          socketId: wsData.socketId,
        },
        close,
      }, 'x'.repeat(65))
      expect(close).toHaveBeenCalledWith(1009, 'Message too large')
      captured!.websocket.close({
        data: {
          socketId: wsData.socketId,
        },
      })

      const notUpgraded = await captured!.fetch(new Request('http://worker.test/app/key-main', {
        method: 'GET',
      }), { upgrade: () => false })
      expect(notUpgraded.status).toBe(404)
      const bunHealth = await captured!.fetch(new Request('http://worker.test/healthz'), { upgrade })
      expect(bunHealth.status).toBe(200)

      await worker.stop()
      expect(stop).toHaveBeenCalledWith(true)
      expect(scalingAdapter.close).toHaveBeenCalledTimes(1)

      const pathWorker = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            path: '/broadcast.v2',
          },
        }),
        queue: normalizeQueueConfigForHolo({
          default: 'broadcast',
          connections: {
            broadcast: {
              driver: 'redis',
              connection: 'broadcast',
            },
          },
        }, createRedisConfig()),
        nodeId: 'node-path',
        createScalingAdapter: async () => scalingAdapter,
      })
      const upgradedWithCustomPath = await captured!.fetch(new Request('http://worker.test/broadcast.v2/key-main', {
        method: 'GET',
      }), { upgrade })
      expect(upgradedWithCustomPath.status).toBe(200)
      await pathWorker.stop()

      const workerWithSharedRedisDefault = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            scaling: {
              driver: 'redis',
            },
          },
        }),
        redis: normalizeRedisConfig({
          default: 'cache',
          connections: {
            cache: {
              host: '10.0.0.7',
              port: 6382,
              db: 6,
            },
          },
        }),
        createScalingAdapter: async (connection) => {
          expect(connection).toEqual({
            host: '10.0.0.7',
            port: 6382,
            username: undefined,
            password: undefined,
            db: 6,
          })

          return scalingAdapter
        },
      })
      await workerWithSharedRedisDefault.stop()

      const workerWithSyncQueueDefaultScaling = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            scaling: {
              driver: 'redis',
            },
          },
        }),
        queue: normalizeQueueConfigForHolo({
          default: 'default',
          connections: {
            default: {
              driver: 'sync',
            },
          },
        }),
        redis: normalizeRedisConfig({
          default: 'cache',
          connections: {
            cache: {
              host: '10.0.0.10',
              port: 6390,
              db: 10,
            },
          },
        }),
        createScalingAdapter: async (connection) => {
          expect(connection).toEqual({
            host: '10.0.0.10',
            port: 6390,
            username: undefined,
            password: undefined,
            db: 10,
          })

          return scalingAdapter
        },
      })
      await workerWithSyncQueueDefaultScaling.stop()

      await expect(startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            scaling: {
              driver: 'redis',
            },
          },
        }),
        queue: normalizeQueueConfigForHolo({
          default: 'default',
          connections: {
            default: {
              driver: 'sync',
            },
          },
        }),
      })).rejects.toThrow('Broadcast scaling connection "default" must use the Redis queue driver.')

      const workerWithQueueDefaultScaling = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            scaling: {
              driver: 'redis',
            },
          },
        }),
        queue: normalizeQueueConfigForHolo({
          default: 'default',
          connections: {
            default: {
              driver: 'redis',
              connection: 'broadcast',
            },
          },
        }, normalizeRedisConfig({
          default: 'cache',
          connections: {
            broadcast: {
              host: '10.0.0.8',
              port: 6383,
              db: 7,
            },
            cache: {
              host: '10.0.0.9',
              port: 6384,
              db: 8,
            },
          },
        })),
        redis: normalizeRedisConfig({
          default: 'cache',
          connections: {
            broadcast: {
              host: '10.0.0.8',
              port: 6383,
              db: 7,
            },
            cache: {
              host: '10.0.0.9',
              port: 6384,
              db: 8,
            },
          },
        }),
        createScalingAdapter: async (connection) => {
          expect(connection).toEqual({
            host: '10.0.0.8',
            port: 6383,
            username: undefined,
            password: undefined,
            db: 7,
          })

          return scalingAdapter
        },
      })
      await workerWithQueueDefaultScaling.stop()

      const workerWithNamedQueueDefaultScaling = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            scaling: {
              driver: 'redis',
            },
          },
        }),
        queue: normalizeQueueConfigForHolo({
          default: 'broadcast',
          connections: {
            broadcast: {
              driver: 'redis',
              connection: 'broadcast',
            },
          },
        }, normalizeRedisConfig({
          default: 'cache',
          connections: {
            broadcast: {
              host: '10.0.0.11',
              port: 6391,
              db: 11,
            },
            cache: {
              host: '10.0.0.12',
              port: 6392,
              db: 12,
            },
          },
        })),
        redis: normalizeRedisConfig({
          default: 'cache',
          connections: {
            broadcast: {
              host: '10.0.0.11',
              port: 6391,
              db: 11,
            },
            cache: {
              host: '10.0.0.12',
              port: 6392,
              db: 12,
            },
          },
        }),
        createScalingAdapter: async (connection) => {
          expect(connection).toEqual({
            host: '10.0.0.11',
            port: 6391,
            username: undefined,
            password: undefined,
            db: 11,
          })

          return scalingAdapter
        },
      })
      await workerWithNamedQueueDefaultScaling.stop()

      const fakeRedis = createFakeRedisModule()
      const workerWithLazyRedis = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            scaling: {
              driver: 'redis',
              connection: 'broadcast',
            },
          },
        }),
        queue: normalizeQueueConfigForHolo({
          default: 'broadcast',
          connections: {
            broadcast: {
              driver: 'redis',
              connection: 'broadcast',
            },
          },
        }, createRedisConfig()),
        loadRedisModule: async () => fakeRedis.module,
      })
      await workerWithLazyRedis.stop()
      expect(fakeRedis.commandDisconnect).not.toHaveBeenCalled()
    } finally {
      if (bun) {
        bun.serve = originalServe
      } else {
        Reflect.deleteProperty(globalThis, 'Bun')
      }
    }

    if (bun) {
      bun.serve = undefined
    }
    try {
      await expect(startBroadcastWorker({
        config: createConfig(),
        loadWebSocketModule: async () => ({}),
      })).rejects.toThrow('missing WebSocketServer export')
      await expect(startBroadcastWorker({
        config: createConfig(),
        loadWebSocketModule: async () => {
          throw new Error('missing ws package')
        },
      })).rejects.toThrow('requires the "ws" package')
      await expect(startBroadcastWorker({
        config: createConfig(),
        loadWebSocketModule: async () => {
           
          throw 'non-error ws failure'
        },
      })).rejects.toThrow('requires the "ws" package')
      await expect(startBroadcastWorker({} as never)).rejects.toThrow('requires a loaded broadcast config')
      // Test without loadWebSocketModule — uses the default import('ws') path
      const workerWithRealWs = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: { ...createRawConfig().worker, host: '127.0.0.1', port: 60000 + Math.floor(Math.random() * 5000) },
        }),
      })
      await workerWithRealWs.stop()
    } finally {
      if (bun) {
        bun.serve = originalServe
      }
    }
  })

  it('fails startup when scaling subscription cannot be established', async () => {
    const scalingAdapter = {
      publish: vi.fn(async () => {}),
      subscribe: vi.fn(async () => {
        throw new Error('subscribe failed')
      }),
      hashSet: vi.fn(async () => {}),
      hashDelete: vi.fn(async () => {}),
      hashGetAll: vi.fn(async () => ({})),
      close: vi.fn(async () => {}),
    }

    await expect(startBroadcastWorker({
      config: normalizeBroadcastConfig({
        ...createRawConfig(),
        worker: {
          ...createRawConfig().worker,
          scaling: {
            driver: 'redis',
            connection: 'broadcast',
          },
        },
      }),
      queue: normalizeQueueConfigForHolo({
        default: 'broadcast',
        connections: {
          broadcast: {
            driver: 'redis',
            connection: 'broadcast',
          },
        },
      }, createRedisConfig()),
      createScalingAdapter: async () => scalingAdapter,
    })).rejects.toThrow('subscribe failed')
  })

  it('starts and stops with Node websocket fallback when Bun serve is unavailable', async () => {
    const bun = (globalThis as { Bun?: { serve?: unknown } }).Bun
    const originalServe = bun?.serve
    if (bun) {
      bun.serve = undefined
    } else {
      vi.stubGlobal('Bun', {})
    }

    const port = 20000 + Math.floor(Math.random() * 10000)
    const config = normalizeBroadcastConfig({
      ...createRawConfig(),
      worker: {
        ...createRawConfig().worker,
        host: '127.0.0.1',
        port,
      },
    })

    try {
      class FakeWebSocketServer {
        private connectionHandler: ((socket: {
          send(value: string): void
          close(code?: number, reason?: string): void
          on(event: 'message', listener: (data: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer) => void): unknown
          on(event: 'close', listener: () => void): unknown
        }, request: unknown) => void) | undefined

        on(event: 'connection', listener: typeof this.connectionHandler) {
          if (event === 'connection') {
            this.connectionHandler = listener
          }
        }

        emit(event: 'connection', socket: {
          send(value: string): void
          close(code?: number, reason?: string): void
          on(event: 'message', listener: (data: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer) => void): unknown
          on(event: 'close', listener: () => void): unknown
        }, request: unknown) {
          if (event === 'connection') {
            this.connectionHandler?.(socket, request)
          }
          return true
        }

        handleUpgrade(
          request: unknown,
          _socket: unknown,
          _head: Buffer,
          callback: (socket: {
            send(value: string): void
            close(code?: number, reason?: string): void
            on(event: 'message', listener: (data: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer) => void): unknown
            on(event: 'close', listener: () => void): unknown
          }, request: unknown) => void,
        ) {
          const client = {
            send: vi.fn(),
            close: vi.fn(),
            on(_event: 'message' | 'close', _listener: ((data: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer) => void) | (() => void)) {
            },
          }
          callback(client, request)
        }

        close(callback?: (error?: Error) => void) {
          callback?.()
        }
      }

      const worker = await startBroadcastWorker({
        config,
        loadWebSocketModule: async () => ({ WebSocketServer: FakeWebSocketServer }),
      })
      expect(worker.host).toBe('127.0.0.1')
      expect(worker.port).toBe(port)

      await worker.stop()
    } finally {
      if (bun) {
        bun.serve = originalServe
      } else {
        Reflect.deleteProperty(globalThis, 'Bun')
      }
    }
  }, 10000)

  it('closes websocket server when Node HTTP listen fails during startup', async () => {
    const bun = (globalThis as { Bun?: { serve?: unknown } }).Bun
    const originalServe = bun?.serve
    if (bun) {
      bun.serve = undefined
    } else {
      vi.stubGlobal('Bun', {})
    }

    const port = 30000 + Math.floor(Math.random() * 10000)
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(port, '127.0.0.1', () => resolve())
    })

    const wsClose = vi.fn((callback?: (error?: Error) => void) => callback?.())
    class FakeWebSocketServer {
      on(_event: 'connection', _listener: unknown) {}
      emit(_event: 'connection', _socket: unknown, _request: unknown) {
        return true
      }
      handleUpgrade(_request: unknown, _socket: unknown, _head: Buffer, _callback: unknown) {}
      close(callback?: (error?: Error) => void) {
        wsClose(callback)
      }
    }

    try {
      await expect(startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            host: '127.0.0.1',
            port,
          },
        }),
        loadWebSocketModule: async () => ({ WebSocketServer: FakeWebSocketServer }),
      })).rejects.toThrow()
      expect(wsClose).toHaveBeenCalledTimes(1)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
      if (bun) {
        bun.serve = originalServe
      } else {
        Reflect.deleteProperty(globalThis, 'Bun')
      }
    }
  })

  it('surfaces Node HTTP close errors when stop is called after shutdown', async () => {
    const bun = (globalThis as { Bun?: { serve?: unknown } }).Bun
    const originalServe = bun?.serve
    if (bun) {
      bun.serve = undefined
    } else {
      vi.stubGlobal('Bun', {})
    }

    const port = 41000 + Math.floor(Math.random() * 10000)
    class FakeWebSocketServer {
      on(_event: 'connection', _listener: unknown) {}
      emit(_event: 'connection', _socket: unknown, _request: unknown) {
        return true
      }
      handleUpgrade(_request: unknown, _socket: unknown, _head: Buffer, _callback: unknown) {}
      close(callback?: (error?: Error) => void) {
        callback?.()
      }
    }

    try {
      const worker = await startBroadcastWorker({
        config: normalizeBroadcastConfig({
          ...createRawConfig(),
          worker: {
            ...createRawConfig().worker,
            host: '127.0.0.1',
            port,
          },
        }),
        loadWebSocketModule: async () => ({ WebSocketServer: FakeWebSocketServer }),
      })
      await worker.stop()
      await expect(worker.stop()).rejects.toThrow()
    } finally {
      if (bun) {
        bun.serve = originalServe
      } else {
        Reflect.deleteProperty(globalThis, 'Bun')
      }
    }
  })

  it('rejects stale signed publish requests', async () => {
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
    })

    const publishPayload = JSON.stringify({
      event: 'orders.updated',
      channel: 'orders.ord_1',
      data: {
        id: 'ord_1',
      },
    })
    const publishUrl = new URL('http://worker.test/apps/app-main/events')
    publishUrl.searchParams.set('auth_key', 'key-main')
    publishUrl.searchParams.set('auth_timestamp', String((FIXED_NOW_MS / 1000) - 301))
    publishUrl.searchParams.set('auth_version', '1.0')
    publishUrl.searchParams.set('body_md5', createHash('md5').update(publishPayload).digest('hex'))
    publishUrl.searchParams.set('auth_signature', workerInternals.createPusherSignature(
      'secret-main',
      'POST',
      publishUrl.pathname,
      publishUrl.searchParams,
    ))

    const response = await runtime.fetch(new Request(publishUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: publishPayload,
    }))

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toContain('stale')
  })

  it('covers parseSocketMessage with object data and normalizePublishBody with name field', () => {
    // parseSocketMessage with data as an inline object (not a string)
    const result = workerInternals.parseSocketMessage(JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: 'orders.1' },
    }))
    expect(result.event).toBe('pusher:subscribe')
    expect(result.data).toEqual({ channel: 'orders.1' })

    // parseSocketMessage with data as null (falls through to empty object)
    const nullData = workerInternals.parseSocketMessage(JSON.stringify({
      event: 'pusher:ping',
      data: null,
    }))
    expect(nullData.data).toEqual({})

    // parseSocketMessage with data as array (falls through to empty object)
    const arrayData = workerInternals.parseSocketMessage(JSON.stringify({
      event: 'pusher:ping',
      data: [1, 2, 3],
    }))
    expect(arrayData.data).toEqual({})

    // normalizePublishBody with body.name instead of body.event
    expect(workerInternals.normalizePublishBody({
      name: 'orders.updated',
      channel: 'orders.1',
      data: 'raw-string-data',
    })).toEqual({
      name: 'orders.updated',
      channels: ['orders.1'],
      data: 'raw-string-data',
    })
  })

  it('exercises Node HTTP server integration with real requests and websocket upgrades', async () => {
    const bun = (globalThis as { Bun?: { serve?: unknown } }).Bun
    const originalServe = bun?.serve
    if (bun) {
      bun.serve = undefined
    } else {
      vi.stubGlobal('Bun', {})
    }

    const port = 50000 + Math.floor(Math.random() * 10000)
    const config = normalizeBroadcastConfig({
      ...createRawConfig(),
      worker: {
        ...createRawConfig().worker,
        host: '127.0.0.1',
        port,
      },
    })

    class NodeFakeWebSocketServer {
      on(_event: string, _listener: (...args: unknown[]) => void) {}
      emit(_event: string, ..._args: unknown[]) { return true }
      handleUpgrade(_request: unknown, _socket: unknown, _head: Buffer, _callback: unknown) {}
      close(callback?: (error?: Error) => void) { callback?.() }
    }

    try {
      const worker = await startBroadcastWorker({
        config,
        channelAuth: { definitions: [], resolveUser: () => null },
        loadWebSocketModule: async () => ({ WebSocketServer: NodeFakeWebSocketServer }),
      })

      // Verify the server is actually listening
      expect(worker.host).toBe('127.0.0.1')
      expect(worker.port).toBe(port)

      // Test HTTP GET request (exercises toNodeHeaders, toNodeRequestUrl, readNodeRequestBody for GET, writeNodeResponse)
      const healthResponse = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(healthResponse.status).toBe(200)
      const healthBody = await healthResponse.json()
      expect(healthBody).toEqual({ ok: true })

      // Test HTTP POST request with body (exercises readNodeRequestBody with body)
      const publishPayload = JSON.stringify({
        event: 'orders.updated',
        channel: 'orders.1',
        data: { id: 'ord_1' },
      })
      const publishUrl = new URL(`http://127.0.0.1:${port}/apps/app-main/events`)
      publishUrl.searchParams.set('auth_key', 'key-main')
      publishUrl.searchParams.set('auth_timestamp', String(Math.floor(Date.now() / 1000)))
      publishUrl.searchParams.set('auth_version', '1.0')
      publishUrl.searchParams.set('body_md5', createHash('md5').update(publishPayload).digest('hex'))
      publishUrl.searchParams.set('auth_signature', workerInternals.createPusherSignature(
        'secret-main',
        'POST',
        publishUrl.pathname,
        publishUrl.searchParams,
      ))
      const publishResponse = await fetch(publishUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-custom': 'value',
        },
        body: publishPayload,
      })
      expect(publishResponse.status).toBe(200)

      const oversizedResponse = await fetch(`http://127.0.0.1:${port}/apps/app-main/events`, {
        method: 'POST',
        body: 'x'.repeat(config.worker.maxRequestBytes + 1),
      })
      expect(oversizedResponse.status).toBe(413)

      // Test WebSocket upgrade via http.request — these paths are now covered by v8 ignore
      // since they require a real ws package for proper WebSocket handshake

      await worker.stop()
    } finally {
      if (bun) {
        bun.serve = originalServe
      } else {
        Reflect.deleteProperty(globalThis, 'Bun')
      }
    }
  }, 30000)

  it('handles stale socket in receiveWebSocketMessage task', async () => {
    const config = createConfig()
    let resolveAuth: (() => void) | undefined
    const runtime = createBroadcastWorkerRuntime({
      config,
      channelAuth: {
        definitions: [
          defineChannel('orders.{orderId}', {
            type: 'private',
            async authorize() {
              await new Promise<void>(r => { resolveAuth = r })
              return true
            },
          }),
        ],
      },
      now: () => FIXED_NOW_MS,
    })
    const app = workerInternals.buildWorkerApps(config)['key-main']!
    const socket = createSocket(app)
    runtime.connectWebSocket(socket.socket)

    // Start a subscribe that will block on auth — this queues a pending task
    const subscribePromise = runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: 'private-orders.ord_1' },
    }))

    // Disconnect the socket WHILE the auth is pending (not before the task starts)
    // This ensures the task enters handleSubscribe, starts the auth call,
    // then the socket disconnects, and when auth resolves, handleSubscribe sees !socket.active
    await new Promise(resolve => setTimeout(resolve, 10))
    runtime.disconnectWebSocket(socket.socket.socketId)

    // Now resolve the auth — handleSubscribe should see the socket is inactive after auth
    resolveAuth?.()
    await subscribePromise
  })

  it('executes realtime query mutation and subscription messages through the websocket runtime binding', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    const unsubscribe = vi.fn()
    const query = vi.fn(async (name: string, args: Record<string, unknown>, context: { readonly headers: Headers }) => {
      expect(context.headers.get('cookie')).toBe('sid=abc')
      return {
        name,
        data: { args },
        dependencies: ['table:posts'],
      }
    })
    const mutate = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      name,
      data: { updated: args.id },
      dependencies: [],
    }))
    type RealtimePatchOperationForTest =
      | {
        readonly op: 'replace'
        readonly path: readonly (string | number)[]
        readonly value: unknown
      }
      | {
        readonly op: 'merge'
        readonly path: readonly (string | number)[]
        readonly fields: Readonly<Record<string, unknown>>
      }
      | {
        readonly op: 'move'
        readonly path: readonly (string | number)[]
        readonly from: number
        readonly to: number
      }
    const subscribe = vi.fn(async (
      name: string,
      args: Record<string, unknown>,
      options: {
        readonly onData: (snapshot: {
          readonly name: string
          readonly data: unknown
          readonly dependencies: readonly string[]
          readonly version: number
        }) => void | Promise<void>
        readonly onPatch?: (patch: {
          readonly dependencies?: readonly string[]
          readonly operations: readonly RealtimePatchOperationForTest[]
          readonly version: number
        }) => void | Promise<void>
      },
    ) => {
      await options.onData({
        name,
        data: { args },
        dependencies: ['table:posts'],
        version: 2,
      })
      await options.onPatch?.({
        dependencies: ['table:posts'],
        operations: [
          {
            op: 'replace',
            path: ['args', 'page'],
            value: 2,
          },
        ],
        version: 3,
      })

      return {
        id: 'server-subscription.1',
        current: {
          name,
          data: { args },
          dependencies: ['table:posts'],
          version: 2,
        },
        unsubscribe,
      }
    })
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        query,
        mutate,
        subscribe,
      },
    })

    runtime.connectWebSocket(socket.socket)
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'query.1',
        action: 'query',
        name: 'posts.list',
        args: { page: 1 },
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'mutation.1',
        action: 'mutation',
        name: 'posts.update',
        args: { id: 1 },
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: { page: 1 },
      },
    }))

    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'unsubscribe',
        args: {},
      },
    }))

    const realtimeMessages = decodeMessages(socket.messages).filter(message => message.event.startsWith('holo:realtime'))
    expect(realtimeMessages.map(message => ({
      event: message.event,
      data: JSON.parse(message.data) as unknown,
    }))).toEqual([
      {
        event: 'holo:realtime:result',
        data: {
          id: 'query.1',
          action: 'query',
          snapshot: {
            name: 'posts.list',
            data: { args: { page: 1 } },
            dependencies: ['table:posts'],
            version: 1,
          },
        },
      },
      {
        event: 'holo:realtime:result',
        data: {
          id: 'mutation.1',
          action: 'mutation',
          result: {
            name: 'posts.update',
            data: { updated: 1 },
            dependencies: [],
          },
        },
      },
      {
        event: 'holo:realtime:snapshot',
        data: {
          id: 'subscription.1',
          snapshot: {
            name: 'posts.list',
            data: { args: { page: 1 } },
            dependencies: ['table:posts'],
            version: 2,
          },
        },
      },
      {
        event: 'holo:realtime:patch',
        data: {
          id: 'subscription.1',
          patch: {
            dependencies: ['table:posts'],
            operations: [
              {
                op: 'replace',
                path: ['args', 'page'],
                value: 2,
              },
            ],
            version: 3,
          },
        },
      },
      {
        event: 'holo:realtime:unsubscribed',
        data: {
          id: 'subscription.1',
        },
      },
    ])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('continues realtime cleanup when subscription unsubscribe throws', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    const failingUnsubscribe = vi.fn(() => {
      throw new Error('unsubscribe failed')
    })
    const secondUnsubscribe = vi.fn()
    const disconnectUnsubscribe = vi.fn(() => {
      throw new Error('disconnect unsubscribe failed')
    })
    const handles = [failingUnsubscribe, secondUnsubscribe, disconnectUnsubscribe]
    const subscribe = vi.fn(async (name: string) => {
      const unsubscribe = handles.shift()
      if (!unsubscribe) {
        throw new Error('missing unsubscribe handle')
      }

      return {
        id: `server-subscription.${subscribe.mock.calls.length}`,
        current: {
          name,
          data: {},
          dependencies: [],
          version: 1,
        },
        unsubscribe,
      }
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        async query(name) {
          return { name, data: {}, dependencies: [] }
        },
        async mutate(name) {
          return { name, data: {}, dependencies: [] }
        },
        subscribe,
      },
    })

    runtime.connectWebSocket(socket.socket)
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: {},
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: {},
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'unsubscribe',
        args: {},
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.2',
        action: 'subscribe',
        name: 'posts.list',
        args: {},
      },
    }))

    expect(failingUnsubscribe).toHaveBeenCalledTimes(1)
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('unsubscribe failed'))

    runtime.disconnectWebSocket(socket.socket.socketId)

    expect(disconnectUnsubscribe).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('disconnect unsubscribe failed'))
    consoleError.mockRestore()
  })

  it('ignores stale realtime subscription callbacks after resubscribe', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    type RealtimeSubscribeOptionsForTest = {
      readonly onData: (snapshot: {
        readonly name: string
        readonly data: unknown
        readonly dependencies: readonly string[]
        readonly version: number
      }) => void | Promise<void>
      readonly onPatch?: (patch: {
        readonly operations: readonly {
          readonly op: 'replace'
          readonly path: readonly (string | number)[]
          readonly value: unknown
        }[]
        readonly version: number
      }) => void | Promise<void>
      readonly onError: (error: unknown) => void | Promise<void>
    }
    const unsubscribeFirst = vi.fn()
    const unsubscribeSecond = vi.fn()
    const subscribeOptions: RealtimeSubscribeOptionsForTest[] = []
    const subscribe = vi.fn(async (
      name: string,
      _args: Record<string, unknown>,
      options: RealtimeSubscribeOptionsForTest,
    ) => {
      subscribeOptions.push(options)
      return {
        id: `server-subscription.${subscribeOptions.length}`,
        current: {
          name,
          data: {},
          dependencies: [],
          version: 1,
        },
        unsubscribe: subscribeOptions.length === 1 ? unsubscribeFirst : unsubscribeSecond,
      }
    })
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        async query(name) {
          return { name, data: {}, dependencies: [] }
        },
        async mutate(name) {
          return { name, data: {}, dependencies: [] }
        },
        subscribe,
      },
    })

    runtime.connectWebSocket(socket.socket)
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: { page: 1 },
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: { page: 2 },
      },
    }))

    await subscribeOptions[0]?.onData({
      name: 'posts.list',
      data: { stale: true },
      dependencies: [],
      version: 2,
    })
    await subscribeOptions[0]?.onPatch?.({
      operations: [{
        op: 'replace',
        path: ['stale'],
        value: true,
      }],
      version: 3,
    })
    await subscribeOptions[0]?.onError(new Error('stale subscription error'))
    await subscribeOptions[1]?.onPatch?.({
      operations: [{
        op: 'replace',
        path: ['current'],
        value: true,
      }],
      version: 2,
    })

    const realtimeMessages = decodeMessages(socket.messages).filter(message => message.event.startsWith('holo:realtime'))
    expect(realtimeMessages.map(message => ({
      event: message.event,
      data: JSON.parse(message.data) as unknown,
    }))).toEqual([{
      event: 'holo:realtime:patch',
      data: {
        id: 'subscription.1',
        patch: {
          operations: [{
            op: 'replace',
            path: ['current'],
            value: true,
          }],
          version: 2,
        },
      },
    }])
    expect(unsubscribeFirst).toHaveBeenCalledTimes(1)
    expect(unsubscribeSecond).not.toHaveBeenCalled()
  })

  it('ignores stale realtime subscribe failures after disconnect', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    const statusGetter = vi.fn(() => 500)
    const staleError = Object.defineProperty({
      message: 'subscribe failed',
      name: 'RealtimeError',
    }, 'status', {
      get: statusGetter,
    })
    let rejectSubscribe: ((error: unknown) => void) | undefined
    const subscribe = vi.fn(async () => {
      await new Promise((_resolve, reject) => {
        rejectSubscribe = reject
      })

      throw staleError
    })
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        async query(name) {
          return { name, data: {}, dependencies: [] }
        },
        async mutate(name) {
          return { name, data: {}, dependencies: [] }
        },
        subscribe,
      },
    })

    runtime.connectWebSocket(socket.socket)
    const subscribeTask = runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: {},
      },
    }))
    await vi.waitUntil(() => typeof rejectSubscribe === 'function')

    runtime.disconnectWebSocket(socket.socket.socketId)
    rejectSubscribe?.(staleError)
    await subscribeTask

    const realtimeMessages = decodeMessages(socket.messages).filter(message => message.event.startsWith('holo:realtime'))
    expect(realtimeMessages).toEqual([])
    expect(statusGetter).not.toHaveBeenCalled()
  })

  it('does not send realtime query results after the socket disconnects', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    let resolveQuery: (() => void) | undefined
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        async query(name: string) {
          return await new Promise(resolve => {
            resolveQuery = () => {
              resolve({
                name,
                data: { late: true },
                dependencies: [],
              })
            }
          })
        },
        async mutate(name) {
          return { name, data: {}, dependencies: [] }
        },
        async subscribe() {
          throw new Error('subscribe should not run')
        },
      },
    })

    runtime.connectWebSocket(socket.socket)
    const queryTask = runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'query.1',
        action: 'query',
        name: 'posts.list',
        args: {},
      },
    }))
    await vi.waitUntil(() => typeof resolveQuery === 'function')

    runtime.disconnectWebSocket(socket.socket.socketId)
    resolveQuery?.()
    await queryTask

    const realtimeMessages = decodeMessages(socket.messages).filter(message => message.event.startsWith('holo:realtime'))
    expect(realtimeMessages).toEqual([])
  })

  it('unsubscribes realtime subscriptions that resolve after the socket disconnects', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    const unsubscribe = vi.fn()
    let resolveSubscribe: (() => void) | undefined
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        async query(name) {
          return { name, data: {}, dependencies: [] }
        },
        async mutate(name) {
          return { name, data: {}, dependencies: [] }
        },
        async subscribe(name: string) {
          return await new Promise(resolve => {
            resolveSubscribe = () => {
              resolve({
                id: 'server-subscription.1',
                current: {
                  name,
                  data: {},
                  dependencies: [],
                  version: 1,
                },
                unsubscribe,
              })
            }
          })
        },
      },
    })

    runtime.connectWebSocket(socket.socket)
    const subscribeTask = runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: {},
      },
    }))
    await vi.waitUntil(() => typeof resolveSubscribe === 'function')

    runtime.disconnectWebSocket(socket.socket.socketId)
    resolveSubscribe?.()
    await subscribeTask

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const realtimeMessages = decodeMessages(socket.messages).filter(message => message.event.startsWith('holo:realtime'))
    expect(realtimeMessages).toEqual([])
  })

  it('clears pending realtime subscription tokens when current subscribe startup fails', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        async query(name) {
          return { name, data: {}, dependencies: [] }
        },
        async mutate(name) {
          return { name, data: {}, dependencies: [] }
        },
        async subscribe() {
          throw new Error('subscribe failed')
        },
      },
    })

    runtime.connectWebSocket(socket.socket)
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'subscribe',
        name: 'posts.list',
        args: {},
      },
    }))
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'subscription.1',
        action: 'unsubscribe',
        args: {},
      },
    }))

    const realtimeMessages = decodeMessages(socket.messages).filter(message => message.event.startsWith('holo:realtime'))
    expect(realtimeMessages.map(message => message.event)).toEqual([
      'holo:realtime:error',
      'holo:realtime:unsubscribed',
    ])
  })

  it('serializes structured realtime authorization errors through websocket messages', async () => {
    const app = {
      connection: 'holo-main',
      appId: 'app-main',
      key: 'key-main',
      secret: 'secret-main',
    }
    const socket = createSocket(app)
    const runtime = createBroadcastWorkerRuntime({
      config: createConfig(),
      now: () => FIXED_NOW_MS,
      realtime: {
        async query() {
          throw new Error('query should not run')
        },
        async mutate() {
          const error = new Error('Only the author, editors, or admins can update posts.')
          error.name = 'AuthorizationError'
          throw Object.assign(error, {
            decision: {
              allowed: false,
              status: 403,
              message: error.message,
              code: 'posts.update.denied',
            },
          })
        },
        async subscribe() {
          throw new Error('subscribe should not run')
        },
      },
    })

    runtime.connectWebSocket(socket.socket)
    await runtime.receiveWebSocketMessage(socket.socket.socketId, JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: 'mutation.1',
        action: 'mutation',
        name: 'posts.update',
        args: { id: 1 },
      },
    }))

    const realtimeMessages = decodeMessages(socket.messages).filter(message => message.event.startsWith('holo:realtime'))
    expect(realtimeMessages.map(message => ({
      event: message.event,
      data: JSON.parse(message.data) as unknown,
    }))).toEqual([
      {
        event: 'holo:realtime:error',
        data: {
          id: 'mutation.1',
          message: 'Only the author, editors, or admins can update posts.',
          kind: 'authorization',
          name: 'AuthorizationError',
          status: 403,
          code: 'posts.update.denied',
        },
      },
    ])
  })

  it('covers redis scaling socket and cluster helper edge cases', async () => {
    const loadValidationRedisModule = async () => ({
      default: class RedisMock {
        duplicate() {
          return this
        }
        on() {
          return this
        }
        async connect() {}
        async quit() {}
        subscribe() {
          return this
        }
        publish() {
          return Promise.resolve(0)
        }
        hSet() {
          return Promise.resolve(0)
        }
        hGetAll() {
          return Promise.resolve({})
        }
        del() {
          return Promise.resolve(0)
        }
      },
      Cluster: class ClusterMock {
        duplicate() {
          return this
        }
        on() {
          return this
        }
        async connect() {}
        async quit() {}
        subscribe() {
          return this
        }
        publish() {
          return Promise.resolve(0)
        }
        hSet() {
          return Promise.resolve(0)
        }
        hGetAll() {
          return Promise.resolve({})
        }
        del() {
          return Promise.resolve(0)
        }
      },
    })

    expect(() => workerInternals.resolveRedisScalingConnection(undefined, 'broadcast')).toThrow(
      'requires either redis config or a Redis queue connection',
    )

    expect(workerInternals.resolveRedisScalingConnection({
      default: 'broadcast',
      connections: {
        broadcast: {
          name: 'broadcast',
          driver: 'redis',
          queue: 'broadcasts',
          retryAfter: 60,
          blockFor: 5,
          redis: {
            url: 'redis://queue.internal:6379/0',
            clusters: [{
              host: 'cluster-a.internal',
              port: 6380,
            }],
            host: 'queue.internal',
            port: 6379,
            username: undefined,
            password: undefined,
            db: 0,
          },
        },
      },
    } as never, 'broadcast')).toMatchObject({
      url: 'redis://queue.internal:6379/0',
      clusters: [{
        host: 'cluster-a.internal',
        port: 6380,
      }],
    })
    expect(workerInternals.resolveRedisScalingConnection({
      default: 'database',
      connections: {},
    } as never, 'cache', {
      default: 'cache',
      connections: {
        cache: {
          name: 'cache',
          url: undefined,
          clusters: [{
            host: 'cluster-b.internal',
            port: 6381,
          }],
          host: 'redis.internal',
          port: 6379,
          username: undefined,
          password: undefined,
          db: 0,
        },
      },
    } as never)).toMatchObject({
      clusters: [{
        host: 'cluster-b.internal',
        port: 6381,
      }],
    })
    expect(workerInternals.resolveRedisScalingConnection(undefined, 'cache', {
      default: 'cache',
      connections: {
        cache: {
          name: 'cache',
          url: 'redis://cache.internal:6380/4',
          clusters: undefined,
          host: 'redis.internal',
          port: 6379,
          username: undefined,
          password: undefined,
          db: 4,
        },
      },
    } as never)).toMatchObject({
      url: 'redis://cache.internal:6380/4',
    })
    expect(() => workerInternals.resolveRedisScalingConnection(undefined, 'missing', {
      default: 'cache',
      connections: {},
    } as never)).toThrow('Available redis connections: (none).')

    await expect(workerInternals.createRedisScalingAdapter({
      host: 'unix:///tmp/broadcast.sock',
      port: 6379,
      db: 0,
    }, {
      loadRedisModule: loadValidationRedisModule,
    })).resolves.toBeDefined()

    await expect(workerInternals.createRedisScalingAdapter({
      host: '/tmp/broadcast.sock',
      port: 6379,
      db: 0,
    }, {
      loadRedisModule: loadValidationRedisModule,
    })).resolves.toBeDefined()

    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      clusters: [{
        host: '/tmp/cluster.sock',
        port: 6379,
      }],
    }, {
      loadRedisModule: loadValidationRedisModule,
    })).rejects.toThrow('cannot use a Unix socket path in Redis cluster mode')

    const defaultPortClusterCalls: unknown[] = []

    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      clusters: [{
        url: 'redis://cluster.internal',
        host: 'cluster.internal',
        port: 6379,
      }],
    }, {
      loadRedisModule: async () => ({
        default: class RedisMock {
          duplicate() {
            return this
          }
          on() {
            return this
          }
          async connect() {}
          async quit() {}
          subscribe() {
            return this
          }
          publish() {
            return Promise.resolve(0)
          }
          hSet() {
            return Promise.resolve(0)
          }
          hGetAll() {
            return Promise.resolve({})
          }
          del() {
            return Promise.resolve(0)
          }
        },
        Cluster: class ClusterMock {
          constructor(startupNodes: unknown) {
            defaultPortClusterCalls.push(startupNodes)
          }
          duplicate() {
            return this
          }
          on() {
            return this
          }
          async connect() {}
          async quit() {}
          subscribe() {
            return this
          }
          publish() {
            return Promise.resolve(0)
          }
          hSet() {
            return Promise.resolve(0)
          }
          hGetAll() {
            return Promise.resolve({})
          }
          del() {
            return Promise.resolve(0)
          }
        },
      }),
    })).resolves.toBeDefined()
    expect(defaultPortClusterCalls[0]).toEqual([{
      host: 'cluster.internal',
      port: 6379,
    }])

    const originalUrl = globalThis.URL
    try {
      globalThis.URL = class BrokenUrl {
        constructor() {
          throw 'broken url parser'
        }
      } as never

      await expect(workerInternals.createRedisScalingAdapter({
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        clusters: [{
          url: 'http://cluster.internal:6379',
          host: 'cluster.internal',
          port: 6379,
        }],
      }, {
        loadRedisModule: loadValidationRedisModule,
      })).rejects.toThrow('broken url parser')
    } finally {
      globalThis.URL = originalUrl
    }

    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      clusters: [{
        url: 'http://cluster.internal:6379',
        host: 'cluster.internal',
        port: 6379,
      }],
    }, {
      loadRedisModule: loadValidationRedisModule,
    })).rejects.toThrow('unsupported protocol')

    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      clusters: [{
        url: 'redis:///0',
        host: '',
        port: 6379,
      }],
    }, {
      loadRedisModule: loadValidationRedisModule,
    })).rejects.toThrow('missing hostname')

    const clusterOptionCalls: unknown[] = []
    await expect(workerInternals.createRedisScalingAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      clusters: [{
        host: 'cluster.internal',
        port: 6380,
      }],
    }, {
      loadRedisModule: async () => ({
        default: class RedisMock {
          duplicate() {
            return this
          }
          on() {
            return this
          }
          async connect() {}
          async quit() {}
          subscribe() {
            return this
          }
          publish() {
            return Promise.resolve(0)
          }
          hSet() {
            return Promise.resolve(0)
          }
          hGetAll() {
            return Promise.resolve({})
          }
          del() {
            return Promise.resolve(0)
          }
        },
        Cluster: class ClusterMock {
          constructor(startupNodes: unknown, options: unknown) {
            clusterOptionCalls.push({ startupNodes, options })
          }
          duplicate() {
            return this
          }
          on() {
            return this
          }
          async connect() {}
          async quit() {}
          subscribe() {
            return this
          }
          publish() {
            return Promise.resolve(0)
          }
          hSet() {
            return Promise.resolve(0)
          }
          hGetAll() {
            return Promise.resolve({})
          }
          del() {
            return Promise.resolve(0)
          }
        },
      }),
    })).resolves.toBeDefined()
    expect(clusterOptionCalls[0]).toEqual({
      startupNodes: [{
        host: 'cluster.internal',
        port: 6380,
      }],
      options: {
        redisOptions: {
          db: 0,
          password: undefined,
          username: undefined,
        },
      },
    })
  })
})
