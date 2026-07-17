import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BroadcastJsonObject } from './contracts'
import { isPlainObject, parseJsonObject } from './json'

export type WorkerPublishBody = {
  readonly name: string
  readonly channels: readonly string[]
  readonly data: string
  readonly socket_id?: string
}

export function normalizeWorkerRequiredString(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/broadcast] ${label} must be a non-empty string.`)
  }

  return normalized
}

export function parseWorkerSocketMessage(rawMessage: string): {
  readonly event: string
  readonly channel?: string
  readonly data: Record<string, unknown>
} {
  const message = parseJsonObject(rawMessage, 'Websocket message')
  const event = normalizeWorkerRequiredString(String(message.event ?? ''), 'Websocket event')
  const channel = typeof message.channel === 'string'
    ? normalizeWorkerRequiredString(message.channel, 'Websocket channel')
    : undefined
  const data = typeof message.data === 'string'
    ? parseJsonObject(message.data, 'Websocket message data')
    : (isPlainObject(message.data) ? message.data : {})

  return Object.freeze({
    event,
    ...(typeof channel === 'undefined' ? {} : { channel }),
    data,
  })
}

export function normalizeWorkerPublishBody(value: unknown): WorkerPublishBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[@holo-js/broadcast] Publish payload must be a JSON object.')
  }

  const body = value as Record<string, unknown>
  const name = typeof body.name === 'string'
    ? normalizeWorkerRequiredString(body.name, 'Publish name')
    : typeof body.event === 'string'
      ? normalizeWorkerRequiredString(body.event, 'Publish event')
      : ''

  if (!name) {
    throw new Error('[@holo-js/broadcast] Publish payload must include an event name.')
  }

  const channels = Array.isArray(body.channels)
    ? body.channels.map((channel) => {
        if (typeof channel !== 'string') {
          throw new Error('[@holo-js/broadcast] Publish channel must be a non-empty string.')
        }

        return normalizeWorkerRequiredString(channel, 'Publish channel')
      })
    : typeof body.channel === 'string'
      ? [normalizeWorkerRequiredString(body.channel, 'Publish channel')]
      : []

  if (channels.length === 0) {
    throw new Error('[@holo-js/broadcast] Publish payload must include at least one channel.')
  }

  const data = typeof body.data === 'string'
    ? body.data
    : JSON.stringify((body.data ?? {}) as BroadcastJsonObject)
  const socketId = typeof body.socket_id === 'string'
    ? normalizeWorkerRequiredString(body.socket_id, 'Publish socket_id')
    : undefined

  return Object.freeze({
    name,
    channels: Object.freeze(channels),
    data,
    ...(typeof socketId === 'undefined' ? {} : { socket_id: socketId }),
  })
}

export function createWorkerPusherSignature(
  secret: string,
  method: string,
  pathname: string,
  params: URLSearchParams,
): string {
  const sorted = [...params.entries()]
    .filter(([key]) => key !== 'auth_signature')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const payload = `${method.toUpperCase()}\n${pathname}\n${sorted}`
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function verifyWorkerPusherSignature(providedSignature: string, expectedSignature: string): boolean {
  if (
    providedSignature.length !== expectedSignature.length
    || !/^[a-f0-9]+$/i.test(providedSignature)
    || !/^[a-f0-9]+$/i.test(expectedSignature)
  ) {
    return false
  }

  return timingSafeEqual(Buffer.from(providedSignature, 'hex'), Buffer.from(expectedSignature, 'hex'))
}

export function parseWorkerChannelKind(channel: string): {
  readonly kind: 'public' | 'private' | 'presence'
  readonly canonical: string
} {
  if (channel.startsWith('private-')) {
    return Object.freeze({
      kind: 'private',
      canonical: channel.slice('private-'.length),
    })
  }

  if (channel.startsWith('presence-')) {
    return Object.freeze({
      kind: 'presence',
      canonical: channel.slice('presence-'.length),
    })
  }

  return Object.freeze({
    kind: 'public',
    canonical: channel,
  })
}
