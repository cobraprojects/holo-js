import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { resolveBroadcastChannelGuard } from '../src/auth'
import { defineChannel } from '../src'
import { renderBroadcastClientConfigResponse, resolveBroadcastClientConfig } from '../src/client-config'
import { normalizeBroadcastConfig } from '../src/config'
import { normalizeJsonValue, parseJsonObject } from '../src/json'
import {
  createWorkerPusherSignature,
  normalizeWorkerPublishBody,
  normalizeWorkerRequiredString,
  parseWorkerChannelKind,
  parseWorkerSocketMessage,
  verifyWorkerPusherSignature,
} from '../src/workerProtocol'
import { createBroadcastWorkerRuntime, workerInternals } from '../src/worker'
import { broadcastPluginInternals } from '../src/plugins'

function expectConfigError(config: unknown, message: string): void {
  expect(() => normalizeBroadcastConfig(config as never)).toThrow(message)
}

describe('broadcast edge coverage', () => {
  it('normalizes complete worker and connection configuration', () => {
    const config = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: {
          driver: 'holo',
          key: 'key',
          secret: 'secret',
          appId: 1,
          options: { host: 'socket.test', port: '6001', scheme: 'http', useTLS: false, cluster: 'local' },
          clientOptions: { authEndpoint: 'https://app.test/api/broadcast/auth' },
        },
        pusher: {
          driver: 'pusher', key: 'pusher-key', secret: 'pusher-secret', appId: 'pusher-app', options: { cluster: 'eu' },
        },
        custom: { driver: 'custom', extra: true },
      },
      worker: {
        host: '127.0.0.1',
        port: '6001',
        path: '/socket',
        publicHost: 'public.test',
        publicPort: '80',
        publicScheme: 'http',
        healthPath: '/ready',
        statsPath: '/metrics',
        allowedOrigins: ['*', 'https://app.test'],
        maxRequestBytes: '1000',
        maxMessageBytes: 500,
        statsEnabled: true,
        scaling: { driver: 'redis' },
      },
    })
    expect(config).toMatchObject({
      default: 'main',
      connections: {
        main: { appId: '1', options: { scheme: 'http', useTLS: false, port: 6001 } },
        pusher: { options: { host: 'api-eu.pusher.com' } },
        custom: { driver: 'custom', extra: true },
      },
      worker: {
        publicHost: 'public.test', publicPort: 80, publicScheme: 'http', statsEnabled: true,
        scaling: { driver: 'redis', connection: 'default' },
      },
    })
    expect(resolveBroadcastClientConfig(config)).toMatchObject({
      key: 'key', host: 'public.test', port: 80, path: '/socket', scheme: 'http', authEndpoint: '/api/broadcast/auth',
    })
    expect(renderBroadcastClientConfigResponse(config).headers.get('cache-control')).toBe('no-store')

    const relative = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: {
          driver: 'holo', key: 'key', secret: 'secret', appId: 'app',
          clientOptions: { authEndpoint: 'api/broadcast/auth' },
        },
      },
    })
    expect(resolveBroadcastClientConfig(relative).authEndpoint).toBe('/api/broadcast/auth')
    const rooted = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'app', clientOptions: { authEndpoint: '/api/auth' } },
      },
      worker: { publicHost: 'public.test' },
    })
    expect(resolveBroadcastClientConfig(rooted)).toMatchObject({ authEndpoint: '/api/auth', port: 443 })
    const blank = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'app', clientOptions: { authEndpoint: ' ' } },
      },
    })
    expect(resolveBroadcastClientConfig(blank).authEndpoint).toBe('')
  })

  it('rejects malformed connection and worker configuration', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ default: 'missing' }, 'is not configured'],
      [{ connections: { ' ': { driver: 'log' } } }, 'connection name'],
      [{ connections: { main: { driver: ' ' } } }, 'driver'],
      [{ connections: { main: { driver: undefined } }, default: 'main' }, 'must define a name and driver'],
      [{ connections: { main: { driver: 'ably' } }, default: 'main' }, 'not supported'],
      [{ connections: { main: { driver: 'holo' } }, default: 'main' }, 'must define a key'],
      [{ connections: { main: { driver: 'holo', key: 'key' } }, default: 'main' }, 'must define a secret'],
      [{ connections: { main: { driver: 'holo', key: 'key', secret: 'secret' } }, default: 'main' }, 'must define an appId'],
      [{ connections: { main: { driver: 'pusher' } }, default: 'main' }, 'must define a key'],
      [{ connections: { main: { driver: 'pusher', key: 'key' } }, default: 'main' }, 'must define a secret'],
      [{ connections: { main: { driver: 'pusher', key: 'key', secret: 'secret' } }, default: 'main' }, 'must define an appId'],
      [{ worker: { port: 0 } }, 'port must be a positive integer'],
      [{ worker: { publicScheme: 'ftp' } }, 'must be "http" or "https"'],
      [{ worker: { scaling: { driver: 'other' } } }, 'scaling driver'],
      [{ worker: { allowedOrigins: ['relative'] } }, 'absolute URL origin'],
      [{ worker: { allowedOrigins: ['https://app.test/path'] } }, 'must not include a path'],
      [{ worker: { maxRequestBytes: ' ' } }, 'must be an integer'],
      [{ worker: { maxMessageBytes: 0 } }, 'greater than or equal to 1'],
      [{ worker: { host: ' ' } }, 'must be a non-empty string'],
    ]
    for (const [config, message] of cases) expectConfigError(config, message)
  })

  it('rejects client config for non-Holo defaults', () => {
    expect(() => resolveBroadcastClientConfig(normalizeBroadcastConfig())).toThrow('default broadcast connection to use the "holo" driver')
  })

  it('normalizes worker protocol messages, payloads, signatures, and channels', () => {
    expect(() => normalizeWorkerRequiredString(' ', 'Value')).toThrow('non-empty')
    expect(parseWorkerSocketMessage(JSON.stringify({ event: ' client-event ', channel: ' private-room ', data: '{"ok":true}' }))).toEqual({
      event: 'client-event', channel: 'private-room', data: { ok: true },
    })
    expect(parseWorkerSocketMessage(JSON.stringify({ event: 'ping', data: null }))).toEqual({ event: 'ping', data: {} })
    expect(() => parseWorkerSocketMessage('{}')).toThrow('Websocket event')
    expect(() => normalizeWorkerPublishBody(null)).toThrow('JSON object')
    expect(() => normalizeWorkerPublishBody({ channels: ['room'] })).toThrow('event name')
    expect(() => normalizeWorkerPublishBody({ event: 'event', channels: [1] })).toThrow('channel')
    expect(() => normalizeWorkerPublishBody({ event: 'event' })).toThrow('at least one channel')
    expect(normalizeWorkerPublishBody({ event: ' event ', channel: ' room ', data: { ok: true }, socket_id: ' socket ' })).toEqual({
      name: 'event', channels: ['room'], data: '{"ok":true}', socket_id: 'socket',
    })
    expect(normalizeWorkerPublishBody({ name: 'event', channels: ['room'] }).data).toBe('{}')
    expect(parseWorkerChannelKind('private-room')).toEqual({ kind: 'private', canonical: 'room' })
    expect(parseWorkerChannelKind('presence-room')).toEqual({ kind: 'presence', canonical: 'room' })
    expect(parseWorkerChannelKind('room')).toEqual({ kind: 'public', canonical: 'room' })
    const params = new URLSearchParams({ auth_key: 'key', auth_timestamp: '1' })
    const signature = createWorkerPusherSignature('secret', 'post', '/apps/app/events', params)
    expect(verifyWorkerPusherSignature(signature, signature)).toBe(true)
    expect(verifyWorkerPusherSignature('bad', signature)).toBe(false)
    expect(verifyWorkerPusherSignature('zz', 'zz')).toBe(false)
  })

  it('normalizes JSON boundaries and missing channel guards', async () => {
    expect(() => parseJsonObject('[]', 'Payload')).toThrow('JSON object')
    expect(() => normalizeJsonValue(Number.NaN, 'payload', path => `Invalid ${path}`)).toThrow('Invalid payload')
    expect(normalizeJsonValue(Object.create(null), 'payload', path => `Invalid ${path}`)).toEqual({})
    await expect(resolveBroadcastChannelGuard({ channel: 'missing', socketId: '1.1' }, {
      definitions: {},
    })).resolves.toBeUndefined()
  })

  it('resolves plugin drivers from default, named, and direct module shapes', () => {
    const send = vi.fn(async () => ({ publishedChannels: [] }))
    expect(broadcastPluginInternals.resolveBroadcastDriver({ default: { send } }, 'plugin', 'default').send).toBe(send)
    expect(broadcastPluginInternals.resolveBroadcastDriver({ driver: { send } }, 'plugin', 'named').send).toBe(send)
    expect(broadcastPluginInternals.resolveBroadcastDriver({ send }, 'plugin', 'direct').send).toBe(send)
  })

  it('covers worker request and origin boundaries', async () => {
    expect(workerInternals.isAllowedWorkerOrigin(new Request('https://worker.test'), [])).toBe(true)
    expect(workerInternals.isAllowedWorkerOrigin(new Request('https://worker.test', {
      headers: { origin: 'not a url' },
    }), [])).toBe(false)
    expect(workerInternals.isAllowedWorkerOrigin(new Request('https://worker.test', {
      headers: { origin: 'https://app.test/path' },
    }), ['https://app.test'])).toBe(true)

    await expect(workerInternals.readLimitedRequestText(new Request('https://worker.test', {
      method: 'POST', headers: { 'content-length': '10' }, body: 'payload',
    }), 5)).rejects.toThrow()
    await expect(workerInternals.readLimitedRequestText(new Request('https://worker.test'), 5)).resolves.toBe('')
    await expect(workerInternals.readLimitedRequestText(new Request('https://worker.test', {
      method: 'POST', body: 'payload',
    }), 2)).rejects.toThrow()
  })

  it('validates realtime and signed channel messages', () => {
    expect(workerInternals.normalizeRealtimeAction('query')).toBe('query')
    expect(() => workerInternals.normalizeRealtimeAction('invalid')).toThrow('Realtime action is invalid')
    expect(workerInternals.normalizeRealtimeArgs(null)).toEqual({})
    expect(workerInternals.normalizeRealtimeArgs({ page: 1 })).toEqual({ page: 1 })
    expect(() => workerInternals.parseRealtimeSocketMessage({ id: '1', action: 'query' })).toThrow('name is required')
    expect(() => workerInternals.parseRealtimeSocketMessage({ action: 'query', name: 'posts.list' })).toThrow('request id')
    expect(workerInternals.parseRealtimeSocketMessage({ id: '1', action: 'unsubscribe' })).toEqual({
      id: '1', action: 'unsubscribe', args: {},
    })

    expect(workerInternals.parseClientChannelAuth({})).toBeUndefined()
    expect(workerInternals.parseClientChannelAuth({ auth: ' key:sig ', channel_data: '{}' })).toEqual({
      auth: 'key:sig', channelData: '{}',
    })
    expect(workerInternals.parseSignedChannelData(undefined)).toEqual({ whispers: [] })
    expect(workerInternals.parseSignedChannelData(JSON.stringify({ whispers: [' event '], member: { id: 1 } }))).toEqual({
      whispers: ['event'], member: { id: 1 },
    })
    expect(workerInternals.parseSignedChannelData('{}')).toEqual({ whispers: [] })

    const app = { key: 'key', secret: 'secret' }
    expect(() => workerInternals.verifyClientChannelAuth(app as never, '1.1', 'private-room', { auth: 'other:sig' })).toThrow('signature is invalid')
    expect(() => workerInternals.verifyClientChannelAuth(app as never, '1.1', 'private-room', { auth: 'key' })).toThrow('signature is invalid')
    expect(() => workerInternals.verifyClientChannelAuth(app as never, '1.1', 'private-room', { auth: 'key:bad' })).toThrow('signature is invalid')
    const signature = createHmac('sha256', 'secret').update('1.1:private-room').digest('hex')
    expect(workerInternals.verifyClientChannelAuth(app as never, '1.1', 'private-room', { auth: `key:${signature}` })).toEqual({ whispers: [] })
    expect(workerInternals.safeEqual('a', 'aa')).toBe(false)
    expect(workerInternals.signChannelAuth('secret', '1.1', 'private-room', '{}')).toBe(
      createHmac('sha256', 'secret').update('1.1:private-room:{}').digest('hex'),
    )
    expect(workerInternals.resolvePresenceMemberId({ name: 'Guest' }, 'socket')).toBe('socket')
  })

  it('normalizes worker log failures', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    workerInternals.logSocketMessageError('1.1', new Error('socket'))
    workerInternals.logScalingMessageError('scaling')
    workerInternals.logSocketCleanupError('1.1', 'room', new Error('cleanup'))
    workerInternals.logRealtimeSubscriptionCleanupError('1.1', 'sub', 'unsubscribe')
    workerInternals.logSocketMessageError('1.1', 'socket string')
    workerInternals.logSocketCleanupError('1.1', 'room', 'cleanup string')
    expect(error).toHaveBeenCalledTimes(6)
    error.mockRestore()
  })

  it('normalizes realtime wire errors', () => {
    expect(workerInternals.resolveRealtimeErrorStatus('failure')).toBeUndefined()
    expect(workerInternals.resolveRealtimeErrorStatus({ decision: { status: 422 } })).toBe(422)
    expect(workerInternals.resolveRealtimeErrorStatus({ status: 503 })).toBe(503)
    expect(workerInternals.resolveRealtimeErrorStatus({ statusCode: 404 })).toBe(404)
    expect(workerInternals.resolveRealtimeErrorStatus({ name: 'RealtimeUnauthorizedError' })).toBe(401)
    expect(workerInternals.resolveRealtimeErrorStatus({ name: 'RealtimeForbiddenError' })).toBe(403)
    expect(workerInternals.resolveRealtimeErrorStatus({ status: 200 })).toBeUndefined()
    expect(workerInternals.resolveRealtimeErrorCode(null)).toBeUndefined()
    expect(workerInternals.resolveRealtimeErrorCode({ decision: { code: 'denied' } })).toBe('denied')
    expect(workerInternals.resolveRealtimeErrorCode({ code: 42 })).toBeUndefined()
    expect(workerInternals.resolveRealtimeErrorKind(null, undefined)).toBe('runtime')
    expect(workerInternals.resolveRealtimeErrorKind({ name: 'AuthorizationError' }, undefined)).toBe('authorization')
    expect(workerInternals.resolveRealtimeErrorKind({}, 404)).toBe('authorization')
    expect(workerInternals.resolveRealtimeErrorKind({ name: 'RealtimeAuthUnavailableError' }, undefined)).toBe('transport')
    expect(workerInternals.resolveRealtimeErrorKind({}, 500)).toBe('runtime')
  })

  it('covers websocket protocol and unauthenticated worker failures', async () => {
    const config = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'app' },
      },
    })
    const app = workerInternals.buildWorkerApps(config).key!
    const messages: string[] = []
    const runtime = createBroadcastWorkerRuntime({ config, now: () => 1_700_000_000_000 })
    const socket = {
      socketId: '1.1', app, headers: new Headers(),
      send: (message: string) => messages.push(message), close: vi.fn(),
    }
    runtime.connectWebSocket(socket)
    await runtime.receiveWebSocketMessage('missing', '{}')
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:ping' }))
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'holo:realtime', data: { id: 'request', action: 'query', name: 'posts.list' },
    }))
    await expect(runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'client-update', channel: 'private-room', data: {},
    }))).rejects.toThrow('not subscribed')
    expect(messages.some(message => message.includes('pusher:pong'))).toBe(true)
    expect(messages.some(message => message.includes('holo:realtime:error'))).toBe(true)

    const body = '{}'
    const base = 'https://worker.test/apps/app/events'
    expect((await runtime.fetch(new Request(`${base}?body_md5=bad`, { method: 'POST', body }))).status).toBe(401)
    expect((await runtime.fetch(new Request('https://worker.test/apps/missing/events', { method: 'POST', body }))).status).toBe(404)
    expect((await runtime.fetch(new Request(base, {
      method: 'POST', headers: { 'content-length': '99999999' }, body,
    }))).status).toBe(413)
    expect((await runtime.fetch(new Request('https://worker.test/missing'))).status).toBe(404)
    runtime.disconnectWebSocket('1.1')
    runtime.disconnectWebSocket('1.1')
    await runtime.close()
  })

  it('covers public, signed-client, and denied subscription authentication', async () => {
    const config = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'app' },
      },
    })
    const app = workerInternals.buildWorkerApps(config).key!
    const messages: string[] = []
    const socket = {
      socketId: '1.1', app, headers: new Headers(),
      send: (message: string) => messages.push(message), close: vi.fn(),
    }
    const runtime = createBroadcastWorkerRuntime({ config })
    runtime.connectWebSocket(socket)
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:subscribe', data: { channel: 'room' },
    }))
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:unsubscribe', data: { channel: 'unsubscribed-room' },
    }))
    await expect(runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'client-update', channel: 'room', data: {},
    }))).rejects.toThrow('only allowed on private or presence')

    const privateChannel = 'private-orders.1'
    const signature = createHmac('sha256', app.secret).update(`1.1:${privateChannel}`).digest('hex')
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: privateChannel, auth: `${app.key}:${signature}` },
    }))
    const whisperData = JSON.stringify({ whispers: ['typing'] })
    const whisperSignature = createHmac('sha256', app.secret).update(`1.1:${privateChannel}:${whisperData}`).digest('hex')
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: privateChannel, auth: `${app.key}:${whisperSignature}`, channel_data: whisperData },
    }))
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: privateChannel, auth: `${app.key}:${signature}` },
    }))
    expect(messages.some(message => message.includes('subscription_succeeded'))).toBe(true)

    const deniedRuntime = createBroadcastWorkerRuntime({
      config,
      channelAuth: {
        definitions: [defineChannel('denied.{id}', { type: 'private', authorize: () => false })],
      },
    })
    const denied = { ...socket, socketId: '2.2' }
    deniedRuntime.connectWebSocket(denied)
    await expect(deniedRuntime.receiveWebSocketMessage('2.2', JSON.stringify({
      event: 'pusher:subscribe', data: { channel: 'private-denied.1' },
    }))).rejects.toThrow('authorization denied')
    await runtime.receiveScalingMessage('{}')
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'unknown', data: {} }))
    await expect(runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:subscribe', data: {} }))).rejects.toThrow('Subscription channel')
    await expect(runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'pusher:unsubscribe', data: {} }))).rejects.toThrow('Unsubscribe channel')
    await expect(runtime.receiveWebSocketMessage('1.1', JSON.stringify({ event: 'client-update', data: {} }))).rejects.toThrow('Whisper channel')
    await runtime.close()
    await deniedRuntime.close()
  })

  it('covers every signed publish credential and payload failure', async () => {
    const config = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'app' },
      },
    })
    const runtime = createBroadcastWorkerRuntime({ config, now: () => 1_700_000_000_000 })
    const createRequest = (body: string, params: Record<string, string>): Request => {
      const url = new URL('https://worker.test/apps/app/events')
      url.searchParams.set('body_md5', createHash('md5').update(body).digest('hex'))
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      return new Request(url, { method: 'POST', body })
    }

    expect((await runtime.fetch(createRequest('{}', {}))).status).toBe(401)
    expect((await runtime.fetch(createRequest('{}', { auth_key: 'wrong' }))).status).toBe(401)
    expect((await runtime.fetch(createRequest('{}', { auth_key: 'key' }))).status).toBe(401)
    expect((await runtime.fetch(createRequest('{}', {
      auth_key: 'key', auth_timestamp: '1700000000',
    }))).status).toBe(401)

    const invalidBody = '{'
    const url = new URL('https://worker.test/apps/app/events')
    url.searchParams.set('auth_key', 'key')
    url.searchParams.set('auth_timestamp', '1700000000')
    url.searchParams.set('body_md5', createHash('md5').update(invalidBody).digest('hex'))
    url.searchParams.set('auth_signature', workerInternals.createPusherSignature(
      'secret', 'POST', url.pathname, url.searchParams,
    ))
    expect((await runtime.fetch(new Request(url, { method: 'POST', body: invalidBody }))).status).toBe(400)

    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('body failed'))
      },
    })
    await expect(runtime.fetch(new Request('https://worker.test/apps/app/events', {
      method: 'POST', body: failingBody, duplex: 'half',
    } as RequestInit & { duplex: 'half' }))).rejects.toThrow('body failed')
    await runtime.close()
  })

  it('covers scaling message, presence removal, and disconnect cleanup failures', async () => {
    const config = normalizeBroadcastConfig({
      default: 'main',
      connections: {
        main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'app' },
      },
      worker: { scaling: { driver: 'redis', connection: 'broadcast' } },
    })
    let scalingListener: ((payload: string) => void) | undefined
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const adapter = {
      publish: vi.fn(async () => {}),
      subscribe: vi.fn(async (_channel: string, listener: (payload: string) => void) => {
        scalingListener = listener
        return async () => {}
      }),
      hashSet: vi.fn(async () => {}),
      hashDelete: vi.fn(async () => {}),
      hashGetAll: vi.fn(async () => ({ 'node-a:1.1': JSON.stringify({ id: 'user-1' }) })),
      close: vi.fn(async () => {}),
    }
    const runtime = createBroadcastWorkerRuntime({
      config,
      channelAuth: {
        definitions: [defineChannel('room.{id}', {
          type: 'presence',
          authorize: () => ({ id: 'user-1' }),
        })],
      },
      scaling: {
        driver: 'redis', connection: 'broadcast', nodeId: 'node-a',
        eventChannel: workerInternals.resolveScalingEventChannel('broadcast'), adapter,
      },
    })
    scalingListener?.('{')
    await vi.waitFor(() => expect(error).toHaveBeenCalled())

    const app = workerInternals.buildWorkerApps(config).key!
    const socket = { socketId: '1.1', app, headers: new Headers(), send: vi.fn(), close: vi.fn() }
    runtime.connectWebSocket(socket)
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-added', originNodeId: 'node-z', appId: 'app',
      channel: 'presence-orphan', socketId: '9.9', member: { id: 'orphan' },
    }))
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:unsubscribe', data: { channel: 'presence-orphan' },
    }))
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:subscribe', data: { channel: 'presence-room.1' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-added', originNodeId: 'node-b', appId: 'app',
      channel: 'presence-room.1', socketId: '2.2', member: { id: 'user-2' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-added', originNodeId: 'node-b', appId: 'app',
      channel: 'presence-room.1', socketId: '2.3', member: { id: 'user-2' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-removed', originNodeId: 'node-b', appId: 'app',
      channel: 'presence-room.1', socketId: '2.2', member: { id: 'user-2' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-added', originNodeId: 'node-c', appId: 'app',
      channel: 'presence-room.2', socketId: '3.3', member: { id: 'user-3' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-added', originNodeId: 'node-d', appId: 'app',
      channel: 'presence-room.2', socketId: '4.4', member: { id: 'user-4' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-removed', originNodeId: 'missing', appId: 'app',
      channel: 'presence-missing', socketId: 'missing', member: { id: 'missing' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'event', originNodeId: 'node-b', appId: 'app', name: 'scaled.event',
      channels: ['room'], data: '{}', socket_id: 'legacy.1',
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-removed', originNodeId: 'node-c', appId: 'app',
      channel: 'presence-room.2', socketId: '3.3', member: { id: 'user-3' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-added', originNodeId: 'node-e', appId: 'app',
      channel: 'presence-room.3', socketId: '5.5', member: { id: 'user-5' },
    }))
    await runtime.receiveScalingMessage(JSON.stringify({
      type: 'presence-member-removed', originNodeId: 'node-e', appId: 'app',
      channel: 'presence-room.3', socketId: '5.5', member: { id: 'user-5' },
    }))
    adapter.publish.mockRejectedValue(new Error('publish failed'))
    adapter.hashDelete.mockRejectedValue(new Error('delete failed'))
    runtime.disconnectWebSocket('1.1')
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(expect.stringContaining('delete failed'))
    })
    await runtime.close()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('publish failed'))
    error.mockRestore()
  })

  it('covers empty scaled presence and active realtime subscription errors', async () => {
    const config = normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', key: 'key', secret: 'secret', appId: 'app' } },
      worker: { scaling: { driver: 'redis', connection: 'broadcast' } },
    })
    const runtime = createBroadcastWorkerRuntime({
      config,
      channelAuth: {
        definitions: [defineChannel('room.{id}', { type: 'presence', authorize: () => ({ id: 'user' }) })],
      },
      realtime: {
        query: async () => ({ name: 'query', data: {}, dependencies: [] }),
        mutate: async () => ({ name: 'mutation', data: {}, dependencies: [] }),
        subscribe: async (_name, _args, options) => {
          await options.onError(new Error('subscription failed'))
          await options.onError('subscription string failure')
          return {
            id: 'subscription',
            current: { name: 'query', data: {}, dependencies: [], version: 1 },
            unsubscribe: async () => {},
          }
        },
      },
      scaling: {
        driver: 'redis', connection: 'broadcast', nodeId: 'node-a',
        eventChannel: workerInternals.resolveScalingEventChannel('broadcast'),
        adapter: {
          async publish() {}, async subscribe() { return async () => {} }, async hashSet() {}, async hashDelete() {},
          async hashGetAll() { return {} }, async close() {},
        },
      },
    })
    const app = workerInternals.buildWorkerApps(config).key!
    const send = vi.fn()
    runtime.connectWebSocket({ socketId: '1.1', app, headers: new Headers(), send, close: vi.fn() })
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'pusher:subscribe', data: { channel: 'presence-room.1' },
    }))
    await runtime.receiveWebSocketMessage('1.1', JSON.stringify({
      event: 'holo:realtime', data: { id: 'sub', action: 'subscribe', name: 'posts.list', args: {} },
    }))
    expect(send).toHaveBeenCalledWith(expect.stringContaining('holo:realtime:error'))
    await runtime.close()
  })

  it('normalizes Node request body failures into safe responses', () => {
    const response = { statusCode: 0, end: vi.fn() }
    workerInternals.writeNodeRequestBodyError(response as never, new Error('stream failed'))
    expect(response.statusCode).toBe(500)
    expect(response.end).toHaveBeenCalledWith('Internal Server Error')
  })
})
