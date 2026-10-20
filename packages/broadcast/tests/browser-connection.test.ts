import { afterEach, describe, expect, it, vi } from 'vitest'
import { broadcastBrowserInternals } from '../src/client-config'

type SocketEvent = 'open' | 'close' | 'error' | 'message'

class BrowserSocketAdapter {
  static sockets: BrowserSocketAdapter[] = []
  readyState = 0
  closes = 0
  readonly frames: string[] = []
  readonly listeners = new Map<SocketEvent, Array<(event: { readonly data: unknown }) => void>>()

  constructor(readonly url: string) {
    BrowserSocketAdapter.sockets.push(this)
  }

  send(data: string): void {
    this.frames.push(data)
  }

  close(): void {
    this.closes++
    this.readyState = 3
    this.emit('close')
  }

  addEventListener(event: SocketEvent, listener: (event: { readonly data: unknown }) => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  emit(event: SocketEvent, data?: string): void {
    if (event === 'open') this.readyState = 1
    for (const listener of this.listeners.get(event) ?? []) listener({ data })
  }
}

function createHarness(resolveUrl: () => string | Promise<string> = () => 'ws://localhost:8080/app/key') {
  BrowserSocketAdapter.sockets = []
  const messages: unknown[] = []
  const errors: Error[] = []
  let opens = 0
  const connection = broadcastBrowserInternals.createConnection({
    WebSocket: BrowserSocketAdapter,
    resolveUrl,
    failureMessage: 'Connection unavailable',
    onOpen() { opens++ },
    onMessage(event) { messages.push(event.data) },
    onDisconnect(error) { errors.push(error) },
  })
  return { connection, messages, errors, get opens() { return opens } }
}

describe('Broadcast browser connection ownership', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('deduplicates configuration discovery and connection until open', async () => {
    let discoveries = 0
    const harness = createHarness(async () => {
      discoveries++
      return 'ws://localhost:8080/app/key'
    })
    const first = harness.connection.connect()
    const second = harness.connection.connect()
    await Promise.resolve()
    expect(discoveries).toBe(1)
    expect(BrowserSocketAdapter.sockets).toHaveLength(1)
    const socket = BrowserSocketAdapter.sockets[0]!
    socket.emit('open')
    expect(await first).toBe(socket)
    expect(await second).toBe(socket)
    harness.connection.disconnect()
    expect(socket.closes).toBe(1)
    expect(harness.errors).toEqual([])
  })

  it('retires failed sockets and ignores their events after reconnecting', async () => {
    const harness = createHarness()
    const first = harness.connection.connect()
    const firstFailure = expect(first).rejects.toThrow('Connection unavailable')
    const retired = BrowserSocketAdapter.sockets[0]!
    retired.emit('error')
    await firstFailure
    expect(retired.closes).toBe(1)
    const second = harness.connection.connect()
    const current = BrowserSocketAdapter.sockets[1]!
    current.emit('open')
    await second
    retired.emit('open')
    retired.emit('message', 'stale')
    retired.emit('close')
    retired.emit('error')
    current.emit('message', 'current')
    expect(harness.opens).toBe(1)
    expect(harness.messages).toEqual(['current'])
    expect(harness.errors).toHaveLength(1)
    expect(harness.connection.socket).toBe(current)
    harness.connection.disconnect()
  })

  it('settles a connection closed before opening and permits a retry', async () => {
    const harness = createHarness()
    const first = harness.connection.connect()
    const rejected = expect(first).rejects.toThrow('Connection unavailable')
    BrowserSocketAdapter.sockets[0]!.emit('close')
    await rejected
    const retry = harness.connection.connect()
    BrowserSocketAdapter.sockets[1]!.emit('open')
    await retry
    expect(harness.errors).toHaveLength(1)
    harness.connection.disconnect()
  })

  it('cancels discovery without creating a late socket or clearing a newer connection', async () => {
    let finishDiscovery!: (url: string) => void
    let discoveries = 0
    const harness = createHarness(() => {
      discoveries++
      return discoveries === 1
        ? new Promise<string>((resolve) => { finishDiscovery = resolve })
        : 'ws://localhost:8080/app/new-key'
    })
    const first = harness.connection.connect()
    const rejected = expect(first).rejects.toThrow('Connection unavailable')
    harness.connection.disconnect()
    await rejected
    const second = harness.connection.connect()
    const current = BrowserSocketAdapter.sockets[0]!
    current.emit('open')
    await second
    finishDiscovery('ws://localhost:8080/app/old-key')
    await Promise.resolve()
    expect(BrowserSocketAdapter.sockets).toHaveLength(1)
    expect(harness.connection.socket).toBe(current)
    expect(harness.errors).toEqual([])
    harness.connection.disconnect()
  })

  it('retries failed discovery and preserves its error for every connecting caller', async () => {
    let discoveries = 0
    const harness = createHarness(async () => {
      if (++discoveries === 1) throw new Error('Config unavailable')
      return 'ws://localhost:8080/app/key'
    })
    const first = harness.connection.connect()
    const second = harness.connection.connect()
    await Promise.all([
      expect(first).rejects.toThrow('Config unavailable'),
      expect(second).rejects.toThrow('Config unavailable'),
    ])
    expect(harness.errors).toEqual([])
    const retry = harness.connection.connect()
    await Promise.resolve()
    BrowserSocketAdapter.sockets[0]!.emit('open')
    await retry
    harness.connection.disconnect()
  })

  it('reconnects an established connection after it drops and reports each reopening', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const first = harness.connection.connect()
    BrowserSocketAdapter.sockets[0]!.emit('open')
    await first
    BrowserSocketAdapter.sockets[0]!.emit('close')
    expect(harness.errors).toHaveLength(1)
    expect(harness.connection.socket).toBeUndefined()
    expect(harness.connection.reconnecting).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(BrowserSocketAdapter.sockets).toHaveLength(2)
    BrowserSocketAdapter.sockets[1]!.emit('open')
    expect(harness.opens).toBe(2)
    expect(harness.connection.reconnecting).toBe(false)
    expect(harness.connection.socket).toBe(BrowserSocketAdapter.sockets[1])
    BrowserSocketAdapter.sockets[1]!.emit('message', 'resumed')
    expect(harness.messages).toEqual(['resumed'])
    harness.connection.disconnect()
  })

