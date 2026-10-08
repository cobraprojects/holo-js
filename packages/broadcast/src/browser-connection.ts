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

function createConnection(options: {
  readonly WebSocket: BrowserSocketConstructor
  readonly resolveUrl: () => ResolvedConnection | Promise<ResolvedConnection>
  readonly failureMessage: string
  readonly onOpen?: () => void
  readonly onMessage: (event: { readonly data: unknown }) => void
  readonly onDisconnect: (error: Error) => void
}) {
  let attempt: ConnectionAttempt | undefined

  const disconnect = (): void => {
    const previous = attempt
    attempt = undefined
    previous?.reject(new Error(options.failureMessage))
    previous?.socket?.close()
  }

  return {
    get socket(): BrowserSocket | undefined {
      return attempt?.socket?.readyState === 1 ? attempt.socket : undefined
    },
    connect(): Promise<BrowserSocket> {
      if (attempt) {
        return attempt.promise
      }

      let resolve!: (socket: BrowserSocket) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<BrowserSocket>((accept, decline) => {
        resolve = accept
        reject = decline
      })
      const next: ConnectionAttempt = { promise, reject }
      attempt = next

      const fail = (error: unknown): void => {
        if (attempt !== next) {
          return
        }
        attempt = undefined
        reject(error)
        next.socket?.close()
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
            resolve(socket)
            options.onOpen?.()
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
    },
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
