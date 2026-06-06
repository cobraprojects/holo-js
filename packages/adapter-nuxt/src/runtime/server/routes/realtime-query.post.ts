import { defineEventHandler, getHeaders, getRequestURL, readRawBody, type H3Event } from 'h3'
import { handleRealtimeQueryRequest } from '@holo-js/realtime/server'

async function resolveRequest(event: H3Event): Promise<Request> {
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

export default defineEventHandler(async (event) => {
  return await handleRealtimeQueryRequest(await resolveRequest(event), {
    projectRoot: useRuntimeConfig().holo.projectRoot ?? process.cwd(),
  })
})