  it('keeps retrying a dropped connection with bounded backoff until it reopens', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const first = harness.connection.connect()
    BrowserSocketAdapter.sockets[0]!.emit('open')
    await first
    BrowserSocketAdapter.sockets[0]!.emit('close')

    for (let attempt = 1; attempt <= 8; attempt++) {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(BrowserSocketAdapter.sockets).toHaveLength(attempt + 1)
      BrowserSocketAdapter.sockets[attempt]!.emit('error')
    }

    await vi.advanceTimersByTimeAsync(30_000)
    BrowserSocketAdapter.sockets.at(-1)!.emit('open')
    expect(harness.opens).toBe(2)
    expect(harness.connection.reconnecting).toBe(false)
    harness.connection.disconnect()
  })

  it('grows the reconnect delay across open-then-close cycles that never stay open', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const harness = createHarness()
    const first = harness.connection.connect()
    BrowserSocketAdapter.sockets[0]!.emit('open')
    await first
    BrowserSocketAdapter.sockets[0]!.emit('close')

    const delays = [250, 500, 1000, 2000, 4000, 8000, 15_000, 15_000]
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(BrowserSocketAdapter.sockets).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      const socket = BrowserSocketAdapter.sockets[index + 1]!
      socket.emit('open')
      socket.emit('close')
    }
    harness.connection.disconnect()
  })

  it('resets the reconnect delay once a reopened connection stays open for the stability window', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const harness = createHarness()
    const first = harness.connection.connect()
    BrowserSocketAdapter.sockets[0]!.emit('open')
    await first
    BrowserSocketAdapter.sockets[0]!.emit('close')
    await vi.advanceTimersByTimeAsync(250)
    BrowserSocketAdapter.sockets[1]!.emit('open')
    BrowserSocketAdapter.sockets[1]!.emit('close')
    await vi.advanceTimersByTimeAsync(500)
    BrowserSocketAdapter.sockets[2]!.emit('open')

    await vi.advanceTimersByTimeAsync(5_000)
    BrowserSocketAdapter.sockets[2]!.emit('close')
    await vi.advanceTimersByTimeAsync(249)
    expect(BrowserSocketAdapter.sockets).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(BrowserSocketAdapter.sockets).toHaveLength(4)
    harness.connection.disconnect()
  })

  it('stops reconnecting once the caller disconnects', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const first = harness.connection.connect()
    BrowserSocketAdapter.sockets[0]!.emit('open')
    await first
    BrowserSocketAdapter.sockets[0]!.emit('close')
    harness.connection.disconnect()
    expect(harness.connection.reconnecting).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(BrowserSocketAdapter.sockets).toHaveLength(1)
  })

  it('does not reconnect a connection that never opened', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const first = harness.connection.connect()
    const rejected = expect(first).rejects.toThrow('Connection unavailable')
    BrowserSocketAdapter.sockets[0]!.emit('error')
    await rejected

    await vi.advanceTimersByTimeAsync(60_000)
    expect(BrowserSocketAdapter.sockets).toHaveLength(1)
    expect(harness.connection.reconnecting).toBe(false)
  })

  it('opens immediately when a caller connects during a backoff wait and does not open a duplicate', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const first = harness.connection.connect()
    BrowserSocketAdapter.sockets[0]!.emit('open')
    await first
    BrowserSocketAdapter.sockets[0]!.emit('close')

    const manual = harness.connection.connect()
    expect(BrowserSocketAdapter.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(BrowserSocketAdapter.sockets).toHaveLength(2)
    BrowserSocketAdapter.sockets[1]!.emit('open')
    await manual
    expect(harness.connection.socket).toBe(BrowserSocketAdapter.sockets[1])
    harness.connection.disconnect()
  })
})
