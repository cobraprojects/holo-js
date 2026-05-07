import { getHeaders, getRequestURL, type H3Event } from 'h3'

export function toWebRequest(event: H3Event): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(getHeaders(event))) {
    if (typeof value === 'string') {
      headers.set(key, value)
    }
  }

  return new Request(getRequestURL(event), {
    method: event.method,
    headers,
  })
}
