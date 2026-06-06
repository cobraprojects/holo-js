import { defineEventHandler, getHeaders, getRequestURL, type H3Event } from 'h3'
import { handleRealtimeStreamRequest } from '@holo-js/realtime/server'

function resolveRequest(event: H3Event): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(getHeaders(event))) {
    if (typeof value === 'string') {
      headers.set(key, value)
    }
  }

  return new Request(getRequestURL(event), {
    headers,
    method: event.method,
  })
}

export default defineEventHandler(async (event) => {
  return await handleRealtimeStreamRequest(resolveRequest(event), {
    projectRoot: useRuntimeConfig().holo.projectRoot ?? process.cwd(),
  })
})
