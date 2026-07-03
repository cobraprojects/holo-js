import type { RealtimeSubscriptionSnapshot } from '../contracts'
import {
  createWireError,
  warnRealtimeOnce,
} from './errors'
import {
  applyWireSnapshotPatch,
  isStaleRealtimePatch,
  isStaleRealtimeSnapshot,
  parseWireSnapshotPatch,
} from './patching'
import type {
  BroadcastClientConfig,
  RealtimeClientGlobals,
  RealtimeClientTransport,
  RealtimeWebSocketLike,
  RealtimeWireAction,
  RealtimeWireResult,
} from './types'
import {
  unavailableTransportMessage,
} from './types'
import {
  parseRealtimeJsonObject,
  parseWireData,
} from './utils'

function resolveWebSocketScheme(scheme: BroadcastClientConfig['scheme'], globals: RealtimeClientGlobals): 'ws' | 'wss' {
  if (scheme === 'https') {
    return 'wss'
  }

  if (globals.location?.protocol === 'https:') {
    return 'wss'
  }

  return 'ws'
}

function resolveBrowserHost(host: string, globals: RealtimeClientGlobals): string {
  const browserHostname = globals.location?.hostname
  if (!browserHostname) {
    return host === '0.0.0.0' ? '127.0.0.1' : host
  }

  const loopbackHosts = new Set(['0.0.0.0', '127.0.0.1', 'localhost', '::1', '[::1]'])
  if (loopbackHosts.has(host) && loopbackHosts.has(browserHostname)) {
    return browserHostname
  }

  return host
}

async function resolveBroadcastClientConfig(
  endpoint: string,
  globals: RealtimeClientGlobals,
): Promise<BroadcastClientConfig> {
  if (!globals.fetch) {
    throw new Error('Realtime live updates require fetch support in this runtime.')
  }

  const response = await globals.fetch(endpoint, {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`Realtime broadcast config failed with HTTP ${response.status}.`)
  }

  const config = await response.json() as Partial<BroadcastClientConfig>
  if (
    typeof config.key !== 'string'
    || typeof config.host !== 'string'
    || typeof config.port !== 'number'
    || typeof config.path !== 'string'
    || (config.scheme !== 'http' && config.scheme !== 'https')
  ) {
    throw new Error('Realtime broadcast config response is invalid.')
  }

  return {
    key: config.key,
    host: config.host,
    port: config.port,
    path: config.path,
    scheme: config.scheme,
  }
}

