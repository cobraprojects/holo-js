type BrowserSocket = {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'message', listener: (event: { readonly data: unknown }) => void): void
  addEventListener(event: 'close' | 'error', listener: () => void): void
}

type BrowserSocketConstructor = new (url: string) => BrowserSocket

type ResolvedConnection = string | {
  readonly url: string
  readonly activate: () => void
}

type ConnectionAttempt = {
  socket?: BrowserSocket
  readonly promise: Promise<BrowserSocket>
  readonly reject: (error: unknown) => void
}

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 30_000
const STABLE_CONNECTION_MS = 5_000

function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1))
  return ceiling / 2 + Math.random() * ceiling / 2
}

function createConnection(options: {
  readonly WebSocket: BrowserSocketConstructor
  readonly resolveUrl: () => ResolvedConnection | Promise<ResolvedConnection>
  readonly failureMessage: string
  readonly onOpen?: (socket: BrowserSocket) => void
  readonly onMessage: (event: { readonly data: unknown }) => void
  readonly onDisconnect: (error: Error) => void
}) {
  let attempt: ConnectionAttempt | undefined
  let reconnecting = false
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined

  const cancelReconnect = (): void => {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  const cancelStabilityCheck = (): void => {
    clearTimeout(stabilityTimer)
    stabilityTimer = undefined
  }

  const scheduleReconnect = (): void => {
    if (reconnectTimer !== undefined) {
      return
    }

    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect().catch(() => undefined)
    }, reconnectDelay(reconnectAttempts))
  }

  const connect = (): Promise<BrowserSocket> => {
    if (attempt) {
      return attempt.promise
    }

    cancelReconnect()
    let resolve!: (socket: BrowserSocket) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<BrowserSocket>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    const next: ConnectionAttempt = { promise, reject }
    attempt = next
    let opened = false

    const fail = (error: unknown): void => {
      if (attempt !== next) {
        return
      }
      cancelStabilityCheck()
      attempt = undefined
      reconnecting ||= opened
      reject(error)
      next.socket?.close()
      if (reconnecting) {
        scheduleReconnect()
      }
      if (next.socket) {
        options.onDisconnect(error instanceof Error ? error : new Error(options.failureMessage))
      }
    }

    const open = (resolved: ResolvedConnection): void => {
      if (attempt !== next) {
        return
      }
      try {
        const url = typeof resolved === 'string' ? resolved : resolved.url
        const socket = new options.WebSocket(url)
        next.socket = socket
        if (typeof resolved !== 'string') {
          resolved.activate()
        }
        socket.addEventListener('open', () => {
          if (attempt !== next) {
            return
          }
          opened = true
          reconnecting = false
          resolve(socket)
          stabilityTimer = setTimeout(() => {
            stabilityTimer = undefined
            if (attempt === next) {
              reconnectAttempts = 0
            }
          }, STABLE_CONNECTION_MS)
          options.onOpen?.(socket)
        })
        socket.addEventListener('message', (event) => {
          if (attempt === next) {
            options.onMessage(event)
          }
        })
        socket.addEventListener('close', () => fail(new Error(options.failureMessage)))
        socket.addEventListener('error', () => fail(new Error(options.failureMessage)))
      } catch (error) {
        fail(error)
      }
    }

    try {
      const url = options.resolveUrl()
      if (typeof url === 'string' || 'url' in url) {
        open(url)
      } else {
        void url.then(open, error => fail(error))
      }
    } catch (error) {
      fail(error)
    }
    return promise
  }

  const disconnect = (): void => {
    reconnecting = false
    reconnectAttempts = 0
    cancelReconnect()
    cancelStabilityCheck()
    const previous = attempt
    attempt = undefined
    previous?.reject(new Error(options.failureMessage))
    previous?.socket?.close()
  }

  return {
    get socket(): BrowserSocket | undefined {
      return attempt?.socket?.readyState === 1 ? attempt.socket : undefined
    },
    get reconnecting(): boolean {
      return reconnecting
    },
    connect,
    disconnect,
  }
}

async function discoverConfig(
  fetchConfig: (endpoint: string, init: {
    readonly credentials: 'same-origin'
    readonly headers: Readonly<Record<string, string>>
  }) => Promise<{ readonly ok: boolean, readonly status: number, json(): Promise<unknown> }>,
  endpoint: string,
): Promise<unknown> {
  const response = await fetchConfig(endpoint, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`Realtime broadcast config failed with HTTP ${response.status}.`)
  }
  return await response.json()
}

function formatUrl(config: {
  readonly scheme: 'ws' | 'wss'
  readonly host: string
  readonly port: number
  readonly path: string
  readonly key: string
}): string {
  const path = `/${config.path.replace(/^\/+|\/+$/g, '')}`
  return `${config.scheme}://${config.host}:${config.port}${path}/${encodeURIComponent(config.key)}`
}

export const broadcastBrowserInternals = { createConnection, discoverConfig, formatUrl }
