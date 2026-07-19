import type { RealtimeExecutionResult, RealtimeSubscriptionSnapshot } from '../contracts'
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
  RealtimeWireResult,
  RealtimeWebSocketLike,
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

async function executeRealtimeRequest<TResult>(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
): Promise<TResult> {
  const globals = globalThis as RealtimeClientGlobals
  if (!globals.fetch) {
    throw new Error('Realtime queries and mutations require fetch support in this runtime.')
  }

  const response = await globals.fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, args }),
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw createWireError({
      ...data,
      status: typeof data.status === 'number' ? data.status : response.status,
    })
  }

  return data as TResult
}

export function createBroadcastRealtimeTransport(options: {
  readonly configEndpoint?: string
} = {}): RealtimeClientTransport {
  const pendingMutations = new Map<string, {
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

  const closeSocketIfIdle = (): void => {
    if (subscriptions.size > 0 || pendingMutations.size > 0 || socket?.readyState !== 1) {
      return
    }

    const idleSocket = socket
    socket = undefined
    idleSocket.close()
  }

  const rejectPending = (error: unknown): void => {
    for (const request of pendingMutations.values()) {
      request.reject(error)
    }
    pendingMutations.clear()
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
      pendingMutations.get(id)?.reject(error)
      pendingMutations.delete(id)
      subscriptions.get(id)?.onError(error)
      closeSocketIfIdle()
      return
    }

    if (eventName === 'holo:realtime:result') {
      pendingMutations.get(id)?.resolve(data as RealtimeWireResult<unknown>)
      pendingMutations.delete(id)
      closeSocketIfIdle()
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
          if (socket !== nextSocket) {
            return
          }
          socket = undefined
          connecting = undefined
          const error = new Error(unavailableTransportMessage)
          warnRealtimeOnce(unavailableTransportMessage)
          rejectPending(error)
        })
        nextSocket.addEventListener('error', () => {
          if (socket !== nextSocket) {
            return
          }
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

  const sendSubscription = async (
    name: string,
    args: Record<string, unknown>,
    id: string,
  ): Promise<void> => {
    try {
      const connectedSocket = await connect()
      if (!subscriptions.has(id)) {
        closeSocketIfIdle()
        return
      }
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

  const sendMutation = async <TResult>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<RealtimeExecutionResult<TResult> | undefined> => {
    if (socket?.readyState !== 1) {
      return undefined
    }

    const id = `realtime.${++nextRequestId}`
    const response = new Promise<RealtimeWireResult<TResult>>((resolve, reject) => {
      pendingMutations.set(id, {
        resolve: value => resolve(value as RealtimeWireResult<TResult>),
        reject,
      })
    })
    try {
      socket.send(JSON.stringify({
        event: 'holo:realtime',
        data: {
          id,
          action: 'mutation',
          name,
          args,
        },
      }))
    } catch {
      pendingMutations.delete(id)
      return undefined
    }

    const result = (await response).result
    if (!result) {
      throw new Error('Realtime mutation response did not include a result.')
    }
    return result
  }

  return {
    async query<TResult>(name: string, args: Record<string, unknown>) {
      return await executeRealtimeRequest<RealtimeSubscriptionSnapshot<TResult>>(
        '/holo/realtime/query',
        name,
        args,
      )
    },
    async mutate<TResult>(name: string, args: Record<string, unknown>) {
      const liveResult = await sendMutation<TResult>(name, args)
      if (liveResult) {
        return liveResult
      }
      return await executeRealtimeRequest<RealtimeExecutionResult<TResult>>(
        '/holo/realtime/mutation',
        name,
        args,
      )
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
        closeSocketIfIdle()
      }
    },
  }
}
