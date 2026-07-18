import { getHeaders, getRequestURL, readRawBody, type H3Event } from 'h3'

export async function createRealtimeRequest(event: H3Event): Promise<Request> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(getHeaders(event))) {
    if (typeof value === 'string') {
      headers.set(key, value)
    }
  }

  return new Request(getRequestURL(event), {
    body: await readRawBody(event),
    headers,
    method: event.method,
  })
}
