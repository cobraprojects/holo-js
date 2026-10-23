import type { H3Event } from 'h3'
import { createError, getHeaders, getRequestHeader, getRequestURL } from '#imports'
import { HoloRequestBodyTooLargeError, readBoundedCachedBody, readBoundedNodeRequestBody, requestBodyLimitFor } from '@holo-js/kernel'

async function readBoundedEventBody(event: H3Event): Promise<Uint8Array> {
  const limit = requestBodyLimitFor(getRequestHeader(event, 'content-type'))
  const cached = await readBoundedCachedBody((event.node.req as unknown as Record<symbol, unknown>)[Symbol.for('h3RawBody')] ?? event._requestBody, limit)
  if (cached) return cached
  try {
    return await readBoundedNodeRequestBody(event.node.req, limit, getRequestHeader(event, 'content-length'))
  } catch (error) {
    if (error instanceof HoloRequestBodyTooLargeError) {
      throw createError({ statusCode: error.status, statusMessage: 'Payload Too Large', cause: error })
    }

    throw error
  }
}

export async function createWebRequest(event: H3Event): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(getHeaders(event))) {
    if (typeof value === 'string') {
      headers.set(key, value)
    }
  }

  return new Request(getRequestURL(event, { xForwardedProto: false }), {
    body: await readBoundedEventBody(event),
    headers,
    method: event.method,
  })
}
