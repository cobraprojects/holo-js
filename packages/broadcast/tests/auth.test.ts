import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineSchema, field } from '@holo-js/validation'
import {
  authorizeBroadcastChannel,
  broadcastAuthInternals,
  configureBroadcastRuntime,
  defineChannel,
  parseBroadcastAuthEndpointPayload,
  renderBroadcastAuthResponse,
  resolveBroadcastWhisperSchema,
  resetBroadcastRuntime,
  validateBroadcastWhisperPayload,
} from '../src'

const whisperSchema = defineSchema({
  editing: field.boolean().required(),
})

afterEach(() => {
  resetBroadcastRuntime()
  broadcastAuthInternals.reset()
  vi.restoreAllMocks()
})

describe('@holo-js/broadcast channel auth runtime', () => {
  it('authorizes private and presence channels with wildcard params and whisper metadata', async () => {
    configureBroadcastRuntime({
      channelAuth: {
        definitions: [
          defineChannel('orders.{orderId}', {
            type: 'private',
            authorize(user, params) {
              return String((user as { id: string }).id) === params.orderId
            },
            whispers: {
              'typing.start': whisperSchema,
            },
          }),
          defineChannel('chat.{roomId}', {
            type: 'presence',
            authorize(user, params) {
              if (!Array.isArray((user as { rooms?: readonly string[] }).rooms)) {
                return false
              }

              if (!(user as { rooms: readonly string[] }).rooms.includes(params.roomId)) {
                return false
              }

              return {
                id: String((user as { id: string }).id),
                roomId: params.roomId,
              }
            },
          }),
        ],
      },
    })

    await expect(authorizeBroadcastChannel({
      channel: 'orders.ord_1',
      user: {
        id: 'ord_1',
      },
    })).resolves.toEqual({
      ok: true,
      channel: 'orders.ord_1',
      type: 'private',
      pattern: 'orders.{orderId}',
      params: {
        orderId: 'ord_1',
      },
      whispers: ['typing.start'],
    })

    await expect(authorizeBroadcastChannel({
      channel: 'orders.ord_1',
      user: {
        id: 'someone-else',
      },
    })).resolves.toEqual({
      ok: false,
      channel: 'orders.ord_1',
      code: 'unauthorized',
    })

    await expect(authorizeBroadcastChannel({
      channel: 'chat.room_9',
      user: {
        id: 'user_1',
        rooms: ['room_9'],
      },
    })).resolves.toEqual({
      ok: true,
      channel: 'chat.room_9',
      type: 'presence',
      pattern: 'chat.{roomId}',
      params: {
        roomId: 'room_9',
      },
      whispers: [],
      member: {
        id: 'user_1',
        roomId: 'room_9',
      },
    })

    await expect(authorizeBroadcastChannel({
      channel: 'presence-chat.room_9',
      user: {
        id: 'user_1',
        rooms: ['room_9'],
      },
    })).resolves.toEqual({
      ok: true,
      channel: 'presence-chat.room_9',
      type: 'presence',
      pattern: 'chat.{roomId}',
      params: {
        roomId: 'room_9',
      },
      whispers: [],
      member: {
        id: 'user_1',
        roomId: 'room_9',
      },
    })

    await expect(authorizeBroadcastChannel({
      channel: 'missing.channel',
      user: {
        id: 'user_1',
      },
    })).resolves.toEqual({
      ok: false,
      channel: 'missing.channel',
      code: 'not-found',
    })
  })

  it('loads channel definitions from generated registry entries and validates whispers', async () => {
    const importModule = vi.fn(async (absolutePath: string) => {
      if (basename(absolutePath) === 'orders-channel.ts') {
        return {
          default: defineChannel('orders.{orderId}', {
            type: 'private',
            authorize(_user, params) {
              return params.orderId === 'ord_2'
            },
            whispers: {
              'typing.start': whisperSchema,
            },
          }),
        }
      }

      if (basename(absolutePath) === 'chat-channel.ts') {
        return {
          named: defineChannel('chat.{roomId}', {
            type: 'presence',
            authorize() {
              return {
                id: 'user_2',
              }
            },
          }),
        }
      }

      return {}
    })

    configureBroadcastRuntime({
      channelAuth: {
        registry: {
          projectRoot: '/virtual/project',
          channels: [
            {
              sourcePath: 'server/channels/orders-channel.ts',
              pattern: 'orders.{orderId}',
              type: 'private',
              params: ['orderId'],
              whispers: ['typing.start'],
            },
            {
              sourcePath: 'server/channels/chat-channel.ts',
              pattern: 'chat.{roomId}',
              exportName: 'named',
              type: 'presence',
              params: ['roomId'],
              whispers: [],
            },
          ],
        },
        importModule,
      },
    })

    const resolvedSchema = await resolveBroadcastWhisperSchema('orders.ord_2', 'typing.start')
    expect(resolvedSchema?.event).toBe('typing.start')
    await expect(validateBroadcastWhisperPayload('orders.ord_2', 'typing.start', {
      editing: true,
    })).resolves.toEqual({
      channel: 'orders.ord_2',
      event: 'typing.start',
      payload: {
        editing: true,
      },
    })
    await expect(validateBroadcastWhisperPayload('orders.ord_2', 'typing.start', {
      editing: 'nope' as never,
    })).rejects.toThrow('Expected boolean')
    await expect(validateBroadcastWhisperPayload('chat.room_1', 'typing.start', {
      editing: true,
    })).rejects.toThrow('not allowed')

    const authorized = await authorizeBroadcastChannel({
      channel: 'orders.ord_2',
      user: {
        id: 'user_2',
      },
    })

    expect(authorized).toMatchObject({
      ok: true,
      channel: 'orders.ord_2',
    })
    expect(importModule).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate channel patterns instead of silently overwriting them', async () => {
    configureBroadcastRuntime({
      channelAuth: {
        definitions: {
          first: defineChannel('orders.{orderId}', {
            type: 'private',
            authorize() {
              return true
            },
          }),
          second: defineChannel('orders.{orderId}', {
            type: 'private',
            authorize() {
              return false
            },
          }),
        },
      },
    })

    await expect(authorizeBroadcastChannel({
      channel: 'orders.ord_1',
      user: {
        id: 'user_1',
      },
    })).rejects.toThrow('duplicate broadcast channel pattern')
  })

  it('prefers exact literal channel definitions over wildcard matches and rejects registry overlaps', async () => {
    configureBroadcastRuntime({
      channelAuth: {
        definitions: [
          defineChannel('orders.{orderId}', {
            type: 'private',
            authorize() {
              return false
            },
          }),
          defineChannel('orders.admin', {
            type: 'private',
            authorize() {
              return true
            },
          }),
        ],
      },
    })

    await expect(authorizeBroadcastChannel({
      channel: 'orders.admin',
      user: {
        id: 'user_1',
      },
    })).resolves.toMatchObject({
      ok: true,
      pattern: 'orders.admin',
      params: {},
    })

    await expect(broadcastAuthInternals.loadChannelDefinitions({
      definitions: [
        defineChannel('orders.admin', {
          type: 'private',
          authorize() {
            return true
          },
        }),
      ],
      registry: {
        projectRoot: '/virtual/project',
        channels: [{
          sourcePath: 'server/channels/orders-admin.ts',
          pattern: 'orders.admin',
          type: 'private',
          params: [],
          whispers: [],
        }],
      },
      importModule: vi.fn(async () => ({
        default: defineChannel('orders.admin', {
          type: 'private',
          authorize() {
            return true
          },
        }),
      })),
    })).rejects.toThrow('duplicate broadcast channel pattern')
  })

  it('renders framework-agnostic broadcast auth responses for endpoint handlers', async () => {
    configureBroadcastRuntime({
      channelAuth: {
        definitions: [
          defineChannel('orders.{orderId}', {
            type: 'private',
            authorize(user, params) {
              return (user as { id: string }).id === params.orderId
            },
            whispers: {
              'typing.start': whisperSchema,
            },
          }),
        ],
      },
    })

    const nextStyleHandler = async (request: Request) => {
      return await renderBroadcastAuthResponse(request, {
        resolveUser() {
          return {
            id: 'ord_5',
          }
        },
      })
    }
    const nextResponse = await nextStyleHandler(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel_name: 'orders.ord_5',
        socket_id: '123.456',
      }),
    }))
    expect(nextResponse.status).toBe(200)
    await expect(nextResponse.json()).resolves.toEqual({
      ok: true,
      channel: 'orders.ord_5',
      type: 'private',
      params: {
        orderId: 'ord_5',
      },
      whispers: ['typing.start'],
    })

    const prefixedPrivateResponse = await nextStyleHandler(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel_name: 'private-orders.ord_5',
        socket_id: '123.456',
      }),
    }))
    expect(prefixedPrivateResponse.status).toBe(200)
    await expect(prefixedPrivateResponse.json()).resolves.toEqual({
      ok: true,
      channel: 'private-orders.ord_5',
      type: 'private',
      params: {
        orderId: 'ord_5',
      },
      whispers: ['typing.start'],
    })

    const nuxtStyleHandler = async (request: Request) => {
      return await renderBroadcastAuthResponse(request, {
        user: undefined,
      })
    }
    const nuxtResponse = await nuxtStyleHandler(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel_name: 'orders.ord_5',
      }),
    }))
    expect(nuxtResponse.status).toBe(401)
    await expect(nuxtResponse.json()).resolves.toEqual({
      ok: false,
      error: 'unauthenticated',
      message: 'Broadcast channel authorization requires an authenticated user.',
    })

    const denied = await renderBroadcastAuthResponse(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel_name: 'orders.ord_99',
      }),
    }), {
      user: {
        id: 'ord_5',
      },
    })
    expect(denied.status).toBe(403)

    const missing = await renderBroadcastAuthResponse(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel_name: 'users.1',
      }),
    }), {
      user: {
        id: 'ord_5',
      },
    })
    expect(missing.status).toBe(404)

    const invalid = await renderBroadcastAuthResponse(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel_name: ' ',
      }),
    }), {
      user: {
        id: 'ord_5',
      },
    })
    expect(invalid.status).toBe(400)

    const methodNotAllowed = await renderBroadcastAuthResponse(new Request('http://localhost/broadcasting/auth', {
      method: 'GET',
    }), {
      user: {
        id: 'ord_5',
      },
    })
    expect(methodNotAllowed.status).toBe(405)

    await expect(parseBroadcastAuthEndpointPayload(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel: 'orders.ord_5',
        socketId: '123.456',
      }),
    }))).resolves.toEqual({
      channel: 'orders.ord_5',
      socketId: '123.456',
    })
    await expect(parseBroadcastAuthEndpointPayload(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel_name: 'orders.ord_5',
        socket_id: 999,
      }),
    }))).resolves.toEqual({
      channel: 'orders.ord_5',
    })
    await expect(parseBroadcastAuthEndpointPayload(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel: 123,
      }),
    }))).rejects.toThrow('Broadcast auth channel must be a non-empty string')

    await expect(parseBroadcastAuthEndpointPayload(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel: 'orders.ord_5',
        socketId: '654.321',
      }),
    }))).resolves.toEqual({
      channel: 'orders.ord_5',
      socketId: '654.321',
    })
    await expect(parseBroadcastAuthEndpointPayload(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel: 'orders.ord_5',
      }),
    }))).resolves.toEqual({
      channel: 'orders.ord_5',
    })
    const nonStringForm = new FormData()
    nonStringForm.set('channel_name', new Blob(['orders.ord_5']))
    await expect(parseBroadcastAuthEndpointPayload(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: nonStringForm,
    }))).rejects.toThrow('Broadcast auth channel must be a non-empty string')
  })

  it('covers auth error branches and internals', async () => {
    await expect(authorizeBroadcastChannel({
      channel: 'orders.ord_1',
      user: {
        id: 'ord_1',
      },
    })).resolves.toEqual({
      ok: false,
      channel: 'orders.ord_1',
      code: 'not-found',
    })

    await expect(authorizeBroadcastChannel({
      channel: 'chat.room_7',
      user: {
        id: 'user_7',
      },
    }, {
      definitions: [
        defineChannel('chat.{roomId}', {
          type: 'presence',
          authorize() {
            return false as const
          },
        }),
      ],
    })).resolves.toEqual({
      ok: false,
      channel: 'chat.room_7',
      code: 'unauthorized',
    })

    await expect(authorizeBroadcastChannel({
      channel: 'chat.room_7',
      user: {
        id: 'user_7',
      },
    }, {
      definitions: [
        defineChannel('chat.{roomId}', {
          type: 'presence',
          authorize() {
            return true as never
          },
        }),
      ],
    })).rejects.toThrow('serializable member object')
    await expect(authorizeBroadcastChannel({
      channel: 'chat.room_7',
      user: {
        id: 'user_7',
      },
    }, {
      definitions: {
        chat: defineChannel('chat.{roomId}', {
          type: 'presence',
          authorize() {
            return {
              id: 'user_7',
              rooms: ['room_7'],
            }
          },
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      channel: 'chat.room_7',
      member: {
        id: 'user_7',
        rooms: ['room_7'],
      },
    })
    await expect(authorizeBroadcastChannel({
      channel: 'chat.room_7',
      user: {
        id: 'user_7',
      },
    }, {
      definitions: [
        defineChannel('chat.{roomId}', {
          type: 'presence',
          authorize() {
            return {
              id: 'user_7',
              meta: new Date(),
            } as never
          },
        }),
      ],
    })).rejects.toThrow('JSON-serializable')

    await expect(resolveBroadcastWhisperSchema('missing.1', 'typing.start', {
      definitions: [
        defineChannel('orders.{orderId}', {
          type: 'private',
          authorize() {
            return true
          },
          whispers: {
            'typing.start': whisperSchema,
          },
        }),
      ],
    })).resolves.toBeNull()

    await expect(parseBroadcastAuthEndpointPayload(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel_name: 'orders.ord_1',
        socket_id: '   ',
      }),
    }))).rejects.toThrow('socket id must be a non-empty string')

    await expect(renderBroadcastAuthResponse(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel_name: 'orders.ord_1',
      }),
    }), {
      resolveUser() {
        throw new Error('user resolver exploded')
      },
    })).rejects.toThrow('user resolver exploded')

    await expect(broadcastAuthInternals.importChannelDefinition({
      sourcePath: 'server/channels/orders.ts',
      pattern: 'orders.{orderId}',
      type: 'private',
      params: ['orderId'],
      whispers: [],
    }, {
      importModule: vi.fn(async () => ({
        default: defineChannel('orders.{orderId}', {
          type: 'private',
          authorize() {
            return true
          },
        }),
      })),
    })).rejects.toThrow('registry bindings are missing')

    await expect(broadcastAuthInternals.importChannelDefinition({
      sourcePath: 'server/channels/orders.ts',
      pattern: 'orders.{orderId}',
      type: 'private',
      params: ['orderId'],
      whispers: [],
    }, {
      registry: {
        projectRoot: '/virtual/project',
        channels: [],
      },
      importModule: vi.fn(async () => 'not-a-module' as never),
    })).rejects.toThrow('must export an object module namespace')

    await expect(broadcastAuthInternals.importChannelDefinition({
      sourcePath: 'server/channels/orders.ts',
      pattern: 'orders.{orderId}',
      type: 'private',
      params: ['orderId'],
      exportName: 'named',
      whispers: [],
    }, {
      registry: {
        projectRoot: '/virtual/project',
        channels: [],
      },
      importModule: vi.fn(async () => ({
        default: defineChannel('orders.{orderId}', {
          type: 'private',
          authorize() {
            return true
          },
        }),
      })),
    })).rejects.toThrow('is not a channel definition')

    await expect(broadcastAuthInternals.loadChannelDefinitions({
      definitions: {
        broken: {} as never,
      },
    })).rejects.toThrow('is not a defineChannel')
    await expect(broadcastAuthInternals.loadChannelDefinitions({
      definitions: [{} as never],
    })).rejects.toThrow('must contain only defineChannel')

    await expect(broadcastAuthInternals.loadChannelDefinitions({
      registry: {
        projectRoot: '/virtual/project',
        channels: [{
          sourcePath: ' ',
          pattern: 'orders.{orderId}',
          type: 'private',
          params: ['orderId'],
          whispers: [],
        }],
      },
      importModule: vi.fn(async () => ({})),
    })).rejects.toThrow('source path must be a non-empty string')

    const matched = broadcastAuthInternals.resolveChannelMatchFromMap('orders.ord_5', {
      'orders.{orderId}': defineChannel('orders.{orderId}', {
        type: 'private',
        authorize() {
          return true
        },
      }),
    })
    expect(matched?.params).toEqual({
      orderId: 'ord_5',
    })
    expect(broadcastAuthInternals.resolveChannelMatchFromMap('users.1', {
      'orders.{orderId}': defineChannel('orders.{orderId}', {
        type: 'private',
        authorize() {
          return true
        },
      }),
    })).toBeNull()

    const tempRoot = await mkdtemp(join(tmpdir(), 'holo-broadcast-auth-'))
    const sourcePath = 'server/channels/orders-file.ts'
    await mkdir(join(tempRoot, 'server/channels'), { recursive: true })
    await writeFile(join(tempRoot, sourcePath), [
      'export default {}',
      '',
    ].join('\n'), 'utf8')

    await expect(broadcastAuthInternals.importChannelDefinition({
      sourcePath,
      pattern: 'orders.{orderId}',
      type: 'private',
      params: ['orderId'],
      whispers: [],
    }, {
      registry: {
        projectRoot: tempRoot,
        channels: [],
      },
    })).rejects.toThrow('is not a channel definition')

    expect(broadcastAuthInternals.matchPattern('orders.{orderId}', 'orders.ord_1.items')).toBeNull()

    configureBroadcastRuntime({
      channelAuth: {
        definitions: [
          defineChannel('chat.{roomId}', {
            type: 'presence',
            authorize() {
              return {
                id: 'user_2',
                roomId: 'room_1',
              }
            },
          }),
        ],
      },
    })
    const presenceResponse = await renderBroadcastAuthResponse(new Request('http://localhost/broadcasting/auth', {
      method: 'POST',
      body: new URLSearchParams({
        channel_name: 'chat.room_1',
      }),
    }), {
      user: {
        id: 'user_2',
      },
    })
    expect(presenceResponse.status).toBe(200)
    await expect(presenceResponse.json()).resolves.toEqual({
      ok: true,
      channel: 'chat.room_1',
      type: 'presence',
      params: {
        roomId: 'room_1',
      },
      whispers: [],
      member: {
        id: 'user_2',
        roomId: 'room_1',
      },
    })

    const unknownErrorResponse = await renderBroadcastAuthResponse({
      method: 'POST',
      headers: new Headers(),
      async formData() {
        throw 'boom'
      },
    } as never, {
      user: {
        id: 'user_7',
      },
    })
    expect(unknownErrorResponse.status).toBe(400)
    await expect(unknownErrorResponse.json()).resolves.toEqual({
      ok: false,
      error: 'invalid-request',
      message: 'Invalid broadcast auth request.',
    })
  })

  it('rejects duplicate channel patterns within registry entries', async () => {
    const importModule = vi.fn(async () => ({
      default: defineChannel('orders.{orderId}', {
        type: 'private',
        authorize() {
          return true
        },
      }),
    }))

    resetBroadcastRuntime()
    await expect(broadcastAuthInternals.loadChannelDefinitions({
      registry: {
        projectRoot: '/virtual/project',
        channels: [
          {
            sourcePath: 'server/channels/orders-a.ts',
            pattern: 'orders.{orderId}',
            type: 'private',
            params: ['orderId'],
            whispers: [],
          },
          {
            sourcePath: 'server/channels/orders-b.ts',
            pattern: 'orders.{orderId}',
            type: 'private',
            params: ['orderId'],
            whispers: [],
          },
        ],
      },
      importModule,
    })).rejects.toThrow('duplicate broadcast channel pattern "orders.{orderId}" was configured more than once (registry)')
  })
})