export function createBroadcastRealtimeTransport(options: {
  readonly configEndpoint?: string
} = {}): RealtimeClientTransport {
  const pending = new Map<string, {
    readonly resolve: (value: RealtimeWireResult<unknown>) => void
    readonly reject: (error: unknown) => void
  }>()
  const subscriptions = new Map<string, {
    currentSnapshot?: RealtimeSubscriptionSnapshot<unknown>
    listener(snapshot: RealtimeSubscriptionSnapshot<unknown>): void
    readonly onError: (error: unknown) => void
  }>()
  let socket: RealtimeWebSocketLike | undefined
  let connecting: Promise<RealtimeWebSocketLike> | undefined
  let nextRequestId = 0

  const rejectPending = (error: unknown): void => {
    for (const request of pending.values()) {
      request.reject(error)
    }
    pending.clear()
    for (const subscription of subscriptions.values()) {
      subscription.onError(error)
    }
    subscriptions.clear()
  }

  const handleMessage = (event: { readonly data: unknown }): void => {
    if (typeof event.data !== 'string') {
      return
    }

    const message = parseRealtimeJsonObject(event.data)
    const eventName = typeof message.event === 'string' ? message.event : ''
    const data = parseWireData(message.data)
    const id = typeof data.id === 'string' ? data.id : ''
    if (!id) {
      return
    }

    if (eventName === 'holo:realtime:error') {
      const error = createWireError(data)
      pending.get(id)?.reject(error)
      pending.delete(id)
      subscriptions.get(id)?.onError(error)
      return
    }

    if (eventName === 'holo:realtime:result') {
      pending.get(id)?.resolve(data as RealtimeWireResult<unknown>)
      pending.delete(id)
      return
    }

    if (eventName === 'holo:realtime:snapshot') {
      const snapshot = data.snapshot
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        const subscription = subscriptions.get(id)
        const nextSnapshot = snapshot as RealtimeSubscriptionSnapshot<unknown>
        if (subscription && !isStaleRealtimeSnapshot(subscription.currentSnapshot, nextSnapshot)) {
          subscription.currentSnapshot = nextSnapshot
          subscription.listener(nextSnapshot)
        }
      }
      return
    }

    if (eventName !== 'holo:realtime:patch') {
      return
    }

    const subscription = subscriptions.get(id)
    if (!subscription?.currentSnapshot) {
      return
    }

    const patch = parseWireSnapshotPatch(data.patch)
    if (!patch || isStaleRealtimePatch(subscription.currentSnapshot, patch)) {
      return
    }

    const currentSnapshot = subscription.currentSnapshot
    const snapshot = applyWireSnapshotPatch(currentSnapshot, patch)
    subscription.currentSnapshot = snapshot
    subscription.listener(snapshot)
  }

  const connect = async (): Promise<RealtimeWebSocketLike> => {
    const globals = globalThis as RealtimeClientGlobals
    if (socket?.readyState === 1) {
      return socket
    }

    if (connecting) {
      return await connecting
    }

    connecting = (async () => {
      const WebSocketConstructor = globals.WebSocket
      if (!WebSocketConstructor) {
        throw new Error('Realtime live updates require WebSocket support in this runtime.')
      }

      const config = await resolveBroadcastClientConfig(options.configEndpoint ?? '/broadcasting/config', globals)
      const scheme = resolveWebSocketScheme(config.scheme, globals)
      const host = resolveBrowserHost(config.host, globals)
      const normalizedPath = `/${config.path.replace(/^\/+|\/+$/g, '')}`
      const url = `${scheme}://${host}:${config.port}${normalizedPath}/${encodeURIComponent(config.key)}`

      return await new Promise<RealtimeWebSocketLike>((resolve, reject) => {
        const nextSocket = new WebSocketConstructor(url)
        socket = nextSocket
        nextSocket.addEventListener('open', () => {
          resolve(nextSocket)
        })
        nextSocket.addEventListener('message', handleMessage)
        nextSocket.addEventListener('close', () => {
          socket = undefined
          connecting = undefined
          const error = new Error(unavailableTransportMessage)
          warnRealtimeOnce(unavailableTransportMessage)
          rejectPending(error)
        })
        nextSocket.addEventListener('error', () => {
          socket = undefined
          connecting = undefined
          const error = new Error(unavailableTransportMessage)
          warnRealtimeOnce(unavailableTransportMessage)
          reject(error)
          rejectPending(error)
        })
      })
    })().finally(() => {
      connecting = undefined
    })

    return await connecting
  }

  const send = async <TResult>(
    action: RealtimeWireAction,
    name: string,
    args: Record<string, unknown>,
    id = `realtime.${++nextRequestId}`,
  ): Promise<RealtimeWireResult<TResult>> => {
    try {
      const connectedSocket = await connect()
      const response = new Promise<RealtimeWireResult<TResult>>((resolve, reject) => {
        pending.set(id, {
          resolve: value => resolve(value as RealtimeWireResult<TResult>),
          reject,
        })
      })
      connectedSocket.send(JSON.stringify({
        event: 'holo:realtime',
        data: {
          id,
          action,
          name,
          args,
        },
      }))
      return await response
    } catch (error) {
      warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
      throw error
    }
  }

  const sendSubscription = async (
    name: string,
    args: Record<string, unknown>,
    id: string,
  ): Promise<void> => {
    try {
      const connectedSocket = await connect()
      connectedSocket.send(JSON.stringify({
        event: 'holo:realtime',
        data: {
          id,
          action: 'subscribe',
          name,
          args,
        },
      }))
    } catch (error) {
      warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
      throw error
    }
  }

  return {
    async query<TResult>(name: string, args: Record<string, unknown>) {
      const response = await send<TResult>('query', name, args)
      if (!response.snapshot) {
        throw new Error('Realtime query response did not include a snapshot.')
      }

      return response.snapshot
    },
    async mutate<TResult>(name: string, args: Record<string, unknown>) {
      const response = await send<TResult>('mutation', name, args)
      if (!response.result) {
        throw new Error('Realtime mutation response did not include a result.')
      }

      return response.result
    },
    subscribe<TResult>(
      name: string,
      args: Record<string, unknown>,
      listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
      onError: (error: unknown) => void,
    ) {
      const id = `realtime.${++nextRequestId}`
      subscriptions.set(id, {
        listener: snapshot => listener(snapshot as RealtimeSubscriptionSnapshot<TResult>),
        onError,
      })
      void sendSubscription(name, args, id).catch((error) => {
        warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
        onError(error)
      })

      return () => {
        subscriptions.delete(id)
        if (socket?.readyState === 1) {
          socket.send(JSON.stringify({
            event: 'holo:realtime',
            data: {
              id,
              action: 'unsubscribe',
              args: {},
            },
          }))
        }
      }
    },
  }
}
