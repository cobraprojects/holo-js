import type { H3Event } from 'h3'
import { createError, getHeaders, getRequestHeader, getRequestURL } from '#imports'
import { HoloRequestBodyTooLargeError, readBoundedBufferedBody, readBoundedNodeRequestBody, requestBodyLimitFor, type BufferedRequestBody } from '@holo-js/kernel'

async function readBoundedEventBody(event: H3Event): Promise<BufferedRequestBody> {
  const limit = requestBodyLimitFor(getRequestHeader(event, 'content-type'))
  try {
    const node = event.node.req as unknown as Record<PropertyKey, unknown>
    const buffered = await readBoundedBufferedBody(
      event._requestBody || event.web?.request?.body || node[Symbol.for('h3RawBody')] || node.rawBody || node.body,
      limit,
    )
    if (buffered) return buffered
    const bytes = await readBoundedNodeRequestBody(event.node.req, limit, getRequestHeader(event, 'content-length'))
    event._requestBody = bytes
    Object.assign(event.node.req, { [Symbol.for('h3RawBody')]: bytes })
    return { bytes }
  } catch (error) {
    if (error instanceof HoloRequestBodyTooLargeError) {
      throw createError({ statusCode: error.status, statusMessage: 'Payload Too Large', cause: error })
    }

    throw error
  }
}

export async function createWebRequest(event: H3Event): Promise<Request> {
  const buffered = await readBoundedEventBody(event)
  const headers = new Headers()
  for (const [key, value] of Object.entries(getHeaders(event))) {
    if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  if (buffered.contentType) {
    headers.set('content-type', buffered.contentType)
  }

  return new Request(getRequestURL(event, { xForwardedProto: false }), {
    body: buffered.bytes,
    headers,
    method: event.method,
  })
}
