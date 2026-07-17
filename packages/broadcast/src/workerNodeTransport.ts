import type { IncomingMessage, ServerResponse } from 'node:http'

export class BroadcastPayloadTooLargeError extends Error {}

export async function readLimitedRequestText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new BroadcastPayloadTooLargeError()
  }
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new BroadcastPayloadTooLargeError()
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export function toNodeHeaders(headers: IncomingMessage['headers']): Headers {
  const normalized = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') continue
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(key, item)
    } else {
      normalized.set(key, value)
    }
  }
  return normalized
}

export function toNodeRequestUrl(request: IncomingMessage, fallbackHost: string): string {
  const path = request.url ?? '/'
  const host = request.headers.host ?? fallbackHost
  return `http://${host}${path}`
}

export async function readNodeRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maxBytes) throw new BroadcastPayloadTooLargeError()
    chunks.push(buffer)
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

export function writeNodeRequestBodyError(response: ServerResponse, error: unknown): void {
  if (error instanceof BroadcastPayloadTooLargeError) {
    response.statusCode = 413
    response.end('Payload Too Large')
    return
  }
  response.statusCode = 500
  response.end('Internal Server Error')
}

export async function writeNodeResponse(response: ServerResponse, value: Response): Promise<void> {
  response.statusCode = value.status
  response.statusMessage = value.statusText
  value.headers.forEach((headerValue, headerName) => response.setHeader(headerName, headerValue))
  response.end(Buffer.from(await value.arrayBuffer()))
}

export function decodeNodeWebSocketMessage(
  message: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer,
): string {
  if (typeof message === 'string') return message
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(message))
  if (Array.isArray(message)) return Buffer.concat(message).toString('utf8')
  if (message instanceof Uint8Array) return Buffer.from(message).toString('utf8')
  return String(message)
}

export function getNodeWebSocketMessageBytes(
  message: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer,
): number {
  if (typeof message === 'string') return Buffer.byteLength(message)
  if (message instanceof ArrayBuffer || message instanceof Uint8Array) return message.byteLength
  return message.reduce((size, chunk) => size + chunk.byteLength, 0)
}
