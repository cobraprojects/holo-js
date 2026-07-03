import { getRealtimeClientState } from './state'
import {
  missingTransportMessage,
  unavailableTransportMessage,
  type RealtimeClientErrorKind,
  type RealtimeClientErrorOptions,
  type RealtimeWireError,
} from './types'

export class RealtimeClientError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly kind: RealtimeClientErrorKind

  constructor(message: string, options: RealtimeClientErrorOptions = {}) {
    super(message)
    this.name = options.name ?? 'RealtimeClientError'
    this.status = options.status
    this.code = options.code
    this.kind = options.kind ?? 'runtime'
  }
}

export class RealtimeAuthorizationError extends RealtimeClientError {
  constructor(message: string, options: Omit<RealtimeClientErrorOptions, 'kind'> = {}) {
    super(message, {
      ...options,
      name: options.name ?? 'RealtimeAuthorizationError',
      kind: 'authorization',
    })
  }
}

export function warnRealtimeOnce(message: string): void {
  const state = getRealtimeClientState()
  if (state.warnedMessages.has(message)) {
    return
  }

  state.warnedMessages.add(message)
  console.warn(`[@holo-js/realtime] ${message}`)
}

export function handleRealtimeError(error: unknown): void {
  warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
  getRealtimeClientState().framework?.handleError?.(error)
}

export function isRealtimeTransportAvailabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message === missingTransportMessage
    || error.message === unavailableTransportMessage
    || error.message === 'Realtime live updates require fetch support in this runtime.'
    || error.message === 'Realtime live updates require WebSocket support in this runtime.'
    || error.message === 'Realtime broadcast config response is invalid.'
    || error.message.startsWith('Realtime broadcast config failed with HTTP ')
}

export function handleRealtimeConnectionError(error: unknown): void {
  if (error instanceof Error && isRealtimeTransportAvailabilityError(error)) {
    warnRealtimeOnce(error.message)
    return
  }

  handleRealtimeError(error)
}

function normalizeRealtimeErrorKind(value: unknown): RealtimeClientErrorKind | undefined {
  if (value === 'authorization' || value === 'transport' || value === 'runtime') {
    return value
  }

  return undefined
}

function normalizeRealtimeErrorStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
    return value
  }

  return undefined
}

function parseWireError(data: Record<string, unknown>): RealtimeWireError {
  const status = normalizeRealtimeErrorStatus(data.status)
  const kind = normalizeRealtimeErrorKind(data.kind)

  return {
    message: typeof data.message === 'string' ? data.message : unavailableTransportMessage,
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    ...(typeof data.code === 'string' ? { code: data.code } : {}),
    ...(typeof status === 'undefined' ? {} : { status }),
    ...(typeof kind === 'undefined' ? {} : { kind }),
  }
}

export function createWireError(data: Record<string, unknown>): RealtimeClientError {
  const error = parseWireError(data)
  if (error.kind === 'authorization') {
    return new RealtimeAuthorizationError(error.message, error)
  }

  return new RealtimeClientError(error.message, error)
}
