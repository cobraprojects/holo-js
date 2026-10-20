import { broadcastBrowserInternals } from '@holo-js/broadcast/client-config'
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

  const config = await broadcastBrowserInternals.discoverConfig(globals.fetch, endpoint) as Partial<BroadcastClientConfig>

  if (
    !config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.key !== 'string'
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
      ...(globals.document
        ? await import('@holo-js/security/client')
          .then(security => security.securityClientInternals.getCsrfRequestHeaders(globals.document?.cookie))
          .catch(() => ({}))
        : {}),
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

type RealtimeTransportSocket = {
  send(value: string): void
}

type RealtimeTransportSubscription = {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
  currentSnapshot?: RealtimeSubscriptionSnapshot<unknown>
  sentOn?: RealtimeTransportSocket
  listener(snapshot: RealtimeSubscriptionSnapshot<unknown>): void
  readonly onError: (error: unknown) => void
}

export function createBroadcastRealtimeTransport(options: {
  readonly configEndpoint?: string
} = {}): RealtimeClientTransport {
  const pendingMutations = new Map<string, {
    readonly resolve: (value: RealtimeWireResult<unknown>) => void
    readonly reject: (error: unknown) => void
  }>()
  const subscriptions = new Map<string, RealtimeTransportSubscription>()
  let connection: ReturnType<typeof broadcastBrowserInternals.createConnection> | undefined
  let nextRequestId = 0

  const closeSocketIfIdle = (): void => {
    if (subscriptions.size > 0 || pendingMutations.size > 0 || !connection) {
      return
    }

    if (!connection.socket && !connection.reconnecting) {
      return
    }

    connection.disconnect()
  }

  const rejectPendingMutations = (error: unknown): void => {
    for (const request of pendingMutations.values()) {
      request.reject(error)
    }
    pendingMutations.clear()
  }

  const sendSubscribe = (subscription: RealtimeTransportSubscription, socket: RealtimeTransportSocket): void => {
    if (subscription.sentOn === socket) {
      return
    }

    subscription.sentOn = socket
    subscription.currentSnapshot = undefined
    socket.send(JSON.stringify({
      event: 'holo:realtime',
      data: {
        id: subscription.id,
        action: 'subscribe',
        name: subscription.name,
        args: subscription.args,
      },
    }))
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

  const connect = async () => {
    const globals = globalThis as RealtimeClientGlobals
    const WebSocketConstructor = globals.WebSocket
    if (!WebSocketConstructor) {
      throw new Error('Realtime live updates require WebSocket support in this runtime.')
    }
    connection ??= broadcastBrowserInternals.createConnection({
      WebSocket: WebSocketConstructor,
      failureMessage: unavailableTransportMessage,
      async resolveUrl() {
        const config = await resolveBroadcastClientConfig(options.configEndpoint ?? '/broadcasting/config', globals)
        return broadcastBrowserInternals.formatUrl({
          ...config,
          scheme: resolveWebSocketScheme(config.scheme, globals),
          host: resolveBrowserHost(config.host, globals),
        })
      },
      onOpen(socket) {
        for (const subscription of subscriptions.values()) {
          sendSubscribe(subscription, socket)
        }
      },
      onMessage: handleMessage,
      onDisconnect(error) {
        warnRealtimeOnce(error.message)
        rejectPendingMutations(error)
        closeSocketIfIdle()
      },
    })
    return await connection.connect()
  }

  const sendSubscription = async (id: string): Promise<void> => {
    try {
      const connectedSocket = await connect()
      const subscription = subscriptions.get(id)
      if (!subscription) {
        closeSocketIfIdle()
        return
      }
      sendSubscribe(subscription, connectedSocket)
    } catch (error) {
      warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
      throw error
    }
  }

  const sendMutation = async <TResult>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<RealtimeExecutionResult<TResult> | undefined> => {
    if (!connection?.socket) {
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
      connection.socket.send(JSON.stringify({
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
        id,
        name,
        args,
        listener: snapshot => listener(snapshot as RealtimeSubscriptionSnapshot<TResult>),
        onError,
      })
      void sendSubscription(id).catch((error) => {
        warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
        if (connection?.reconnecting) {
          return
        }
        if (subscriptions.delete(id)) {
          onError(error)
          closeSocketIfIdle()
        }
      })

      return () => {
        subscriptions.delete(id)
        if (connection?.socket) {
          connection.socket.send(JSON.stringify({
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
